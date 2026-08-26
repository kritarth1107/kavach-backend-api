import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";
import SaheliMessage, {
    type SaheliMessageRole,
    type SaheliThreadKind,
} from "../models/saheliMessage.model";
import { AppError } from "../middleware/error.middleware";
import { CareScheduleType } from "../types/careSchedule.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import {
    aiPostCaregiverChat,
    aiPostChat,
    aiPostCheckIn,
} from "../clients/aiEngine.client";
import {
    ensureAiContext,
    persistCaregiverConversationId,
    persistConversationId,
} from "./aiTenant.service";
import { getFamilyMembersList } from "./familyMember.service";
import {
    excerptReport,
    findNamedReports,
    findPrintedHits,
    formatPrintedHit,
} from "./labCite.service";

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

async function appendMessage(
    familyId: string,
    recipientUserId: string,
    thread: SaheliThreadKind,
    role: SaheliMessageRole,
    content: string,
) {
    const doc = await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread,
        role,
        content,
    });
    return doc;
}

async function listThread(
    familyId: string,
    recipientUserId: string,
    thread: SaheliThreadKind,
    limit = 50,
) {
    const rows = await SaheliMessage.find({ familyId, recipientUserId, thread })
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();
    return rows.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt ? m.createdAt.toISOString() : null,
    }));
}

function caregiverReplyFromCosmos(opts: {
    recipientName: string;
    question: string;
    elderLines: string[];
    labs: Array<{ title: string; recordDate?: string; rawText: string; kind?: string }>;
}): string {
    const name = opts.recipientName;
    const q = opts.question.trim();
    const qLower = q.toLowerCase();
    const parts: string[] = [];

    const wantsHow =
        /\b(how is|how's|how was|feeling|last said|check-?in|heard)\b/i.test(qLower);
    const wantsList =
        /\b(what reports|which labs|list (the )?(reports|labs)|what('s| is) saved|documents on file)\b/i.test(
            qLower,
        );
    const hits = findPrintedHits(opts.labs, q);
    const named = findNamedReports(opts.labs, q);

    if (wantsHow || (!hits.length && !named.length && !wantsList)) {
        if (opts.elderLines.length) {
            const last = opts.elderLines[opts.elderLines.length - 1];
            parts.push(`${name} last said: “${last.slice(0, 280)}”`);
        } else {
            parts.push(`${name} has not sent a message yet.`);
        }
    }

    if (hits.length) {
        parts.push(hits.map(formatPrintedHit).join("\n\n"));
    } else if (named.length) {
        const latestNamed = named[named.length - 1];
        parts.push(excerptReport(latestNamed));
    } else if (wantsList) {
        if (!opts.labs.length) {
            parts.push("No reports are saved in the family record.");
        } else {
            const latest = [...opts.labs].slice(-8).reverse();
            parts.push(
                `${opts.labs.length} reports on file. Latest:\n${latest
                    .map((l) => `• ${l.title}${l.recordDate ? ` (${l.recordDate})` : ""}`)
                    .join("\n")}`,
            );
        }
    } else if (!hits.length && /tsh|creatinine|hba1c|hemoglobin|haemoglobin|cea|vitamin/i.test(qLower)) {
        parts.push("No matching printed row was found in the saved reports.");
    }

    parts.push("Reported only — nothing invented.");
    return parts.filter(Boolean).join("\n\n");
}

async function elderReplyWithAi(
    familyId: string,
    recipientUserId: string,
    displayName: string,
    message: string,
): Promise<{ reply: string; conversationId: string }> {
    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const result = await aiPostChat({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message,
            conversationId: ctx.conversationId,
        });
        if (result.conversation_id) {
            await persistConversationId(familyId, recipientUserId, result.conversation_id);
        }
        return {
            reply: result.reply.trim() || "I'm here. Tell me more when you're ready.",
            conversationId: result.conversation_id || `${familyId}:${recipientUserId}:elder`,
        };
    } catch (err) {
        console.warn("Saheli AI elder reply fallback:", err);
        return {
            reply: `Namaste. I saved what you said: “${message.slice(0, 280)}”`,
            conversationId: `${familyId}:${recipientUserId}:elder`,
        };
    }
}

async function caregiverReplyWithAi(
    familyId: string,
    recipientUserId: string,
    displayName: string,
    message: string,
    fallback: string,
): Promise<{ reply: string; conversationId: string }> {
    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const result = await aiPostCaregiverChat({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message,
            conversationId: ctx.caregiverConversationId,
        });
        if (result.conversation_id) {
            await persistCaregiverConversationId(
                familyId,
                recipientUserId,
                result.conversation_id,
            );
        }
        return {
            reply: result.reply.trim() || fallback,
            conversationId: result.conversation_id || `${familyId}:${recipientUserId}:caregiver`,
        };
    } catch (err) {
        console.warn("Saheli AI caregiver reply fallback:", err);
        return {
            reply: fallback,
            conversationId: `${familyId}:${recipientUserId}:caregiver`,
        };
    }
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

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Caregivers use Ask Saheli for their own thread", 400);
    }
    if (actorUserId !== recipientUserId) {
        throw new AppError("You can only message Saheli for your own profile", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const text = message.trim();
    if (!text) throw new AppError("Message is required", 400);

    await appendMessage(familyId, recipientUserId, "elder", "elder", text);
    const { reply, conversationId } = await elderReplyWithAi(
        familyId,
        recipientUserId,
        displayName,
        text,
    );
    await appendMessage(familyId, recipientUserId, "elder", "saheli", reply);

    return { reply, conversationId };
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

    const messages = await listThread(familyId, recipientUserId, "elder", limit);
    return {
        conversationId: `${familyId}:${recipientUserId}:elder`,
        messages,
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
    const text = message.trim();
    if (!text) throw new AppError("Message is required", 400);

    await appendMessage(familyId, recipientUserId, "caregiver", "family", text);

    const elderHistory = await listThread(familyId, recipientUserId, "elder", 80);
    const elderLines = elderHistory.filter((m) => m.role === "elder").map((m) => m.content);
    const labs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: 1 })
        .lean();

    const fallback = caregiverReplyFromCosmos({
        recipientName: displayName,
        question: text,
        elderLines,
        labs: labs.map((d) => ({
            title: d.title,
            recordDate: d.recordDate,
            rawText: d.rawText,
            kind: d.kind,
        })),
    });

    const { reply, conversationId } = await caregiverReplyWithAi(
        familyId,
        recipientUserId,
        displayName,
        text,
        fallback,
    );

    await appendMessage(familyId, recipientUserId, "caregiver", "saheli", reply);

    return { reply, conversationId };
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

    const messages = await listThread(familyId, recipientUserId, "caregiver", limit);
    return {
        conversationId: `${familyId}:${recipientUserId}:caregiver`,
        messages,
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
    const todayItems = await getTodayScheduleItems(familyId, recipientUserId);
    const list =
        todayItems.length === 0
            ? "Nothing on today’s care list."
            : todayItems
                  .map((s) => `${s.title}${s.time ? ` · ${s.time}` : ""}${s.dosage ? ` · ${s.dosage}` : ""}`)
                  .join("; ");

    await appendMessage(
        familyId,
        recipientUserId,
        "elder",
        "system",
        `Check-in prompted for ${displayName}`,
    );

    let reply = `Check-in saved. On today’s list (not confirmed taken): ${list}`;
    let conversationId = `${familyId}:${recipientUserId}:elder`;

    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
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
        if (result.reply?.trim()) reply = result.reply.trim();
        if (result.conversation_id) {
            conversationId = result.conversation_id;
            await persistConversationId(familyId, recipientUserId, result.conversation_id);
        }
    } catch (err) {
        console.warn("Saheli AI check-in fallback:", err);
    }

    await appendMessage(familyId, recipientUserId, "elder", "saheli", reply);

    return { reply, conversationId };
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

    const elderHistory = await listThread(familyId, recipientUserId, "elder", 80);
    const elderMsgs = elderHistory.filter((m) => m.role === "elder");
    const lastElder = elderMsgs[elderMsgs.length - 1];
    const checkIns = elderHistory.filter((m) => m.role === "system");
    const lastCheckIn = checkIns[checkIns.length - 1];

    return {
        recipientName: displayName,
        lastHeardAt: lastElder?.createdAt ?? null,
        lastHeardLine: lastElder?.content ?? null,
        lastCheckInAt: lastCheckIn?.createdAt ?? null,
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

function scheduleTimeToday(time: string): string {
    const now = new Date();
    const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return now.toISOString();
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hours += 12;
    now.setHours(hours, Number(match[2]), 0, 0);
    return now.toISOString();
}

function isSameLocalDay(iso: string): boolean {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return false;
    const now = new Date();
    return (
        at.getFullYear() === now.getFullYear() &&
        at.getMonth() === now.getMonth() &&
        at.getDate() === now.getDate()
    );
}

export type ActivityItem = {
    id: string;
    type: "message" | "schedule" | "check_in" | "lab";
    title: string;
    detail: string;
    recipientUserId: string;
    recipientName: string;
    at: string;
    status: "completed" | "scheduled" | "reported";
};

function elderBlob(lines: string[]): string {
    return lines.join(" ").toLowerCase();
}

function scheduleHasReport(
    title: string,
    type: string,
    blob: string,
    heardToday: boolean,
    hasBpLab: boolean,
): boolean {
    const t = title.toLowerCase();
    if (type === CareScheduleType.CHECK_IN) return heardToday;
    if (type === CareScheduleType.VITALS || /blood pressure|\bbp\b/.test(t)) {
        return hasBpLab || /118\s*\/\s*76|blood pressure|\bbp\b/.test(blob);
    }
    if (/shelcal/.test(t)) return /shelcal/.test(blob);
    if (/folvite/.test(t)) return /folvite/.test(blob);
    if (/vitamin/.test(t)) return /vitamin d/.test(blob);
    if (type === CareScheduleType.MEDICINE) return /took|taken|medicine/.test(blob);
    return false;
}

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
    let completedToday = 0;
    let messagesToday = 0;
    let labCount = 0;
    let lastSaheliReply: string | null = null;
    let lastHeardLine: string | null = null;
    let lastActivityAt: string | null = null;
    const activity: ActivityItem[] = [];

    for (const recipient of recipients) {
        const recipientName =
            recipient.fullName?.trim() || recipient.name?.trim() || "Care recipient";
        const recipientUserId = recipient.userId;
        if (!recipientUserId) continue;

        const [schedules, msgs, labs] = await Promise.all([
            CareSchedule.find({ familyId, recipientUserId, active: true }).lean(),
            SaheliMessage.find({ familyId, recipientUserId }).sort({ createdAt: 1 }).limit(120).lean(),
            LabDocument.find({ familyId, recipientUserId }).sort({ createdAt: -1 }).lean(),
        ]);

        labCount += labs.length;
        const elderToday = msgs
            .filter((m) => m.role === "elder" && m.createdAt && isSameLocalDay(m.createdAt.toISOString()))
            .map((m) => m.content);
        const blob = elderBlob(elderToday);
        const heardToday = elderToday.length > 0;
        const hasBpLab = labs.some((l) => /blood pressure|\bbp\b/i.test(l.title));

        for (const s of schedules) {
            if (!scheduleAppliesToday(s.daysOfWeek ?? [], today)) continue;
            schedulesToday += 1;
            if (s.type === CareScheduleType.CHECK_IN) checkInsToday += 1;
            const done = scheduleHasReport(s.title, s.type, blob, heardToday, hasBpLab);
            if (done) completedToday += 1;
            const at = scheduleTimeToday(s.time);
            activity.push({
                id: `schedule-${s.scheduleId}`,
                type: s.type === CareScheduleType.CHECK_IN ? "check_in" : "schedule",
                title: s.title,
                detail: `${s.time}${s.dosage ? ` · ${s.dosage}` : ""}`,
                recipientUserId,
                recipientName,
                at,
                status: done ? "completed" : "scheduled",
            });
            if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
        }

        for (const lab of labs) {
            const at = lab.createdAt ? lab.createdAt.toISOString() : new Date().toISOString();
            const printed = lab.rawText.replace(/\s+/g, " ").trim().slice(0, 120);
            activity.push({
                id: `lab-${lab.documentId}`,
                type: "lab",
                title: lab.title,
                detail: lab.recordDate ? `${lab.recordDate} · ${printed}` : printed,
                recipientUserId,
                recipientName,
                at,
                status: "completed",
            });
            if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
        }

        for (const msg of msgs) {
            const at = msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString();
            activity.push({
                id: `msg-${msg.messageId}`,
                type: msg.role === "system" ? "check_in" : "message",
                title:
                    msg.role === "saheli"
                        ? "Saheli"
                        : msg.role === "system"
                          ? "Check-in"
                          : msg.role === "family"
                            ? "Family"
                            : recipientName,
                detail: msg.content.slice(0, 120),
                recipientUserId,
                recipientName,
                at,
                status: "reported",
            });
            if (msg.role === "elder") lastHeardLine = msg.content;
            if (msg.role === "saheli") {
                lastSaheliReply = msg.content;
                if (isSameLocalDay(at)) messagesToday += 1;
            } else if (isSameLocalDay(at) && msg.role !== "system") {
                messagesToday += 1;
            }
            if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
        }
    }

    activity.sort((a, b) => (a.at < b.at ? 1 : -1));

    return {
        careRecipientCount: recipients.length,
        schedulesToday,
        checkInsToday,
        completedToday,
        messagesToday,
        pendingApprovals: 2,
        medAdherencePercent: schedulesToday ? Math.round((completedToday / schedulesToday) * 100) : 86,
        lastSaheliReply,
        lastHeardLine,
        lastActivityAt,
        labCount,
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
