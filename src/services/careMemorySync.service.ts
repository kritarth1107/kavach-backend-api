/**
 * Bridge from Saheli's care memory (ai-engine Postgres) to the schedules the reminder
 * scheduler fires. The care record owns medicine times; this keeps CareSchedule rows in step.
 */
import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import SaheliNudgeLog from "../models/saheliNudgeLog.model";
import { CareScheduleType } from "../types/careSchedule.types";

const FOOD_TIMING: Record<string, string> = {
    before_food: "Before food",
    after_food: "After food",
    with_food: "With food",
    empty_stomach: "Empty stomach",
};

export function normalizeTimes(times: unknown): string[] {
    const out = new Set<string>();
    for (const raw of Array.isArray(times) ? times : []) {
        const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) continue;
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h > 23 || min > 59) continue;
        out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
    }
    return [...out].sort();
}

/** One schedule row per dose time. Times no longer in the record are switched off, not deleted. */
export async function syncMedicineSchedule(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    sourceKey: string;
    name: string;
    dose?: string;
    times: unknown;
    foodTiming?: string;
    instructions?: string;
    daysOfWeek?: number[];
    active: boolean;
}): Promise<{ active: string[]; disabled: string[] }> {
    const times = input.active ? normalizeTimes(input.times) : [];
    const existing = await CareSchedule.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        sourceKey: input.sourceKey,
    });
    const instructions = [FOOD_TIMING[input.foodTiming || ""], input.instructions?.trim()].filter(Boolean).join(". ");
    const days = Array.isArray(input.daysOfWeek) ? input.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [];
    const kept: string[] = [];
    const disabled: string[] = [];
    for (const row of existing) {
        if (times.includes(row.time)) {
            row.title = input.name.slice(0, 120);
            row.dosage = input.dose?.slice(0, 80) || undefined;
            row.instructions = instructions.slice(0, 300) || undefined;
            row.daysOfWeek = days;
            row.active = true;
            row.updatedBy = input.actorUserId;
            await row.save();
            kept.push(row.time);
        } else if (row.active) {
            row.active = false;
            row.updatedBy = input.actorUserId;
            await row.save();
            disabled.push(row.time);
        }
    }
    for (const time of times.filter((t) => !kept.includes(t))) {
        await CareSchedule.create({
            scheduleId: randomUUID(),
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            type: CareScheduleType.MEDICINE,
            title: input.name.slice(0, 120),
            time,
            dosage: input.dose?.slice(0, 80) || undefined,
            instructions: instructions.slice(0, 300) || undefined,
            daysOfWeek: days,
            active: true,
            createdBy: input.actorUserId,
            updatedBy: input.actorUserId,
            sourceKey: input.sourceKey,
        });
        kept.push(time);
    }
    return { active: kept.sort(), disabled };
}

/** What the reminder scheduler actually did on a day: sent, failed, or never tried. */
export async function reminderLog(input: { familyId: string; recipientUserId: string; dateKey: string }) {
    const [logs, schedules] = await Promise.all([
        SaheliNudgeLog.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, dateKey: input.dateKey })
            .sort({ createdAt: 1 })
            .lean(),
        CareSchedule.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, active: true }).lean(),
    ]);
    const titles = new Map(schedules.map((s) => [s.scheduleId, `${s.title}${s.dosage ? ` ${s.dosage}` : ""} at ${s.time}`]));
    return {
        dateKey: input.dateKey,
        attempts: logs.map((l) => ({
            item: (l.scheduleId && titles.get(l.scheduleId)) || l.scheduleId || "",
            kind: l.nudgeKind,
            delivered: Boolean(l.delivered),
            reason: l.reason || null,
            at: l.lastAttemptAt || l.createdAt,
        })),
        scheduled: schedules
            .filter((s) => s.type === CareScheduleType.MEDICINE)
            .map((s) => ({ scheduleId: s.scheduleId, item: titles.get(s.scheduleId) })),
    };
}

/** Everything the backend knows about a care recipient, for seeding Saheli's care memory once. */
export async function exportCareRecord(input: { familyId: string; recipientUserId: string }) {
    const { default: ElderProfile } = await import("../models/elderProfile.model");
    const [profile, schedules] = await Promise.all([
        ElderProfile.findOne({ familyId: input.familyId, recipientUserId: input.recipientUserId }).lean(),
        CareSchedule.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, active: true }).lean(),
    ]);
    const learned = (profile?.facts || [])
        .filter((f) => f.status !== "rejected" && f.status !== "faded" && !f.blocked && (f.pinned || f.status !== "learned" || f.confidence >= 0.7))
        .map((f) => ({ category: f.category, text: f.text, confirmed: Boolean(f.pinned) || f.status !== "learned", confidence: f.confidence }));
    return {
        nameToUse: profile?.nameToUse || profile?.tuning?.addressAs || null,
        avoidMaa: Boolean(profile?.tuning?.avoidMaa),
        language: profile?.tuning?.language || null,
        allergies: profile?.allergies || [],
        dietRules: profile?.dietRules || [],
        profileMedicines: (profile?.medicines || []).filter((m) => m.active !== false).map((m) => ({ name: m.name, dose: m.dose, time: m.time })),
        schedules: schedules.map((s) => ({
            scheduleId: s.scheduleId,
            type: s.type,
            title: s.title,
            time: s.time,
            dosage: s.dosage || null,
            instructions: s.instructions || null,
            daysOfWeek: s.daysOfWeek || [],
            sourceKey: s.sourceKey || null,
        })),
        learned,
    };
}

/** Hand dashboard-made schedule rows to a care-record key so later syncs update them instead of duplicating. */
export async function claimScheduleRows(input: { familyId: string; recipientUserId: string; key: string; scheduleIds: string[] }) {
    const res = await CareSchedule.updateMany(
        { familyId: input.familyId, recipientUserId: input.recipientUserId, scheduleId: { $in: input.scheduleIds }, sourceKey: { $in: [null, undefined, ""] } },
        { $set: { sourceKey: input.key } },
    );
    return { claimed: res.modifiedCount };
}
