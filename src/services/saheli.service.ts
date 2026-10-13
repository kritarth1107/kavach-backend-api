/**
 * The family's briefing, overview and activity for the dashboard and the get_family_briefing tool. The dashboard chat
 * and the old (v1) WhatsApp chat that lived here are gone (trust plan A1; founder 2026-10-03 and D9): Saheli answers on
 * WhatsApp through her brain (engine /v2/turn) only.
 */
import CareSchedule from "../models/careSchedule.model";
import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";
import SaheliMessage, { type SaheliThreadKind } from "../models/saheliMessage.model";
import { AppError } from "../middleware/error.middleware";
import { CareScheduleType } from "../types/careSchedule.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";
import { getFamilyMembersList } from "./familyMember.service";
import { getISTParts } from "../utils/istTime.util";

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

async function listThread(
    familyId: string,
    recipientUserId: string,
    thread: SaheliThreadKind,
    limit = 50,
    sessionId?: string,
) {
    const filter: Record<string, unknown> = { familyId, recipientUserId, thread };
    if (sessionId) filter.sessionId = sessionId;

    // Newest-N then chronological: sort desc + limit, then reverse.
    // (Ascending + limit wrongly returns oldest-N on long threads.)
    const rows = await SaheliMessage.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    rows.reverse();
    return rows.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt ? m.createdAt.toISOString() : null,
        order: m.orderPayload ?? undefined,
        orderFlow: m.orderFlowPayload ?? undefined,
        orderPreview: m.orderPreviewPayload ?? undefined,
        connect: m.connectPayload ?? undefined,
    }));
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
    const today = getISTParts().dayOfWeek;
    const schedules = await CareSchedule.find({
        familyId,
        recipientUserId,
        active: true,
    }).lean();
    return schedules.filter((s) => scheduleAppliesToday(s.daysOfWeek ?? [], today));
}

export type BriefingItem = {
    scheduleId?: string;
    title: string;
    time: string;
    dosage?: string;
    type: string;
    status?: string;
};

export async function getRecipientBriefing(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    dateKey?: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
    const dayStatus = await getScheduleDayStatuses(
        familyId,
        recipientUserId,
        actorUserId,
        dateKey,
    );

    const todayItems: BriefingItem[] = dayStatus.items.map((s) => ({
        scheduleId: s.scheduleId,
        title: s.title,
        time: s.time,
        dosage: s.dosage ?? undefined,
        type: s.type,
        status: s.status,
    }));

    const unconfirmedItems = dayStatus.items
        .filter((s) => s.status === "missed" || s.status === "due")
        .map((s) => ({
            scheduleId: s.scheduleId,
            title: s.title,
            time: s.time,
            dosage: s.dosage ?? undefined,
            type: s.type,
            status: s.status,
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
        todayItems,
        unconfirmedItems,
        scheduleStatuses: dayStatus.items,
        completedCount: dayStatus.completedCount,
        missedCount: dayStatus.missedCount,
        upcomingCount: dayStatus.upcomingCount,
        elapsedCount: dayStatus.elapsedCount,
        adherencePercent: dayStatus.adherencePercent,
        dateKey: dayStatus.dateKey,
    };
}

export function scheduleAppliesToday(daysOfWeek: number[], day?: number): boolean {
    if (!daysOfWeek.length) return true;
    const dow = day ?? getISTParts().dayOfWeek;
    return daysOfWeek.includes(dow);
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

    const today = getISTParts().dayOfWeek;
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
            LabDocument.find({ familyId, recipientUserId, reviewStatus: { $nin: ["needs_review", "file_only"] } }).sort({ createdAt: -1 }).lean(),
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
                detail: msg.content.length > 120 ? `${msg.content.slice(0, 117).replace(/\s+\S*$/, "")}…` : msg.content,
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

    const pendingApprovals = await Order.countDocuments({
        familyId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    });

    return {
        careRecipientCount: recipients.length,
        schedulesToday,
        checkInsToday,
        completedToday,
        messagesToday,
        pendingApprovals,
        medAdherencePercent: schedulesToday
            ? Math.round((completedToday / schedulesToday) * 100)
            : 0,
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
