import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import CareScheduleCompletion from "../models/careScheduleCompletion.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import {
    CareScheduleCompletionStatus,
    CareScheduleDayStatus,
    ScheduleDayItem,
} from "../types/careScheduleCompletion.types";
import Family from "../models/family.model";
import {
    getISTParts,
    isPastDayIST,
    isSameDayIST,
    parseDateKeyIST,
    toDateKeyIST,
} from "../utils/istTime.util";

function scheduleAppliesOnDay(daysOfWeek: number[], day: number): boolean {
    if (!daysOfWeek.length) return true;
    return daysOfWeek.includes(day);
}

const MANAGER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

export function parseTimeToMinutes(time: string): number | null {
    const trimmed = time.trim();
    const ampm = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
        let hours = Number(ampm[1]) % 12;
        const minutes = Number(ampm[2]);
        if (ampm[3].toUpperCase() === "PM") hours += 12;
        return hours * 60 + minutes;
    }
    const h24 = trimmed.match(/^(\d{1,2}):(\d{2})$/);
    if (h24) {
        const hours = Number(h24[1]);
        const minutes = Number(h24[2]);
        if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
            return hours * 60 + minutes;
        }
    }
    return null;
}

async function getFamilyAndRecipient(familyId: string, recipientUserId: string, actorUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new AppError("Family not found", 404);

    const member = family.members.find((m) => m.userId === recipientUserId);
    if (!member || member.status !== FamilyMemberStatus.JOINED) {
        throw new AppError("Care recipient not found", 404);
    }
    // Self care: a caregiver may keep their own schedule.
    const selfCare = recipientUserId === actorUserId && (member.role === FamilyRole.PRIMARY_CAREGIVER || member.role === FamilyRole.CO_CAREGIVER);
    if (member.role !== FamilyRole.CARE_RECIPIENT && !selfCare) {
        throw new AppError("Member is not a care recipient", 400);
    }
    return family;
}

function assertFamilyAccess(
    family: Awaited<ReturnType<typeof getFamilyAndRecipient>>,
    userId: string,
) {
    if (!family.hasJoinedMember(userId)) {
        throw new AppError("Family not found or access denied", 403);
    }
}

function assertCanManage(
    family: Awaited<ReturnType<typeof getFamilyAndRecipient>>,
    userId: string,
) {
    const role = family.getMemberRole(userId);
    if (!role || !MANAGER_ROLES.has(role)) {
        throw new AppError("You do not have permission to update care tasks", 403);
    }
}

async function getSchedulesForDayOfWeek(
    familyId: string,
    recipientUserId: string,
    dayOfWeek: number,
) {
    const schedules = await CareSchedule.find({
        familyId,
        recipientUserId,
        active: true,
    }).lean();

    return schedules
        .filter((s) => scheduleAppliesOnDay(s.daysOfWeek ?? [], dayOfWeek))
        .sort((a, b) => {
            const ma = parseTimeToMinutes(a.time) ?? Number.MAX_SAFE_INTEGER;
            const mb = parseTimeToMinutes(b.time) ?? Number.MAX_SAFE_INTEGER;
            return ma - mb;
        });
}

export function resolveItemStatus(input: {
    scheduleTime: string;
    dateKey: string;
    now?: Date;
    manualStatus?: CareScheduleCompletionStatus | null;
}): CareScheduleDayStatus {
    const { scheduleTime, dateKey, manualStatus } = input;
    const now = input.now ?? new Date();

    if (manualStatus === "completed") return "completed";
    if (manualStatus === "missed") return "missed";

    if (!isSameDayIST(dateKey, now)) {
        if (isPastDayIST(dateKey, now)) return "missed";
        return "upcoming";
    }

    const scheduleMinutes = parseTimeToMinutes(scheduleTime);
    if (scheduleMinutes === null) return "due";

    const nowMinutes = getISTParts(now).minutesSinceMidnight;
    if (nowMinutes < scheduleMinutes) return "upcoming";
    // The reminder minute is still due. Missed starts once they have had time to answer.
    if (nowMinutes - scheduleMinutes < 15) return "due";
    return "missed";
}

export async function getScheduleDayStatuses(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    dateKey?: string,
): Promise<{
    dateKey: string;
    items: ScheduleDayItem[];
    completedCount: number;
    missedCount: number;
    upcomingCount: number;
    dueCount: number;
    elapsedCount: number;
    adherencePercent: number | null;
}> {
    const family = await getFamilyAndRecipient(familyId, recipientUserId, actorUserId);
    assertFamilyAccess(family, actorUserId);

    const key = dateKey ?? toDateKeyIST();
    const reference = parseDateKeyIST(key);
    if (!reference) throw new AppError("Invalid date", 400);

    const now = new Date();
    const schedules = await getSchedulesForDayOfWeek(
        familyId,
        recipientUserId,
        reference.dayOfWeek,
    );

    const completions = await CareScheduleCompletion.find({
        familyId,
        recipientUserId,
        dateKey: key,
    }).lean();

    const completionBySchedule = new Map(
        completions.map((c) => [c.scheduleId, c]),
    );

    const items: ScheduleDayItem[] = schedules.map((s) => {
        const manual = completionBySchedule.get(s.scheduleId);
        const status = resolveItemStatus({
            scheduleTime: s.time,
            dateKey: key,
            now,
            manualStatus: manual?.status ?? null,
        });

        return {
            scheduleId: s.scheduleId,
            title: s.title,
            time: s.time,
            dosage: s.dosage ?? null,
            type: s.type,
            status,
            markedBy: manual?.markedBy ?? null,
            markedAt: manual?.updatedAt?.toISOString?.() ?? manual?.createdAt?.toISOString?.() ?? null,
            createdAt: (s as { createdAt?: Date }).createdAt?.toISOString?.() ?? null,
        };
    });

    const completedCount = items.filter((i) => i.status === "completed").length;
    const missedCount = items.filter((i) => i.status === "missed").length;
    const upcomingCount = items.filter((i) => i.status === "upcoming").length;
    const dueCount = items.filter((i) => i.status === "due").length;
    const elapsedCount = completedCount + missedCount + dueCount;
    const adherencePercent =
        elapsedCount > 0 ? Math.round((completedCount / elapsedCount) * 100) : null;

    return {
        dateKey: key,
        items,
        completedCount,
        missedCount,
        upcomingCount,
        dueCount,
        elapsedCount,
        adherencePercent,
    };
}

export async function markScheduleItemCompletion(
    familyId: string,
    recipientUserId: string,
    scheduleId: string,
    actorUserId: string,
    payload: {
        status: CareScheduleCompletionStatus;
        dateKey?: string;
        note?: string;
        /** false when Saheli's brain marked it: it has already written this to its own ledger. */
        ledger?: boolean;
    },
) {
    const family = await getFamilyAndRecipient(familyId, recipientUserId, actorUserId);
    assertFamilyAccess(family, actorUserId);
    const role = family.getMemberRole(actorUserId);
    const isSelf = actorUserId === recipientUserId;
    const isManager = role ? MANAGER_ROLES.has(role) : false;
    if (!isSelf && !isManager) {
        throw new AppError("You do not have permission to update care tasks", 403);
    }

    const schedule = await CareSchedule.findOne({ scheduleId, familyId, recipientUserId });
    if (!schedule) throw new AppError("Schedule item not found", 404);

    const dateKey = payload.dateKey ?? toDateKeyIST();
    if (!parseDateKeyIST(dateKey)) throw new AppError("Invalid date", 400);

    const existing = await CareScheduleCompletion.findOne({
        familyId,
        recipientUserId,
        scheduleId,
        dateKey,
    });

    if (existing) {
        existing.status = payload.status;
        existing.markedBy = actorUserId;
        existing.note = payload.note?.trim() || undefined;
        await existing.save();
    } else {
        await CareScheduleCompletion.create({
            completionId: randomUUID(),
            familyId,
            recipientUserId,
            scheduleId,
            dateKey,
            status: payload.status,
            markedBy: actorUserId,
            note: payload.note?.trim() || undefined,
        });
    }

    if (payload.ledger !== false) {
        void pushCompletionToLedger({ familyId, recipientUserId, actorUserId, schedule: schedule.toObject(), dateKey, status: payload.status, note: payload.note, family });
    }
    return getScheduleDayStatuses(familyId, recipientUserId, actorUserId, dateKey);
}

/**
 * Saheli's ledger must know every dose marked outside a conversation (the Done button under a reminder, a tick on the
 * dashboard): she reads "taken or missed" from it, and a reminder with no "taken" after it looks missed.
 */
async function pushCompletionToLedger(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    schedule: { scheduleId: string; title: string; type?: string; dosage?: string; time?: string };
    dateKey: string;
    status: CareScheduleCompletionStatus;
    note?: string;
    family: { members: Array<{ userId: string }> };
}): Promise<void> {
    try {
        // A correction of an earlier day reaches Saheli too (the engine files it under that day and drops the older answer).
        const back = (Date.parse(`${toDateKeyIST()}T12:00:00+05:30`) - Date.parse(`${input.dateKey}T12:00:00+05:30`)) / 86400000;
        if (!(back >= 0 && back <= 7)) return;
        const s = input.schedule;
        const medicine = String(s.type || "").toUpperCase() === "MEDICINE";
        const what = `${s.title}${s.dosage ? ` ${s.dosage}` : ""}${s.time ? ` (${s.time})` : ""}`;
        const done = input.status === "completed";
        let who = "they marked it";
        if (input.actorUserId !== input.recipientUserId) {
            const { default: User } = await import("../models/users.model");
            const u = await User.findOne({ userId: input.actorUserId }).lean<{ firstName?: string }>();
            who = `marked by ${u?.firstName || "a caregiver"}`;
        }
        const { aiPushCareEvent } = await import("../clients/aiEngine.client");
        await aiPushCareEvent({
            family_id: input.familyId,
            subject_id: input.recipientUserId,
            kind: medicine ? (done ? "dose_taken" : "dose_missed") : done ? "routine_done" : "routine_missed",
            summary: `${what}: ${done ? (medicine ? "taken" : "done") : "missed"} (${who}${input.note ? `; ${input.note.trim().slice(0, 120)}` : ""})`,
            payload: { scheduleId: s.scheduleId, dateKey: input.dateKey, time: s.time, status: input.status, medicine: medicine ? s.title : undefined },
            ref: `completion:${s.scheduleId}:${input.dateKey}:${input.status}:${Date.now()}`,
        });
    } catch (err) {
        console.warn("completion → ledger failed:", err instanceof Error ? err.message : err);
    }
}

export async function setScheduleCompletion(
    familyId: string,
    recipientUserId: string,
    scheduleId: string,
    actorUserId: string,
    payload: {
        status: CareScheduleCompletionStatus;
        dateKey?: string;
        note?: string;
    },
) {
    const family = await getFamilyAndRecipient(familyId, recipientUserId, actorUserId);
    assertCanManage(family, actorUserId);
    return markScheduleItemCompletion(
        familyId,
        recipientUserId,
        scheduleId,
        actorUserId,
        payload,
    );
}
