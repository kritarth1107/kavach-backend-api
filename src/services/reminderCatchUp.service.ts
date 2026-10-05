/**
 * Medicine reminders that never went out: the backend was down or restarting at the minute they were due (a gap in the
 * reminder tick's heartbeat), or the reminder was held back because an order was in progress. Nothing else counts:
 * a dose that simply had no reminder for another reason is not guessed at.
 *
 * - due ≤ 15 min ago → the normal dose reminder, just a little late;
 * - 15–90 min ago → one "a little late" reminder (sent as the missed follow-up, so nothing chases it afterwards);
 * - later than that, or the next dose of the same medicine is under 2 h away → no message (a late one could lead to a
 *   double dose); it is noted for the caregiver on the dashboard and in Saheli's ledger instead;
 * - several at once → one message, never a burst; at most MAX_PER_MESSAGE named.
 */
import type { ScheduleDayItem } from "../types/careScheduleCompletion.types";

export const SMALL_DELAY_MIN = 15;
export const LATE_MAX_MIN = 90;
export const NEXT_DOSE_GAP_MIN = 120;
export const MAX_PER_MESSAGE = 3;

export type CatchUpItem = ScheduleDayItem;
export type CatchUpPlan = { onTime: CatchUpItem[]; late: CatchUpItem[]; tooLate: Array<CatchUpItem & { why: string }> };

const norm = (t: string) => t.toLowerCase().replace(/\d+(\.\d+)?\s*(mg|mcg|ml|iu|units?)?/g, "").replace(/[^a-zऀ-ॿ]+/g, " ").trim();

/** Which past medicine slots with no reminder attempt get one now, and which are only noted. */
export function planCatchUp(input: {
    items: CatchUpItem[];
    nowMinutes: number;
    /** IST minutes of today when each schedule was created, if today (a dose added after its time is not "missed"). */
    createdTodayAt: (item: CatchUpItem) => number | null;
    attempted: Set<string>;
    parse: (t: string) => number | null;
    /** Why this dose's reminder never went out: "down" (in a heartbeat gap), "held" (gate held it back), or null. */
    missedBecause: (item: CatchUpItem) => "down" | "held" | null;
}): CatchUpPlan {
    const plan: CatchUpPlan = { onTime: [], late: [], tooLate: [] };
    const meds = input.items.filter((i) => i.type === "MEDICINE");
    for (const item of meds) {
        if (item.status === "completed" || item.status === "upcoming") continue;
        if (item.markedBy) continue; // someone marked it (taken, skipped, missed): not ours to chase
        if (input.attempted.has(item.scheduleId)) continue;
        if (!input.missedBecause(item)) continue;
        const at = input.parse(item.time);
        if (at == null) continue;
        const since = input.nowMinutes - at;
        if (since <= 2) continue; // the normal dose reminder still covers it
        const created = input.createdTodayAt(item);
        if (created != null && created >= at) continue; // added after its time today: never due, nothing missed
        const nextSame = meds
            .filter((m) => m.scheduleId !== item.scheduleId && norm(m.title) === norm(item.title))
            .map((m) => input.parse(m.time))
            .filter((m): m is number => m != null && m > input.nowMinutes)
            .sort((a, b) => a - b)[0];
        if (nextSame != null && nextSame - input.nowMinutes < NEXT_DOSE_GAP_MIN) {
            plan.tooLate.push({ ...item, why: "the next dose is soon" });
        } else if (since > LATE_MAX_MIN) {
            plan.tooLate.push({ ...item, why: "too late to help" });
        } else if (since <= SMALL_DELAY_MIN) {
            plan.onTime.push(item);
        } else {
            plan.late.push(item);
        }
    }
    return plan;
}

/** One message for the late doses (her language family: Hindi/Hinglish or English). */
export function lateDoseText(items: CatchUpItem[], who: string, hindi: boolean): string {
    const named = items.slice(0, MAX_PER_MESSAGE).map((i) => `${i.title}${i.dosage ? ` ${i.dosage}` : ""} (${i.time})`);
    const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} ${hindi ? "aur" : "and"} ${named[named.length - 1]}` : named[0];
    return hindi
        ? `${who}, maaf kijiye, yaad dilane mein thodi der ho gayi. ${list} — le li? Nahi li ho to abhi le lijiye, par agar le chuki hain to dobara mat lijiye 🙏`
        : `${who}, sorry, this reminder is a little late. ${list} — taken? If not, please take it now; if you already have, don't take it again 🙏`;
}

/** Gaps of more than this between ticks (one a minute) mean the reminders were not running. */
export const GAP_MS = 150_000;
const KEEP_GAPS_MS = 26 * 60 * 60 * 1000;

/** Pure: the heartbeat after a tick at `now` (records a gap when the previous tick is too long ago). */
export function nextHeartbeat(prev: { lastTickAt?: Date | null; gaps?: Array<{ from: Date; to: Date }> } | null, now: Date) {
    const gaps = (prev?.gaps ?? []).filter((g) => now.getTime() - new Date(g.to).getTime() < KEEP_GAPS_MS);
    const last = prev?.lastTickAt ? new Date(prev.lastTickAt) : null;
    if (last && now.getTime() - last.getTime() > GAP_MS) gaps.push({ from: last, to: now });
    return { lastTickAt: now, gaps: gaps.slice(-20) };
}

/** IST date-time of a dose ("2026-10-05", "08:00") → Date. */
export function doseAt(dateKey: string, minutes: number): Date {
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
    const mm = String(minutes % 60).padStart(2, "0");
    return new Date(`${dateKey}T${hh}:${mm}:00+05:30`);
}

export function inGap(gaps: Array<{ from: Date; to: Date }>, when: Date): boolean {
    return gaps.some((g) => new Date(g.from).getTime() < when.getTime() && when.getTime() <= new Date(g.to).getTime());
}
