import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import SaheliMessage from "../models/saheliMessage.model";
import SaheliOutreachLog from "../models/saheliOutreachLog.model";
import {
    companionProfilePayload,
    dueOutreachSlot,
    getCompanionProfile,
    isWithinQuietHours,
    localDateParts,
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
import { getISTParts } from "../utils/istTime.util";
import { deliverOutboundMessage, resolveRecipientChannel } from "./channelOutbound.service";
import { getFamilyMembersList } from "./familyMember.service";
import { scheduleAppliesToday } from "./saheli.service";
import type { OutreachSlot } from "../models/saheliCompanion.model";
import { getScheduleDayStatuses } from "./careScheduleCompletion.service";
import { formatScheduleSection } from "./saheliContext.service";
import { isAiEngineOfflineError } from "../clients/aiEngine.client";

function resolveRecipientName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
): string {
    const found = members.find((m) => m.userId === recipientUserId);
    return found?.name?.trim() || "Care recipient";
}

async function getTodayScheduleItems(familyId: string, recipientUserId: string) {
    const today = getISTParts().dayOfWeek;
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
    outreachSlot?: OutreachSlot;
    outreachKind?: "casual" | "care" | "mixed" | "memory";
    topicBucket?: string;
    topicHint?: string;
    force?: boolean;
}): Promise<{ reply: string; delivered: boolean; topicBucket?: string } | null> {
    const companion = await getCompanionProfile(payload.familyId, payload.recipientUserId);
    if (!companion.enabled && !payload.force) return null;
    if (isWithinQuietHours(companion) && !payload.force) return null;

    const slot = payload.slot ?? payload.outreachSlot ?? dueOutreachSlot(companion);
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

    if (payload.force && (slot === "random" || slot === "memory")) {
        const existing = await SaheliOutreachLog.findOne({
            familyId: payload.familyId,
            recipientUserId: payload.recipientUserId,
            slotDate: dateKey,
            slot,
        }).lean();
        if (existing) return null;
    }

    {
        // Gate #1 (before spending on generation): quiet ≥60 min and no active job/flow.
        const { canSendProactiveNudge } = await import("./saheliNudgeGate.service");
        const gate = await canSendProactiveNudge({ familyId: payload.familyId, recipientUserId: payload.recipientUserId });
        if (!gate.ok) {
            console.log(`Saheli outreach skipped (${gate.reason}) for ${payload.recipientUserId}`);
            return null;
        }
    }
    const membersPayload = await getFamilyMembersList(payload.familyId, payload.recipientUserId);
    const displayName = resolveRecipientName(membersPayload.members, payload.recipientUserId);
    const ctx = await ensureAiContext(payload.familyId, payload.recipientUserId, displayName);
    const careContext = await getCareRecordContextForSaheli(payload.familyId, payload.recipientUserId, 25);
    const profile = companionProfilePayload(companion);

    const todayItems = await getTodayScheduleItems(payload.familyId, payload.recipientUserId);
    const hasCareToday = todayItems.some((s) => s.type === "MEDICINE" || s.type === "CHECK_IN");
    const dayStatus = await getScheduleDayStatuses(
        payload.familyId,
        payload.recipientUserId,
        payload.recipientUserId,
    );

    let outreachKind = payload.outreachKind ?? "casual";
    if (!payload.outreachKind && slot === "morning" && hasCareToday) {
        outreachKind = "mixed";
    }
    let reply = "";
    let topicBucket =
        payload.topicBucket ??
        (outreachKind === "memory" ? "memory_recall" : slot === "morning" && hasCareToday ? "care" : "casual");
    const todayDate = localDateParts(companion.timezone || "Asia/Kolkata").date;
    const mmdd = todayDate.slice(5);
    const specialDate =
        companion.birthday?.slice(5) === mmdd
            ? "birthday"
            : companion.importantDates?.find((d) => d.date.slice(5) === mmdd)?.label;

    let topicHint: string | undefined = payload.topicHint
        ? payload.topicHint
        : specialDate
          ? `special_day:${specialDate}`
          : companion.outreachTopics?.length && companion.outreachTopics.length > 0
            ? companion.outreachTopics[Math.floor(Math.random() * companion.outreachTopics.length)]
            : undefined;

    let memoryHint: string | undefined;
    if (outreachKind === "memory" || topicBucket === "memory_recall" || topicHint === "memories") {
        try {
            const { aiGrepMemory } = await import("../clients/aiEngine.client");
            const grep = await aiGrepMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                query: "family person hobby food mood medicine memories",
                limit: 3,
            });
            const hit = grep.hits[Math.floor(Math.random() * Math.max(grep.hits.length, 1))];
            if (hit) {
                memoryHint = `${hit.title}: ${hit.snippet}`;
                topicBucket = "memory_recall";
                topicHint = hit.title;
            }
        } catch {
            memoryHint = undefined;
        }
    }

    try {
        const result = await aiPostOutreach({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            conversationId: ctx.conversationId,
            outreachKind,
            topicBucket,
            topicHint,
            memoryHint,
            careRecordContext: careContext,
            companionProfile: profile,
            outreachTopics: companion.outreachTopics ?? [],
            scheduleItems:
                outreachKind !== "casual" && outreachKind !== "memory"
                    ? todayItems.map((s) => ({
                          title: s.title,
                          time: s.time,
                          dosage: s.dosage,
                          type: s.type,
                      }))
                    : [],
        });

        if (result.conversation_id) {
            await persistConversationId(
                payload.familyId,
                payload.recipientUserId,
                result.conversation_id,
            );
        }
        reply = result.reply.trim();
        topicBucket = result.topic_bucket ?? topicBucket;
        topicHint = result.topic_hint;
    } catch (err) {
        if (!isAiEngineOfflineError(err) && slot !== "morning") throw err;
        const missed = dayStatus.items.filter((i) => i.status === "missed");
        const upcoming = dayStatus.items.filter((i) => i.status === "upcoming");
        const lang = companion.preferredLanguage ?? "english";
        const hindi = lang === "hindi" || lang === "hinglish";
        const parts = hindi
            ? [`Suprabhat ${displayName}!`]
            : [`Good morning, ${displayName}!`];
        if (missed.length) {
            parts.push(
                formatScheduleSection(
                    missed,
                    hindi ? "Aaj abhi tak miss hua" : "Missed so far today",
                ),
            );
        }
        if (upcoming.length) {
            parts.push(
                formatScheduleSection(
                    upcoming.slice(0, 5),
                    hindi ? "Aaj aage" : "Coming up today",
                ),
            );
        }
        if (parts.length === 1) {
            parts.push(
                hindi
                    ? "Umeed hai aapka din accha shuru ho raha hai."
                    : "Hope you're having a gentle start to the day.",
            );
        }
        reply = parts.join("\n\n");
        topicBucket = "care";
    }

    if (!reply) return null;

    const channelTarget = await resolveRecipientChannel(
        payload.familyId,
        payload.recipientUserId,
        companion.preferredChannel,
    );

    await recordProactiveMessages(
        payload.familyId,
        payload.recipientUserId,
        `Saheli reached out · ${topicBucket}`,
        reply,
    );

    await appendCareRecordEvent({
        familyId: payload.familyId,
        subjectUserId: payload.recipientUserId,
        type: CareRecordEventType.CHECK_IN,
        source: CareRecordSource.SAHELI,
        channel: channelTarget?.channel === "whatsapp" ? ChannelType.WHATSAPP : ChannelType.DASHBOARD,
        title: "Saheli reached out",
        detail: reply.slice(0, 280),
        status: "sent",
        payload: {
            outreachKind,
            topicBucket,
            topicHint,
            slot,
        },
        skipSignalCheck: true,
    });

    let delivered = true;
    if (channelTarget && channelTarget.channel !== "dashboard") {
        // Gate #2: re-check right before sending (an order may have started during generation).
        const { canSendProactiveNudge } = await import("./saheliNudgeGate.service");
        const gate = await canSendProactiveNudge({ familyId: payload.familyId, recipientUserId: payload.recipientUserId });
        if (!gate.ok) {
            console.log(`Saheli outreach dropped at send (${gate.reason}) for ${payload.recipientUserId}`);
            return null;
        }
        const delivery = await deliverOutboundMessage({
            familyId: payload.familyId,
            recipientUserId: payload.recipientUserId,
            content: reply,
            channel: channelTarget.channel,
            channelIdentifier: channelTarget.channelIdentifier,
        });
        delivered = delivery.delivered;
        if (delivered) {
            const { logActivity } = await import("./activityLog.service");
            void logActivity({
                familyId: payload.familyId,
                recipientUserId: payload.recipientUserId,
                kind: "nudge",
                title: "Saheli check-in",
                detail: reply,
                data: {
                    source: "outreach",
                    outreachKind,
                    slot: slot ?? null,
                    topicBucket: topicBucket ?? null,
                    channel: channelTarget.channel,
                },
            });
        }
    }

    if (slot) {
        await SaheliOutreachLog.create({
            logId: newOutreachLogId(),
            familyId: payload.familyId,
            recipientUserId: payload.recipientUserId,
            slot,
            slotDate: dateKey,
            outreachKind,
            topicBucket,
            topicHint,
            channel: channelTarget?.channel ?? "dashboard",
            delivered,
        }).catch(() => undefined);
    }

    await markCompanionOutreach(payload.familyId, payload.recipientUserId);
    return { reply, delivered, topicBucket };
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
