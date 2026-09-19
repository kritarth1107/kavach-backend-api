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
function scheduleAppliesOnDay(daysOfWeek: number[], day: number): boolean {
    if (!daysOfWeek.length) return true;
    return daysOfWeek.includes(day);
}

const MANAGER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

export function parseTimeToMinutes(time: string): number | null {
    const match = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = Number(match[1]) % 12;
    const minutes = Number(match[2]);
    if (match[3].toUpperCase() === "PM") hours += 12;
    return hours * 60 + minutes;
}

export function toDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function parseDateKey(dateKey: string): Date | null {
    const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
}

function isSameLocalDay(a: Date, b: Date): boolean {
    return (
        a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate()
    );
}

async function getFamilyAndRecipient(familyId: string, recipientUserId: string) {
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

async function getSchedulesForDate(
    familyId: string,
    recipientUserId: string,
    date: Date,
) {
    const schedules = await CareSchedule.find({
        familyId,
        recipientUserId,
        active: true,
    }).lean();

    const day = date.getDay();
    return schedules
        .filter((s) => scheduleAppliesOnDay(s.daysOfWeek ?? [], day))
        .sort((a, b) => {
            const ma = parseTimeToMinutes(a.time) ?? Number.MAX_SAFE_INTEGER;
            const mb = parseTimeToMinutes(b.time) ?? Number.MAX_SAFE_INTEGER;
            return ma - mb;
        });
}

function resolveItemStatus(input: {
    scheduleTime: string;
    referenceDate: Date;
    now: Date;
    manualStatus?: CareScheduleCompletionStatus | null;
}): CareScheduleDayStatus {
    const { scheduleTime, referenceDate, now, manualStatus } = input;

    if (manualStatus === "completed") return "completed";
    if (manualStatus === "missed") return "missed";

    const scheduleMinutes = parseTimeToMinutes(scheduleTime);
    const isToday = isSameLocalDay(referenceDate, now);

    if (!isToday) {
        const refStart = new Date(referenceDate);
        refStart.setHours(23, 59, 59, 999);
        if (refStart.getTime() < now.getTime()) return "missed";
        return "upcoming";
    }

    if (scheduleMinutes === null) return "due";

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (nowMinutes < scheduleMinutes) return "upcoming";
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
    const family = await getFamilyAndRecipient(familyId, recipientUserId);
    assertFamilyAccess(family, actorUserId);

    const referenceDate = dateKey ? parseDateKey(dateKey) : new Date();
    if (!referenceDate) throw new AppError("Invalid date", 400);

    const key = dateKey ?? toDateKey(referenceDate);
    const now = new Date();
    const schedules = await getSchedulesForDate(familyId, recipientUserId, referenceDate);

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
            referenceDate,
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
    const family = await getFamilyAndRecipient(familyId, recipientUserId);
    assertCanManage(family, actorUserId);

    const schedule = await CareSchedule.findOne({ scheduleId, familyId, recipientUserId });
    if (!schedule) throw new AppError("Schedule item not found", 404);

    const dateKey = payload.dateKey ?? toDateKey(new Date());
    if (!parseDateKey(dateKey)) throw new AppError("Invalid date", 400);

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

    return getScheduleDayStatuses(familyId, recipientUserId, actorUserId, dateKey);
}
