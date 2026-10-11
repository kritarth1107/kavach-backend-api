/**
 * When a Saheli reminder goes out (pure functions, IST). Shared by the scheduler, the dashboard calendar and Saheli's
 * reminder tools, so all three always agree.
 *
 * A reminder has a time pattern (kind) and a day pattern (repeat):
 * - multi_time: the listed HH:MM times; hourly_window: every full hour from windowStart to windowEnd. A window that
 *   crosses midnight (14:00 → 03:00) belongs to the day it starts: its 00:00–03:00 hours are on the next calendar day.
 * - daily (also every reminder made before repeat existed), weekly on daysOfWeek (0 = Sunday), or once on date.
 * - startDate / endDate bound the days; skips drop one day ("YYYY-MM-DD") or one time ("YYYY-MM-DD@HH:MM").
 */
import type { ISaheliReminder } from "../models/saheliReminder.model";

export type ScheduleShape = Pick<
    ISaheliReminder,
    "kind" | "times" | "windowStartMinutes" | "windowEndMinutes" | "repeat" | "date" | "daysOfWeek" | "startDate" | "endDate" | "skips"
>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const isDay = (s: unknown): s is string => typeof s === "string" && DAY_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function addDays(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

export function weekdayOf(day: string): number {
    return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function hhmm(mins: number): string {
    const m = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function minutesOf(t: string): number | null {
    const m = /^(\d{1,2}):(\d{2})$/.exec((t || "").trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/** "HH:MM" from "7:30", "19:30", "07:30" (data only; people's words are read by the brain, never here). */
export function normalTime(t: unknown): string | null {
    const m = typeof t === "string" ? minutesOf(t) : null;
    return m === null ? null : hhmm(m);
}

/** May the reminder go out on this day at all (day pattern and bounds; the window's own day for windows)? */
export function runsOn(r: ScheduleShape, day: string): boolean {
    if (r.startDate && day < r.startDate) return false;
    if (r.endDate && day > r.endDate) return false;
    const repeat = r.repeat || "daily";
    if (repeat === "once") return r.date === day;
    if (repeat === "weekly") return (r.daysOfWeek ?? []).includes(weekdayOf(day));
    return true;
}

function windowHours(r: ScheduleShape): { before: number[]; after: number[] } {
    const start = r.windowStartMinutes;
    const end = r.windowEndMinutes;
    if (start == null || end == null) return { before: [], after: [] };
    const first = Math.ceil(start / 60) * 60;
    if (start <= end) {
        const before: number[] = [];
        for (let m = first; m <= end; m += 60) before.push(m);
        return { before, after: [] };
    }
    const before: number[] = [];
    for (let m = first; m < 1440; m += 60) before.push(m);
    const after: number[] = [];
    for (let m = 0; m <= end; m += 60) after.push(m);
    return { before, after };
}

/** Every time it is scheduled on this calendar day, sorted ("HH:MM"), before skips. */
export function slotsOn(r: ScheduleShape, day: string): string[] {
    const out = new Set<string>();
    if (r.kind === "hourly_window") {
        const { before, after } = windowHours(r);
        if (runsOn(r, day)) before.forEach((m) => out.add(hhmm(m)));
        if (after.length && runsOn(r, addDays(day, -1))) after.forEach((m) => out.add(hhmm(m)));
    } else if (runsOn(r, day)) {
        for (const t of r.times ?? []) {
            const n = normalTime(t);
            if (n) out.add(n);
        }
    }
    return [...out].sort();
}

export function isSkipped(r: Pick<ScheduleShape, "skips">, day: string, time: string): boolean {
    const skips = r.skips ?? [];
    return skips.includes(day) || skips.includes(`${day}@${time}`);
}

/** The next time it goes out at or after (day, minute), skips left out; null when it never will again. */
export function nextOccurrence(r: ScheduleShape, day: string, minute: number, horizonDays = 400): { day: string; time: string } | null {
    for (let i = 0; i <= horizonDays; i++) {
        const d = addDays(day, i);
        if (r.endDate && d > r.endDate && !(r.kind === "hourly_window" && d === addDays(r.endDate, 1))) return null;
        for (const t of slotsOn(r, d)) {
            if (i === 0 && (minutesOf(t) ?? 0) < minute) continue;
            if (!isSkipped(r, d, t)) return { day: d, time: t };
        }
        if ((r.repeat || "daily") === "once" && r.date && d > addDays(r.date, 1)) return null;
    }
    return null;
}

/** Has it nothing left to send after (day, minute)? (A once reminder that went out, a reminder past its end date.) */
export function isFinished(r: ScheduleShape, day: string, minute: number): boolean {
    return nextOccurrence(r, day, minute, 400) === null;
}

export function dayLabel(day: string, today?: string): string {
    if (today && day === today) return "today";
    if (today && day === addDays(today, 1)) return "tomorrow";
    const d = new Date(`${day}T00:00:00Z`);
    return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`;
}

/** The schedule in plain English for Saheli and the dashboard: "Every day at 19:30", "Every hour 14:00–03:00". */
export function describe(r: ScheduleShape): string {
    const repeat = r.repeat || "daily";
    let when: string;
    if (r.kind === "hourly_window") {
        when = `every hour ${hhmm(r.windowStartMinutes ?? 0)}–${hhmm(r.windowEndMinutes ?? 0)}`;
    } else {
        const ts = (r.times ?? []).map((t) => normalTime(t)).filter((t): t is string => Boolean(t)).sort();
        when = ts.length > 4 ? `${ts.length} times a day, ${span(ts)}` : `at ${ts.join(", ")}`;
    }
    let days: string;
    if (repeat === "once") days = r.date ? `Once on ${dayLabel(r.date)}` : "Once";
    else if (repeat === "weekly") {
        const ds = [...new Set(r.daysOfWeek ?? [])].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        days = ds.length ? ds.map((d) => WEEKDAY[d]).join(", ") : "Weekly";
    } else days = "Every day";
    const many = r.kind !== "hourly_window" && (r.times ?? []).length > 4;
    const text = repeat === "daily" && r.kind === "hourly_window" ? `Every hour ${when.slice("every hour ".length)}`
        : repeat === "daily" && many ? `${when.charAt(0).toUpperCase()}${when.slice(1)}`
            : `${days} ${when}`;
    const until = r.endDate ? ` until ${dayLabel(r.endDate)}` : "";
    const from = r.startDate && repeat !== "once" ? ` from ${dayLabel(r.startDate)}` : "";
    return `${text}${from}${until}`;
}

/** "14:00 to 03:00" for times that run on across midnight: the run starts after the longest gap between them. */
function span(sorted: string[]): string {
    const mins = sorted.map((t) => minutesOf(t) ?? 0);
    let start = 0;
    let gap = -1;
    for (let i = 0; i < mins.length; i++) {
        const next = i + 1 < mins.length ? mins[i + 1] : mins[0] + 1440;
        if (next - mins[i] > gap) {
            gap = next - mins[i];
            start = (i + 1) % mins.length;
        }
    }
    const end = (start + mins.length - 1) % mins.length;
    return `${hhmm(mins[start])} to ${hhmm(mins[end])}`;
}

export type ScheduleInput = {
    times?: unknown;
    repeat?: unknown;
    date?: unknown;
    days?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    windowStart?: unknown;
    windowEnd?: unknown;
};

/**
 * Check a schedule given as data (from Saheli's tool fields or the dashboard). Returns the fields to store, or the
 * problem to tell the person. today = IST day it is being set.
 */
export function readSchedule(input: ScheduleInput, today: string):
    | { ok: true; fields: Partial<ISaheliReminder> }
    | { ok: false; error: string } {
    const repeat = input.repeat === undefined || input.repeat === null || input.repeat === "" ? "daily" : String(input.repeat);
    if (!["daily", "weekly", "once"].includes(repeat)) return { ok: false, error: "repeat must be daily, weekly or once" };
    const fields: Partial<ISaheliReminder> = { repeat: repeat as ISaheliReminder["repeat"] };
    const hasWindow = input.windowStart !== undefined && input.windowStart !== null && input.windowStart !== "";
    if (hasWindow) {
        const ws = normalTime(input.windowStart);
        const we = normalTime(input.windowEnd);
        if (!ws || !we) return { ok: false, error: "an hourly reminder needs a start and an end time (HH:MM)" };
        if (ws === we) return { ok: false, error: "the hourly window needs different start and end times" };
        fields.kind = "hourly_window";
        fields.windowStartMinutes = minutesOf(ws)!;
        fields.windowEndMinutes = minutesOf(we)!;
        fields.times = [];
    } else {
        const raw = Array.isArray(input.times) ? input.times : typeof input.times === "string" ? [input.times] : [];
        const times = [...new Set(raw.map((t) => normalTime(t)).filter((t): t is string => Boolean(t)))].sort();
        if (!times.length) return { ok: false, error: "at least one time (HH:MM) is needed" };
        if (times.length > 24) return { ok: false, error: "at most 24 times a day" };
        fields.kind = "multi_time";
        fields.times = times;
    }
    if (repeat === "once") {
        if (!isDay(input.date)) return { ok: false, error: "a once reminder needs its date (YYYY-MM-DD)" };
        if (input.date < today) return { ok: false, error: "that date has already gone" };
        fields.date = input.date;
    }
    if (repeat === "weekly") {
        const days = (Array.isArray(input.days) ? input.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (!days.length) return { ok: false, error: "a weekly reminder needs its days" };
        fields.daysOfWeek = [...new Set(days)].sort();
    }
    for (const [key, field] of [["startDate", "startDate"], ["endDate", "endDate"]] as const) {
        const v = input[key];
        if (v === undefined || v === null || v === "") continue;
        if (!isDay(v)) return { ok: false, error: `${key} must be YYYY-MM-DD` };
        fields[field] = v;
    }
    if (fields.endDate && fields.endDate < today) return { ok: false, error: "the end date has already gone" };
    if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) return { ok: false, error: "the end date is before the start" };
    return { ok: true, fields };
}
