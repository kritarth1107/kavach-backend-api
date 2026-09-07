import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import SaheliMessage from "../models/saheliMessage.model";
import SaheliOutreachLog from "../models/saheliOutreachLog.model";
import {
    companionProfilePayload,
    dueOutreachSlot,
    getCompanionProfile,
    markCompanionOutreach,
    newOutreachLogId,
    slotDateKey,
} from "./saheliCompanion.service";
import { ensureAiContext, persistConversationId } from "./aiTenant.service";
import { aiPostFamilyShare, aiPostOutreach } from "../clients/aiEngine.client";
import { getCareRecordContextForSaheli, appendCareRecordEvent } from "./careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { deliverOutboundMessage, resolveRecipientChannel } from "./channelOutbound.service";
import { getFamilyMembersList } from "./familyMember.service";
import { scheduleAppliesToday } from "./saheli.service";
import type { OutreachSlot } from "../models/saheliCompanion.model";

function resolveRecipientName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
): string {
    const found = members.find((m) => m.userId === recipientUserId);
    return found?.name?.trim() || "Care recipient";
}

async function getTodayScheduleItems(familyId: string, recipientUserId: string) {
    const today = new Date().getDay();
    const schedules = await CareSchedule.find({
        familyId,
        recipientUserId,
        active: true,
    }).lean();
    return schedules.filter((s) => scheduleAppliesToday(s.daysOfWeek ?? [], today));
}

async function recordProactiveMessages(
    familyId: string,
    recipientUserId: string,
    systemNote: string,
    reply: string,
) {
    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread: "elder",
        role: "system",
        content: systemNote,
    });
    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread: "elder",
        role: "saheli",
        content: reply,
    });
}

export async function deliverSaheliOutreach(payload: {
    familyId: string;
    recipientUserId: string;
    slot?: OutreachSlot;
    outreachKind?: "casual" | "care" | "mixed";
    force?: boolean;
}): Promise<{ reply: string; delivered: boolean; topicBucket?: string } | null> {
    const companion = await getCompanionProfile(payload.familyId, payload.recipientUserId);
    if (!companion.enabled && !payload.force) return null;

    const slot = payload.slot ?? dueOutreachSlot(companion);
    if (!slot && !payload.force) return null;

    const timezone = companion.timezone || "Asia/Kolkata";
    const dateKey = slotDateKey(timezone);

    if (slot && !payload.force) {
        const existing = await SaheliOutreachLog.findOne({
            familyId: payload.familyId,
            recipientUserId: payload.recipientUserId,
            slotDate: dateKey,
            slot,
        }).lean();
        if (existing) return null;
    }

    const membersPayload = await getFamilyMembersList(payload.familyId, payload.recipientUserId);
    const displayName = resolveRecipientName(membersPayload.members, payload.recipientUserId);
    const ctx = await ensureAiContext(payload.familyId, payload.recipientUserId, displayName);
    const careContext = await getCareRecordContextForSaheli(payload.familyId, payload.recipientUserId, 25);
    const profile = companionProfilePayload(companion);

    const todayItems = await getTodayScheduleItems(payload.familyId, payload.recipientUserId);
    const hasCareToday = todayItems.some((s) => s.type === "MEDICINE" || s.type === "CHECK_IN");

    let outreachKind = payload.outreachKind ?? "casual";
    if (!payload.outreachKind && slot === "morning" && hasCareToday) {
        outreachKind = "mixed";
    }

    const result = await aiPostOutreach({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        conversationId: ctx.conversationId,
        outreachKind,
        careRecordContext: careContext,
        companionProfile: profile,
        scheduleItems:
            outreachKind !== "casual"
                ? todayItems.map((s) => ({
                      title: s.title,
                      time: s.time,
                      dosage: s.dosage,
                      type: s.type,
                  }))
                : [],
    });

    if (result.conversation_id) {
        await persistConversationId(payload.familyId, payload.recipientUserId, result.conversation_id);
    }

    const reply = result.reply.trim();
    if (!reply) return null;

    await recordProactiveMessages(
        payload.familyId,
        payload.recipientUserId,
        `Saheli reached out · ${result.topic_bucket ?? "casual"}`,
        reply,
    );

    await appendCareRecordEvent({
        familyId: payload.familyId,
        subjectUserId: payload.recipientUserId,
        type: CareRecordEventType.CHECK_IN,
        source: CareRecordSource.SAHELI,
        channel: ChannelType.DASHBOARD,
        title: "Saheli reached out",
        detail: reply.slice(0, 280),
        status: "sent",
        payload: {
            outreachKind,
            topicBucket: result.topic_bucket,
            topicHint: result.topic_hint,
            slot,
        },
        skipSignalCheck: true,
    });

    const channelTarget = await resolveRecipientChannel(
        payload.familyId,
        payload.recipientUserId,
        companion.preferredChannel,
    );

    let delivered = true;
    if (channelTarget && channelTarget.channel !== "dashboard") {
        const delivery = await deliverOutboundMessage({
            familyId: payload.familyId,
            recipientUserId: payload.recipientUserId,
            content: reply,
            channel: channelTarget.channel,
            channelIdentifier: channelTarget.channelIdentifier,
        });
        delivered = delivery.delivered;
    }

    if (slot) {
        await SaheliOutreachLog.create({
            logId: newOutreachLogId(),
            familyId: payload.familyId,
            recipientUserId: payload.recipientUserId,
            slot,
            slotDate: dateKey,
            outreachKind,
            topicBucket: result.topic_bucket,
            topicHint: result.topic_hint,
            channel: channelTarget?.channel ?? "dashboard",
            delivered,
        });
    }

    await markCompanionOutreach(payload.familyId, payload.recipientUserId);
    return { reply, delivered, topicBucket: result.topic_bucket };
}

export async function shareElderUpdateWithFamily(payload: {
    familyId: string;
    recipientUserId: string;
    shareSummary: string;
}) {
    const companion = await getCompanionProfile(payload.familyId, payload.recipientUserId);
    if (!companion.shareWithFamily) return null;

    const membersPayload = await getFamilyMembersList(payload.familyId, payload.recipientUserId);
    const displayName = resolveRecipientName(membersPayload.members, payload.recipientUserId);
    const ctx = await ensureAiContext(payload.familyId, payload.recipientUserId, displayName);

    const shareReply = await aiPostFamilyShare({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        shareSummary: payload.shareSummary,
    });

    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId: payload.familyId,
        recipientUserId: payload.recipientUserId,
        thread: "caregiver",
        role: "system",
        content: `Update from ${displayName}'s conversation`,
    });
    await SaheliMessage.create({
        messageId: randomUUID(),
        familyId: payload.familyId,
        recipientUserId: payload.recipientUserId,
        thread: "caregiver",
        role: "saheli",
        content: shareReply.reply,
    });

    await appendCareRecordEvent({
        familyId: payload.familyId,
        subjectUserId: payload.recipientUserId,
        type: CareRecordEventType.MESSAGE,
        source: CareRecordSource.SAHELI,
        channel: ChannelType.DASHBOARD,
        title: "Family update",
        detail: shareReply.reply.slice(0, 280),
        status: "reported",
        skipSignalCheck: true,
    });

    return shareReply.reply;
}

export async function listFamilyMemoriesForRecipient(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const { aiListFamilyMemories } = await import("../clients/aiEngine.client");
    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
    return aiListFamilyMemories({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
    });
}
