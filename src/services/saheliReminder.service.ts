import { randomUUID } from "crypto";
import { claimNudgeAttempt, finalizeNudgeAttempt } from "./saheliNudgeAttempt.service";
import Family from "../models/family.model";
import SaheliNudgeLog from "../models/saheliNudgeLog.model";
import SaheliReminder, {
    type ISaheliReminder,
    type SaheliReminderKind,
    type SaheliReminderStatus,
} from "../models/saheliReminder.model";
import { describe, doseFor, isDay, isSkipped, minutesOf, nextOccurrence, normalTime, readSchedule, slotsOn, upcoming, type DoseTime, type ScheduleInput } from "./reminderSchedule.service";
import CareSchedule from "../models/careSchedule.model";
import CareScheduleCompletion from "../models/careScheduleCompletion.model";
import { CareScheduleType } from "../types/careSchedule.types";
import { AppError } from "../middleware/error.middleware";
import { FamilyRole } from "../types/family.types";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";
import { getCompanionProfile, isWithinQuietHours } from "./saheliCompanion.service";
import { deliverOutboundMessage, resolveRecipientChannel } from "./channelOutbound.service";
import { parseTimeToMinutes } from "./careScheduleCompletion.service";

const MANAGER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

/** How long after its time a reminder may still go out (the scheduler was busy or restarting); the slot claim keeps it to once. */
export const REMINDER_LATE_MINUTES = 15;

function serialize(doc: ISaheliReminder, now: Date = new Date()) {
    const nowParts = getISTParts(now);
    const next = doc.status === "active" ? nextOccurrence(doc, toDateKeyIST(now), nowParts.minutesSinceMidnight) : null;
    return {
        reminderId: doc.reminderId,
        familyId: doc.familyId,
        recipientUserId: doc.recipientUserId,
        text: doc.text,
        times: doc.times ?? [],
        kind: doc.kind,
        timezone: doc.timezone,
        windowStartMinutes: doc.windowStartMinutes ?? null,
        windowEndMinutes: doc.windowEndMinutes ?? null,
        stopConditionPhrase: doc.stopConditionPhrase ?? null,
        repeat: doc.repeat || "daily",
        date: doc.date ?? null,
        daysOfWeek: doc.daysOfWeek ?? [],
        startDate: doc.startDate ?? null,
        endDate: doc.endDate ?? null,
        skips: doc.skips ?? [],
        schedule: describe(doc),
        next,
        status: doc.status,
        createdBy: doc.createdBy,
        createdAt: doc.createdAt ?? null,
        updatedBy: doc.updatedBy ?? null,
        stoppedAt: doc.stoppedAt ?? null,
        stoppedBy: doc.stoppedBy ?? null,
        lastFiredAt: doc.lastFiredAt ?? null,
        lastFiredSlotKey: doc.lastFiredSlotKey ?? null,
        aboutKey: doc.aboutKey ?? null,
    };
}

export type ReminderView = ReturnType<typeof serialize>;

const ABOUT_KEY = /^[a-z_]{2,40}:[a-z0-9_]{1,160}$/;

/** A care-record key as data ("medicine:metformin"); anything else is no link. */
export function cleanAboutKey(v: unknown): string | undefined {
    const k = typeof v === "string" ? v.trim().toLowerCase() : "";
    return ABOUT_KEY.test(k) ? k : undefined;
}

/** The dose times of the medicine a reminder is for (its care schedules); none when it is not about a medicine. */
async function dosesOf(r: Pick<ISaheliReminder, "familyId" | "recipientUserId" | "aboutKey">): Promise<DoseTime[]> {
    if (!r.aboutKey?.startsWith("medicine:")) return [];
    const rows = await CareSchedule.find({
        familyId: r.familyId,
        recipientUserId: r.recipientUserId,
        sourceKey: r.aboutKey,
        type: CareScheduleType.MEDICINE,
        active: true,
    }).lean();
    return rows.map((x) => ({ scheduleId: x.scheduleId, time: x.time, daysOfWeek: x.daysOfWeek }));
}

/**
 * Was the dose this reminder time belongs to already marked taken (on WhatsApp, the Done button or the dashboard)?
 * Only for a reminder linked to a medicine; the nearest dose within 12 hours is the one it follows up (doseFor).
 */
export async function linkedDoseTaken(
    r: Pick<ISaheliReminder, "familyId" | "recipientUserId" | "aboutKey">,
    day: string,
    time: string,
    doses?: DoseTime[],
): Promise<boolean> {
    const dose = doseFor(doses ?? (await dosesOf(r)), day, time);
    if (!dose) return false;
    return Boolean(await CareScheduleCompletion.exists({
        familyId: r.familyId,
        recipientUserId: r.recipientUserId,
        scheduleId: dose.scheduleId,
        dateKey: dose.dateKey,
        status: "completed",
    }));
}

async function assertCanManageReminder(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
): Promise<void> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new AppError("Family not found", 404);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }
    const role = family.getMemberRole(actorUserId);
    // Your own reminders (the care recipient, or a caregiver's self care), or a care recipient's if you are a caregiver.
    // Never another caregiver's own reminders: those are their self care.
    if (actorUserId === recipientUserId && role && (role === FamilyRole.CARE_RECIPIENT || MANAGER_ROLES.has(role))) return;
    if (role && MANAGER_ROLES.has(role) && family.getMemberRole(recipientUserId) === FamilyRole.CARE_RECIPIENT) return;
    throw new AppError("You do not have permission to manage reminders", 403);
}

/** Parse "6pm", "9:00", "18:00", "6:30 pm" → HH:MM 24h. */
export function parseClockToHHMM(raw: string): string | null {
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
    const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ?? "00";
    const ap = (m[3] || "").toLowerCase();
    if (Number.isNaN(h) || h > 23) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h > 23) return null;
    return `${String(h).padStart(2, "0")}:${min}`;
}

/** Extract multiple clock times from free text ("6pm and 9pm", "at 18:00, 21:00"). */
export function extractTimesFromText(text: string): string[] {
    const found: string[] = [];
    const re =
        /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const hhmm = parseClockToHHMM(m[1]);
        if (hhmm && !found.includes(hhmm)) found.push(hhmm);
    }
    // Hindi: "raat 8 baje", "subah 9 baje", "sham 6 baje", or bare "8 baje"
    const bajeRe =
        /\b(subah|savar|savere|dupahar|dopahar|sham|shaam|raat|night|evening|morning)?\s*(\d{1,2})\s*baje\b/gi;
    let bm: RegExpExecArray | null;
    while ((bm = bajeRe.exec(text)) !== null) {
        let h = parseInt(bm[2], 10);
        if (Number.isNaN(h) || h < 0 || h > 23) continue;
        const period = (bm[1] || "").toLowerCase();
        if (period && h <= 12) {
            if (/raat|night/.test(period) && h < 12) {
                // 8 raat → 20:00; 12 raat stays awkward — treat 1-11 as PM
                if (h < 12) h = h === 12 ? 0 : h + 12;
            } else if (/sham|shaam|evening/.test(period) && h < 12) {
                h = h + 12;
            } else if (/subah|savar|savere|morning/.test(period) && h === 12) {
                h = 0;
            }
            // dupahar 1-4 → +12 if <=4? keep simple: 1-4 dopahar => 13-16
            else if (/dupahar|dopahar/.test(period) && h < 12) {
                h = h + 12;
            }
        }
        const hhmm = `${String(h).padStart(2, "0")}:00`;
        if (!found.includes(hhmm)) found.push(hhmm);
    }
    return found;
}

export function parseHourlyWindow(text: string): {
    start: number | null;
    end: number | null;
    needsEnd: boolean;
} {
    const lower = text.toLowerCase();
    const hourly =
        /\bevery\s+hour\b/.test(lower) ||
        /\bhourly\b/.test(lower) ||
        /\bevery\s+1\s*h(our)?\b/.test(lower);
    if (!hourly) return { start: null, end: null, needsEnd: false };

    const times = extractTimesFromText(text);
    const startHH = times[0] ?? null;
    const endHH = times[1] ?? null;
    const start = startHH ? parseTimeToMinutes(startHH) : null;
    const end = endHH ? parseTimeToMinutes(endHH) : null;

    const fromMatch = lower.match(/\bfrom\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    const untilMatch = lower.match(
        /\b(?:until|till|to|upto|up to)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    );
    const start2 = fromMatch ? parseTimeToMinutes(parseClockToHHMM(fromMatch[1]) ?? "") : start;
    const end2 = untilMatch ? parseTimeToMinutes(parseClockToHHMM(untilMatch[1]) ?? "") : end;

    return {
        start: start2,
        end: end2,
        needsEnd: start2 != null && end2 == null,
    };
}

export async function createSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    times?: string[];
    kind?: SaheliReminderKind;
    windowStartMinutes?: number | null;
    windowEndMinutes?: number | null;
    stopConditionPhrase?: string | null;
    /**
     * The schedule as data (Saheli's brain reads the person's words and fills these; nothing here reads words):
     * times, repeat (daily | weekly | once), date, days (0 = Sunday), startDate, endDate, windowStart / windowEnd (HH:MM).
     * When given, the reminder text is never parsed for times.
     */
    schedule?: ScheduleInput;
    /** The care-record item it is for ("medicine:metformin"), when Saheli's brain gave one. */
    aboutKey?: string | null;
    now?: Date;
    traceId?: string;
}): Promise<
    | { ok: true; reminder: ReturnType<typeof serialize>; askUser?: string }
    | { ok: false; error: string; askUser?: string }
> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);

    const text = input.text.trim().slice(0, 400);
    if (!text || text.length < 2) {
        return { ok: false, error: "Reminder text is required." };
    }

    if (input.schedule) {
        const now = input.now ?? new Date();
        const checked = readSchedule(input.schedule, toDateKeyIST(now));
        if (!checked.ok) return { ok: false, error: checked.error };
        const doc = await SaheliReminder.create({
            reminderId: randomUUID(),
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            text,
            timezone: "Asia/Kolkata",
            status: "active" as SaheliReminderStatus,
            createdBy: input.actorUserId,
            ...(input.traceId ? { lastTraceId: input.traceId } : {}),
            ...(cleanAboutKey(input.aboutKey) ? { aboutKey: cleanAboutKey(input.aboutKey) } : {}),
            ...checked.fields,
        });
        void logReminderActivity(doc, input.actorUserId, "Reminder created", "created");
        return { ok: true, reminder: serialize(doc, now) };
    }

    const window = parseHourlyWindow(text);
    let kind: SaheliReminderKind = input.kind ?? (window.start != null ? "hourly_window" : "multi_time");
    let times = (input.times ?? []).map((t) => parseClockToHHMM(t) ?? t).filter(Boolean);
    if (!times.length && kind === "multi_time") {
        times = extractTimesFromText(text);
    }

    let windowStartMinutes = input.windowStartMinutes ?? window.start ?? null;
    let windowEndMinutes =
        input.windowEndMinutes !== undefined ? input.windowEndMinutes : window.end ?? null;

    if (kind === "hourly_window" || window.needsEnd) {
        kind = "hourly_window";
        if (windowStartMinutes == null) {
            return {
                ok: false,
                error: "missing_window_start",
                askUser: "What time should I start reminding you every hour?",
            };
        }
        if (windowEndMinutes == null || window.needsEnd) {
            return {
                ok: false,
                error: "missing_window_end",
                askUser: "What time should I stop the hourly reminders?",
            };
        }
    }

    if (kind === "multi_time" && !times.length) {
        return {
            ok: false,
            error: "missing_times",
            askUser: "What time(s) should I remind you? For example 6pm and 9pm.",
        };
    }

    let stop =
        input.stopConditionPhrase?.trim() ||
        (/\buntil\s+i\s+(say\s+)?(.+)$/i.exec(text)?.[2]?.trim() ?? undefined);
    if (stop && stop.length > 200) stop = stop.slice(0, 200);
    if (!stop && /\buntil\s+i\s+(fill|filled|done|finish|call)/i.test(text)) {
        stop = "filled";
    }

    const doc = await SaheliReminder.create({
        reminderId: randomUUID(),
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        text,
        times: kind === "multi_time" ? times : [],
        kind,
        timezone: "Asia/Kolkata",
        windowStartMinutes: kind === "hourly_window" ? windowStartMinutes ?? undefined : undefined,
        windowEndMinutes: kind === "hourly_window" ? windowEndMinutes : null,
        stopConditionPhrase: stop,
        status: "active" as SaheliReminderStatus,
        createdBy: input.actorUserId,
    });
    void import("./activityLog.service").then(({ logActivity }) =>
        logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            kind: "reminder",
            title: "Reminder created",
            detail: text,
            data: { reminderId: doc.reminderId, status: "created", times: doc.times },
        }),
    );

    return { ok: true, reminder: serialize(doc) };
}

function logReminderActivity(doc: ISaheliReminder, actorUserId: string, title: string, status: string) {
    return import("./activityLog.service").then(({ logActivity }) =>
        logActivity({
            familyId: doc.familyId,
            recipientUserId: doc.recipientUserId,
            actorUserId,
            kind: "reminder",
            title,
            detail: `${doc.text} · ${describe(doc)}`,
            data: { reminderId: doc.reminderId, status, times: doc.times },
        }),
    ).catch(() => undefined);
}

export async function listSaheliReminders(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    status?: SaheliReminderStatus | "all";
    now?: Date;
}) {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    const filter: Record<string, unknown> = {
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
    };
    if (input.status === "all") {
        // what is on now, and what stopped or finished in the last 30 days
        const since = new Date((input.now ?? new Date()).getTime() - 30 * 86_400_000);
        filter.$or = [{ status: "active" }, { updatedAt: { $gte: since } }];
    } else filter.status = input.status ?? "active";
    const rows = await SaheliReminder.find(filter).sort({ createdAt: -1 }).limit(60).lean();
    return rows.map((r) => serialize(r as ISaheliReminder, input.now));
}

async function ownReminder(input: { familyId: string; recipientUserId: string; reminderId: string }) {
    return SaheliReminder.findOne({ reminderId: input.reminderId, familyId: input.familyId, recipientUserId: input.recipientUserId });
}

/** Skip one time ("time" given) or a whole day of a reminder; without a day, the next time it would go out. */
export async function skipSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    reminderId: string;
    day?: string;
    time?: string;
    undo?: boolean;
    now?: Date;
    traceId?: string;
}): Promise<{ ok: true; reminder: ReminderView; skipped: string } | { ok: false; error: string }> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    const doc = await ownReminder(input);
    if (!doc) return { ok: false, error: "Reminder not found." };
    if (doc.status !== "active") return { ok: false, error: "That reminder is already stopped." };
    const now = input.now ?? new Date();
    const today = toDateKeyIST(now);
    let day = input.day;
    let time = input.time ? normalTime(input.time) ?? undefined : undefined;
    if (input.time && !time) return { ok: false, error: "time must be HH:MM" };
    if (!day) {
        const next = nextOccurrence(doc, today, getISTParts(now).minutesSinceMidnight);
        if (!next) return { ok: false, error: "It has nothing left to send." };
        day = next.day;
        time = time ?? next.time;
    }
    if (!isDay(day)) return { ok: false, error: "day must be YYYY-MM-DD" };
    const slots = slotsOn(doc, day);
    if (!slots.length) return { ok: false, error: "It does not go out on that day." };
    if (time && !slots.includes(time)) return { ok: false, error: `It does not go out at ${time} that day (${slots.join(", ")}).` };
    const key = time ? `${day}@${time}` : day;
    const skips = new Set(doc.skips ?? []);
    if (input.undo) skips.delete(key);
    else skips.add(key);
    // keep the list short: drop skips of days long gone
    doc.skips = [...skips].filter((k) => k.slice(0, 10) >= today).sort();
    doc.updatedBy = input.actorUserId;
    if (input.traceId) doc.lastTraceId = input.traceId;
    await doc.save();
    void logReminderActivity(doc, input.actorUserId, input.undo ? "Reminder skip undone" : time ? `Reminder skipped (${day} ${time})` : `Reminder skipped (${day})`, "skipped");
    return { ok: true, reminder: serialize(doc, now), skipped: key };
}

/** Change when a reminder goes out (times, days, date, end date) or its words; the schedule is checked as data. */
export async function updateSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    reminderId: string;
    text?: string;
    schedule?: ScheduleInput;
    /** Link it to a care-record item; "" or null removes the link; undefined leaves it. */
    aboutKey?: string | null;
    now?: Date;
    traceId?: string;
}): Promise<{ ok: true; reminder: ReminderView } | { ok: false; error: string }> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    const doc = await ownReminder(input);
    if (!doc) return { ok: false, error: "Reminder not found." };
    if (doc.status !== "active") return { ok: false, error: "That reminder is stopped; set a new one instead." };
    const now = input.now ?? new Date();
    if (input.schedule) {
        // what is not given stays as it was
        const s = input.schedule;
        const timePart: ScheduleInput = s.windowStart !== undefined && s.windowStart !== null && s.windowStart !== ""
            ? { windowStart: s.windowStart, windowEnd: s.windowEnd }
            : s.times !== undefined && s.times !== null
              ? { times: s.times }
              : doc.kind === "hourly_window"
                ? { windowStart: hhmmOf(doc.windowStartMinutes), windowEnd: hhmmOf(doc.windowEndMinutes) }
                : { times: doc.times };
        const merged: ScheduleInput = {
            ...timePart,
            repeat: s.repeat ?? doc.repeat ?? "daily",
            date: s.date ?? doc.date,
            days: s.days ?? doc.daysOfWeek,
            startDate: s.startDate !== undefined ? s.startDate : doc.startDate,
            endDate: s.endDate !== undefined ? s.endDate : doc.endDate,
        };
        const checked = readSchedule(merged, toDateKeyIST(now));
        if (!checked.ok) return { ok: false, error: checked.error };
        doc.set({
            times: [], windowStartMinutes: undefined, windowEndMinutes: null, date: undefined, daysOfWeek: undefined,
            startDate: undefined, endDate: undefined, ...checked.fields,
        });
    }
    if (input.text !== undefined) {
        const text = input.text.trim().slice(0, 400);
        if (text.length < 2) return { ok: false, error: "Reminder text is required." };
        doc.text = text;
    }
    if (input.aboutKey !== undefined) {
        const key = cleanAboutKey(input.aboutKey);
        if (input.aboutKey && !key) return { ok: false, error: "item must be a care record key like medicine:metformin" };
        doc.aboutKey = key;
    }
    doc.updatedBy = input.actorUserId;
    if (input.traceId) doc.lastTraceId = input.traceId;
    await doc.save();
    void logReminderActivity(doc, input.actorUserId, "Reminder changed", "changed");
    return { ok: true, reminder: serialize(doc, now) };
}

function hhmmOf(mins?: number | null): string | undefined {
    return mins == null ? undefined : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

export type ReminderOccurrence = {
    reminderId: string;
    text: string;
    time: string;
    /** scheduled | sent | failed | not_sent (its time passed: quiet hours, paused or the service was down) | skipped |
     *  done (the dose it was for was already marked taken, so it was not needed) */
    status: "scheduled" | "sent" | "failed" | "not_sent" | "skipped" | "done";
    reason?: string;
    schedule: string;
    /** More than three times that day (an hourly one): the calendar shows these smaller. */
    many: boolean;
    stopped: boolean;
};

/** One person's reminders on one day, each time with what happened (for the calendar). */
export async function remindersForDay(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    day: string;
    now?: Date;
}): Promise<{ day: string; occurrences: ReminderOccurrence[]; reminders: ReminderView[] }> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    if (!isDay(input.day)) throw new AppError("day must be YYYY-MM-DD", 400);
    const now = input.now ?? new Date();
    const dayStart = new Date(`${input.day}T00:00:00+05:30`);
    // the window of a reminder that crosses midnight starts the day before
    const rows = (await SaheliReminder.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        createdAt: { $lt: new Date(dayStart.getTime() + 86_400_000) },
        $or: [{ status: "active" }, { updatedAt: { $gte: new Date(dayStart.getTime() - 86_400_000) } }],
    }).lean()) as ISaheliReminder[];
    const logs = await SaheliNudgeLog.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        dateKey: input.day,
        scheduleId: { $regex: "^reminder:" },
    }).lean();
    const byKey = new Map(logs.map((l) => [l.scheduleId, l]));
    const occurrences: ReminderOccurrence[] = [];
    const shown: ISaheliReminder[] = [];
    for (const r of rows) {
        const until = r.status === "active" ? null : (r.stoppedAt ?? r.updatedAt ?? null);
        const slots = slotsOn(r, input.day).filter((t) => {
            const at = new Date(`${input.day}T${t}:00+05:30`);
            if (r.createdAt && at.getTime() < new Date(r.createdAt).getTime() - 60_000) return false;
            return !until || at.getTime() <= new Date(until).getTime();
        });
        if (!slots.length) continue;
        shown.push(r);
        const doses = r.aboutKey ? await dosesOf(r) : [];
        for (const t of slots) {
            const at = new Date(`${input.day}T${t}:00+05:30`);
            const log = byKey.get(`reminder:${r.reminderId}:${t}`);
            let status: ReminderOccurrence["status"];
            let reason: string | undefined;
            const past = at.getTime() + REMINDER_LATE_MINUTES * 60_000 < now.getTime();
            if (log?.delivered) status = "sent";
            else if (isSkipped(r, input.day, t)) status = "skipped";
            else if (log?.reason === "done" || (doses.length && (await linkedDoseTaken(r, input.day, t, doses)))) {
                status = "done";
                reason = "the dose was already marked taken";
            } else if (log?.reason === "paused") {
                status = "not_sent";
                reason = "paused";
            } else if (log && (log.terminal || past)) {
                status = "failed";
                reason = log.reason;
            } else if (past) status = "not_sent";
            else status = "scheduled";
            occurrences.push({ reminderId: r.reminderId, text: r.text, time: t, status, ...(reason ? { reason } : {}),
                               schedule: describe(r), many: slots.length > 3, stopped: r.status !== "active" });
        }
    }
    occurrences.sort((a, b) => (minutesOf(a.time) ?? 0) - (minutesOf(b.time) ?? 0));
    return { day: input.day, occurrences, reminders: shown.map((r) => serialize(r, now)) };
}

export async function cancelSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    reminderId?: string;
    textHint?: string;
    traceId?: string;
}): Promise<{ ok: boolean; reminder?: ReturnType<typeof serialize>; error?: string }> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    let doc = input.reminderId
        ? await SaheliReminder.findOne({
              reminderId: input.reminderId,
              familyId: input.familyId,
              recipientUserId: input.recipientUserId,
          })
        : null;
    if (!doc && input.textHint) {
        const hint = input.textHint.toLowerCase();
        const active = await SaheliReminder.find({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            status: "active",
        }).lean();
        const match = active.find((r) => r.text.toLowerCase().includes(hint) || hint.includes(r.text.toLowerCase().slice(0, 20)));
        if (match) {
            doc = await SaheliReminder.findOne({ reminderId: match.reminderId });
        }
    }
    if (!doc) return { ok: false, error: "Reminder not found." };
    if (doc.status === "active") {
        doc.status = "cancelled";
        doc.stoppedAt = new Date();
        doc.stoppedBy = input.actorUserId;
        doc.updatedBy = input.actorUserId;
        if (input.traceId) doc.lastTraceId = input.traceId;
        await doc.save();
        void logReminderActivity(doc, input.actorUserId, "Reminder stopped", "cancelled");
    }
    return { ok: true, reminder: serialize(doc) };
}

export async function completeSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    reminderId: string;
}) {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    const doc = await SaheliReminder.findOne({
        reminderId: input.reminderId,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
    });
    if (!doc) return { ok: false as const, error: "Reminder not found." };
    doc.status = "completed";
    await doc.save();
    return { ok: true as const, reminder: serialize(doc) };
}

function normalizePhrase(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Hybrid semantic stop: phrase match + light heuristics. */
export function messageCompletesReminder(
    message: string,
    reminder: Pick<ISaheliReminder, "text" | "stopConditionPhrase">,
): boolean {
    const msg = normalizePhrase(message);
    if (!msg || msg.length > 160) return false;

    const stop = reminder.stopConditionPhrase
        ? normalizePhrase(reminder.stopConditionPhrase)
        : "";
    if (stop && (msg.includes(stop) || stop.includes(msg))) return true;

    const filled =
        /\b(i\s+)?(filled|fill(ed)?\s+it|done|finished|complete(d)?|drank|drink|pi\s+liya|pi\s+li|le\s+liya|le\s+li|kar\s+diya|ho\s+gaya|i'?ve\s+called|i\s+called|called\s+(them|him|her))\b/.test(
            msg,
        );
    if (!filled) return false;

    // If reminder mentions medicine / fill / call, accept generic done phrases.
    const topic = normalizePhrase(reminder.text);
    if (/\b(fill|medicine|tablet|dose|pill|call|remind|water|paani|drink)\b/.test(topic) || !topic) {
        return true;
    }
    // Soft overlap between reminder topic and message
    const tokens = topic.split(" ").filter((w) => w.length >= 4);
    return tokens.some((t) => msg.includes(t)) || tokens.length === 0;
}

export async function tryCompleteRemindersFromMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
}): Promise<string | null> {
    const active = await SaheliReminder.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        status: "active",
    }).limit(20);
    if (!active.length) return null;

    const completed: string[] = [];
    for (const rem of active) {
        if (messageCompletesReminder(input.message, rem)) {
            rem.status = "completed";
            await rem.save();
            completed.push(rem.text);
        }
    }
    if (!completed.length) return null;
    if (completed.length === 1) {
        return `Got it — I'll stop reminding you about "${completed[0]}".`;
    }
    return `Got it — stopped ${completed.length} reminders.`;
}

async function fireReminderMessage(input: {
    familyId: string;
    recipientUserId: string;
    reminder: ISaheliReminder;
    slotKey: string;
    dateKey: string;
}): Promise<boolean> {
    const companion = await getCompanionProfile(input.familyId, input.recipientUserId);
    if (isWithinQuietHours(companion)) {
        return false;
    }

    const text = `Reminder: ${input.reminder.text}`;
    const attemptId = await claimNudgeAttempt(
        {
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            scheduleId: `reminder:${input.reminder.reminderId}:${input.slotKey}`,
            dateKey: input.dateKey,
            nudgeKind: "pre_reminder",
        },
        text,
    );
    if (!attemptId) {
        return false;
    }

    const target = await resolveRecipientChannel(
        input.familyId,
        input.recipientUserId,
        companion.preferredChannel ?? "whatsapp",
    );
    if (!target || target.channel === "dashboard") {
        console.warn(
            `Reminder skipped — no valid WhatsApp recipient for ${input.recipientUserId}; terminal for this slot`,
        );
        await finalizeNudgeAttempt(attemptId, {
            delivered: false,
            channel: "dashboard",
            terminal: true,
            reason: "no_valid_recipient",
        });
        return false;
    }

    const delivery = await deliverOutboundMessage({ purpose: "proactive",
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        content: text,
        channel: target.channel,
        channelIdentifier: target.channelIdentifier,
    });

    if (delivery.reason === "paused") {
        // Paused from the admin console: no retries, no "not delivered" warning, and this slot never fires late after a resume.
        await finalizeNudgeAttempt(attemptId, { delivered: false, channel: target.channel, terminal: true, reason: "paused" });
        await SaheliReminder.updateOne({ reminderId: input.reminder.reminderId }, { $set: { lastFiredSlotKey: `${input.dateKey}:${input.slotKey}` } });
        return false;
    }
    await finalizeNudgeAttempt(attemptId, {
        delivered: delivery.delivered,
        channel: target.channel,
        terminal: delivery.reason === "invalid_recipient",
        reason: delivery.delivered ? undefined : delivery.reason ?? "send_failed",
    });
    void import("./activityLog.service").then(({ logActivity }) =>
        logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            kind: "reminder",
            title: delivery.delivered ? "Reminder sent" : "Reminder not delivered",
            detail: text,
            severity: delivery.delivered ? "info" : "warn",
            data: { reminderId: input.reminder.reminderId, status: delivery.delivered ? "fired" : "failed" },
        }),
    );

    if (delivery.delivered) {
        await SaheliReminder.updateOne(
            { reminderId: input.reminder.reminderId },
            {
                $set: {
                    lastFiredAt: new Date(),
                    lastFiredSlotKey: `${input.dateKey}:${input.slotKey}`,
                },
            },
        );
    }
    return delivery.delivered;
}

/**
 * Tick due Instinct-style reminders (call from care nudge scheduler). A slot goes out from its time until
 * REMINDER_LATE_MINUTES after (a busy or restarting scheduler no longer loses it; the slot claim keeps it to once),
 * on the days its schedule says, unless someone skipped it. A reminder with nothing left to send (a once reminder
 * that went out, one past its end date) is marked completed.
 */
/**
 * A reminder that is no longer needed (the dose it was for is already marked taken) is not sent; the slot is claimed
 * so it is decided once, and the day view shows it as done.
 */
async function holdBack(rem: ISaheliReminder, dateKey: string, slot: string): Promise<boolean> {
    const attemptId = await claimNudgeAttempt(
        {
            familyId: rem.familyId,
            recipientUserId: rem.recipientUserId,
            scheduleId: `reminder:${rem.reminderId}:${slot}`,
            dateKey,
            nudgeKind: "pre_reminder",
        },
        `Reminder: ${rem.text}`,
    );
    if (!attemptId) return false;
    await finalizeNudgeAttempt(attemptId, { delivered: false, channel: "none", terminal: true, reason: "done" });
    await SaheliReminder.updateOne({ reminderId: rem.reminderId }, { $set: { lastFiredSlotKey: `${dateKey}:${slot}` } });
    void import("./activityLog.service").then(({ logActivity }) =>
        logActivity({
            familyId: rem.familyId,
            recipientUserId: rem.recipientUserId,
            kind: "reminder",
            title: "Reminder not needed: the dose was already marked taken",
            detail: `Reminder: ${rem.text}`,
            data: { reminderId: rem.reminderId, status: "done", slot },
        }),
    ).catch(() => undefined);
    return true;
}

export async function runSaheliReminderTick(
    now = new Date(),
    fire: typeof fireReminderMessage = fireReminderMessage, // tests pass a fake sender
    alreadyDone: (r: ISaheliReminder, day: string, time: string) => Promise<boolean> = linkedDoseTaken,
): Promise<{ sent: number; scanned: number; finished: number; held: number }> {
    const dateKey = toDateKeyIST(now);
    const { minutesSinceMidnight } = getISTParts(now);
    const active = await SaheliReminder.find({ status: "active" }).limit(2000).lean();
    let sent = 0;
    let scanned = 0;
    let finished = 0;
    let held = 0;

    for (const rem of active) {
        scanned += 1;
        for (const t of slotsOn(rem, dateKey)) {
            const mins = minutesOf(t);
            if (mins == null || minutesSinceMidnight < mins || minutesSinceMidnight > mins + REMINDER_LATE_MINUTES) continue;
            if (isSkipped(rem, dateKey, t)) continue;
            if (rem.aboutKey && (await alreadyDone(rem as ISaheliReminder, dateKey, t).catch(() => false))) {
                if (await holdBack(rem as ISaheliReminder, dateKey, t)) held += 1;
                continue;
            }
            const ok = await fire({
                familyId: rem.familyId,
                recipientUserId: rem.recipientUserId,
                reminder: rem as ISaheliReminder,
                slotKey: t,
                dateKey,
            });
            if (ok) sent += 1;
        }
        if (nextOccurrence(rem, dateKey, Math.max(0, minutesSinceMidnight - REMINDER_LATE_MINUTES)) === null) {
            const res = await SaheliReminder.updateOne({ reminderId: rem.reminderId, status: "active" }, { $set: { status: "completed" } });
            finished += res.modifiedCount ? 1 : 0;
        }
    }

    return { sent, scanned, finished, held };
}

export type ReminderSoon = {
    reminderId: string;
    recipientUserId: string;
    text: string;
    day: string;
    time: string;
    repeat: string;
    aboutKey: string | null;
};

/**
 * The reminders due in the next `hours` hours for these people (at most 6 each), for Saheli's turn: when someone says
 * they already did what one is for, she can skip that time instead of letting it go out anyway.
 */
export async function remindersSoon(familyId: string, userIds: string[], now = new Date(), hours = 12): Promise<ReminderSoon[]> {
    const ids = [...new Set(userIds.filter(Boolean))];
    if (!ids.length) return [];
    const day = toDateKeyIST(now);
    const minute = getISTParts(now).minutesSinceMidnight;
    const rows = (await SaheliReminder.find({ familyId, recipientUserId: { $in: ids }, status: "active" }).limit(200).lean()) as ISaheliReminder[];
    const out: ReminderSoon[] = [];
    for (const id of ids) {
        const mine = rows
            .filter((r) => r.recipientUserId === id)
            .flatMap((r) => upcoming(r, day, minute, hours).map((o) => ({
                reminderId: r.reminderId, recipientUserId: id, text: r.text, day: o.day, time: o.time,
                repeat: r.repeat || "daily", aboutKey: r.aboutKey ?? null,
            })))
            .sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
        out.push(...mine.slice(0, 6));
    }
    return out;
}
