import CareSchedule from "../models/careSchedule.model";
import Family from "../models/family.model";
import { AppError } from "../middleware/error.middleware";
import { aiGetChatHistory } from "../clients/aiEngine.client";
import { CareScheduleType } from "../types/careSchedule.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { ensureAiContext, persistConversationId, persistCaregiverConversationId } from "./aiTenant.service";
import { getFamilyMembersList } from "./familyMember.service";
import { aiGetCaregiverChatHistory, aiPostCaregiverChat, aiPostChat, aiPostCheckIn } from "../clients/aiEngine.client";

async function getFamilyAndRecipientLocal(familyId: string, recipientUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new AppError("Family not found", 404);

    const member = family.members.find((m) => m.userId === recipientUserId);
    if (!member || member.status !== FamilyMemberStatus.JOINED) {
        throw new AppError("Care recipient not found", 404);
    }
    if (member.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Member is not a care recipient", 400);
    }
    return family;
}

function resolveRecipientName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
): string {
    const found = members.find((m) => m.userId === recipientUserId);
    return found?.name?.trim() || "Care recipient";
}

export async function sendSaheliMessage(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    message: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);

    const result = await aiPostChat({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        message: message.trim(),
        conversationId: ctx.conversationId,
    });

    await persistConversationId(familyId, recipientUserId, result.conversation_id);

    return {
        reply: result.reply,
        conversationId: result.conversation_id,
    };
}

export async function getSaheliHistory(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    limit = 50,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);

    const history = await aiGetChatHistory({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        limit,
    });

    if (history.conversation_id) {
        await persistConversationId(familyId, recipientUserId, history.conversation_id);
    }

    return {
        conversationId: history.conversation_id,
        messages: history.messages.map((m) => ({
            role: m.role,
            content: m.content,
            createdAt: m.created_at ?? null,
        })),
    };
}

export async function sendCaregiverSaheliMessage(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    message: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role === FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Care recipients use their own Saheli thread", 400);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);

    const result = await aiPostCaregiverChat({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        message: message.trim(),
        conversationId: ctx.caregiverConversationId,
    });

    await persistCaregiverConversationId(
        familyId,
        recipientUserId,
        result.conversation_id,
    );

    return {
        reply: result.reply,
        conversationId: result.conversation_id,
    };
}

export async function getCaregiverSaheliHistory(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    limit = 50,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role === FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Care recipients use their own Saheli thread", 400);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);

    const history = await aiGetCaregiverChatHistory({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        limit,
    });

    if (history.conversation_id) {
        await persistCaregiverConversationId(
            familyId,
            recipientUserId,
            history.conversation_id,
        );
    }

    return {
        conversationId: history.conversation_id,
        messages: history.messages.map((m) => ({
            role: m.role,
            content: m.content,
            createdAt: m.created_at ?? null,
        })),
    };
}

export async function triggerSaheliCheckIn(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
    const todayItems = await getTodayScheduleItems(familyId, recipientUserId);

    const result = await aiPostCheckIn({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        conversationId: ctx.conversationId,
        scheduleItems: todayItems.map((s) => ({
            title: s.title,
            time: s.time,
            dosage: s.dosage,
            type: s.type,
        })),
    });

    await persistConversationId(familyId, recipientUserId, result.conversation_id);

    return {
        reply: result.reply,
        conversationId: result.conversation_id,
    };
}

function parseTimeToMinutes(time: string): number | null {
    const match = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = Number(match[1]) % 12;
    const minutes = Number(match[2]);
    if (match[3].toUpperCase() === "PM") hours += 12;
    return hours * 60 + minutes;
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

export type BriefingItem = {
    title: string;
    time: string;
    dosage?: string;
    type: string;
};

export async function getRecipientBriefing(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const todayItems = await getTodayScheduleItems(familyId, recipientUserId);

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const unconfirmedItems: BriefingItem[] = todayItems
        .filter((s) => {
            const mins = parseTimeToMinutes(s.time);
            return mins !== null && mins <= nowMinutes;
        })
        .map((s) => ({
            title: s.title,
            time: s.time,
            dosage: s.dosage,
            type: s.type,
        }));

    let lastHeardAt: string | null = null;
    let lastHeardLine: string | null = null;
    let lastCheckInAt: string | null = null;

    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const history = await aiGetChatHistory({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            limit: 80,
        });
        if (history.conversation_id) {
            await persistConversationId(familyId, recipientUserId, history.conversation_id);
        }
        const elderMsgs = history.messages.filter((m) => m.role === "elder");
        const lastElder = elderMsgs[elderMsgs.length - 1];
        if (lastElder) {
            lastHeardLine = lastElder.content;
            lastHeardAt = lastElder.created_at ?? null;
        }
        const checkIns = history.messages.filter((m) => m.role === "system");
        const lastCheckIn = checkIns[checkIns.length - 1];
        if (lastCheckIn) {
            lastCheckInAt = lastCheckIn.created_at ?? null;
        }
    } catch {
        // AI engine optional
    }

    return {
        recipientName: displayName,
        lastHeardAt,
        lastHeardLine,
        lastCheckInAt,
        todayItems: todayItems.map((s) => ({
            title: s.title,
            time: s.time,
            dosage: s.dosage,
            type: s.type,
        })),
        unconfirmedItems,
    };
}

export function scheduleAppliesToday(daysOfWeek: number[], day = new Date().getDay()): boolean {
    if (!daysOfWeek.length) return true;
    return daysOfWeek.includes(day);
}

export type ActivityItem = {
    id: string;
    type: "message" | "schedule" | "check_in";
    title: string;
    detail: string;
    recipientUserId: string;
    recipientName: string;
    at: string;
    status: "completed" | "scheduled" | "reported";
};

export async function getFamilyOverview(familyId: string, actorUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const recipients = membersPayload.members.filter(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
    );

    const today = new Date().getDay();
    let schedulesToday = 0;
    let checkInsToday = 0;
    let messagesToday = 0;
    let lastSaheliReply: string | null = null;
    let lastActivityAt: string | null = null;
    const activity: ActivityItem[] = [];

    for (const recipient of recipients) {
        const recipientName =
            recipient.fullName?.trim() || recipient.name?.trim() || "Care recipient";
        const recipientUserId = recipient.userId;
        if (!recipientUserId) continue;

        const schedules = await CareSchedule.find({
            familyId,
            recipientUserId,
            active: true,
        }).lean();

        for (const s of schedules) {
            if (!scheduleAppliesToday(s.daysOfWeek ?? [], today)) continue;
            schedulesToday += 1;
            if (s.type === CareScheduleType.CHECK_IN) checkInsToday += 1;
            activity.push({
                id: `schedule-${s.scheduleId}`,
                type: s.type === CareScheduleType.CHECK_IN ? "check_in" : "schedule",
                title: s.title,
                detail: `${s.time}${s.dosage ? ` · ${s.dosage}` : ""}`,
                recipientUserId,
                recipientName,
                at: new Date().toISOString(),
                status: "scheduled",
            });
        }

        try {
            const ctx = await ensureAiContext(familyId, recipientUserId, recipientName);
            const history = await aiGetChatHistory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                limit: 20,
            });

            for (const msg of history.messages) {
                activity.push({
                    id: `msg-${recipientUserId}-${activity.length}`,
                    type: "message",
                    title:
                        msg.role === "saheli"
                            ? "Saheli"
                            : msg.role === "system"
                              ? "Check-in"
                              : recipientName,
                    detail: msg.content.slice(0, 120),
                    recipientUserId,
                    recipientName,
                    at: new Date().toISOString(),
                    status: "reported",
                });
                if (msg.role === "saheli") {
                    messagesToday += 1;
                    lastSaheliReply = msg.content;
                }
            }
        } catch {
            // AI engine optional for overview
        }
    }

    activity.sort((a, b) => (a.at < b.at ? 1 : -1));

    return {
        careRecipientCount: recipients.length,
        schedulesToday,
        checkInsToday,
        messagesToday,
        pendingApprovals: 0,
        medAdherencePercent: null as number | null,
        lastSaheliReply,
        lastActivityAt,
        recipients: recipients.map((r) => ({
            userId: r.userId ?? "",
            name: r.fullName?.trim() || r.name?.trim() || "Care recipient",
        })).filter((r) => r.userId),
        recentActivity: activity.slice(0, 50),
    };
}

export async function getFamilyActivityLog(
    familyId: string,
    actorUserId: string,
    limit = 30,
) {
    const overview = await getFamilyOverview(familyId, actorUserId);
    return {
        items: overview.recentActivity.slice(0, limit),
    };
}

/** Fire-and-forget check-in when a CHECK_IN schedule is created. */
export async function maybeTriggerCheckInOnScheduleCreate(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    scheduleType: CareScheduleType,
): Promise<void> {
    if (scheduleType !== CareScheduleType.CHECK_IN) return;
    try {
        await triggerSaheliCheckIn(familyId, recipientUserId, actorUserId);
    } catch (err) {
        console.warn("Saheli check-in trigger failed:", err);
    }
}
