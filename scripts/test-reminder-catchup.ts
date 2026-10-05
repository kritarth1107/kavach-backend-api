/** Missed reminders: only doses missed because Kavach was down (or held back during an order) are caught up. */
import { doseAt, inGap, lateDoseText, nextHeartbeat, planCatchUp, type CatchUpItem } from "../src/services/reminderCatchUp.service";
import { parseTimeToMinutes } from "../src/services/careScheduleCompletion.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const item = (id: string, title: string, time: string, extra: Partial<CatchUpItem> = {}): CatchUpItem =>
    ({ scheduleId: id, title, time, type: "MEDICINE", status: "missed", ...extra }) as CatchUpItem;
const m = (hhmm: string) => parseTimeToMinutes(hhmm)!;
const plan = (items: CatchUpItem[], now: string, opts: { down?: string[]; held?: string[]; attempted?: string[]; created?: Record<string, number> } = {}) =>
    planCatchUp({
        items, nowMinutes: m(now), attempted: new Set(opts.attempted ?? []), parse: parseTimeToMinutes,
        createdTodayAt: (i) => opts.created?.[i.scheduleId] ?? null,
        missedBecause: (i) => (opts.down?.includes(i.scheduleId) ? "down" : opts.held?.includes(i.scheduleId) ? "held" : null),
    });

const met = item("s1", "Metformin", "08:00");
ok("a few minutes late (restart) → the normal reminder", plan([met], "08:10", { down: ["s1"] }).onTime.length === 1);
ok("15–90 min late → one late reminder", plan([met], "08:40", { down: ["s1"] }).late.length === 1);
ok("over 90 min → only noted", plan([met], "10:00", { down: ["s1"] }).tooLate[0]?.why === "too late to help");
ok("not missed because of downtime → left alone", JSON.stringify(plan([met], "08:40")) === JSON.stringify({ onTime: [], late: [], tooLate: [] }));
ok("held back during an order → caught up", plan([met], "08:30", { held: ["s1"] }).late.length === 1);
ok("a reminder already went out → left alone", plan([met], "08:40", { down: ["s1"], attempted: ["s1"] }).late.length === 0);
ok("taken → left alone", plan([item("s1", "Metformin", "08:00", { status: "completed" })], "08:40", { down: ["s1"] }).late.length === 0);
ok("marked by someone (skipped/missed) → left alone", plan([item("s1", "Metformin", "08:00", { markedBy: "u1" })], "08:40", { down: ["s1"] }).late.length === 0);
ok("added after its time today → never due", plan([met], "08:40", { down: ["s1"], created: { s1: m("08:20") } }).late.length === 0);
ok("not a medicine → left alone", plan([item("t1", "Walk", "08:00", { type: "TASK" })], "08:40", { down: ["t1"] }).late.length === 0);
const next = item("s2", "Metformin 500 mg", "10:00", { status: "upcoming" });
ok("next dose of the same medicine soon → no late reminder (double-dose risk)",
    plan([met, next], "08:40", { down: ["s1"] }).tooLate[0]?.why === "the next dose is soon", plan([met, next], "08:40", { down: ["s1"] }));
ok("next dose far away → late reminder", plan([met, item("s3", "Metformin", "20:00", { status: "upcoming" })], "08:40", { down: ["s1"] }).late.length === 1);

// one message for several, never a burst; tells them not to take it twice
const two = lateDoseText([met, item("s4", "Thyronorm", "07:30", { dosage: "50 mcg" })], "Kamla ji", true);
ok("one combined message", two.includes("Metformin (08:00)") && two.includes("Thyronorm 50 mcg (07:30)") && two.includes("aur"), two);
ok("warns against a double dose", two.includes("dobara mat lijiye") && lateDoseText([met], "Kamla", false).includes("don't take it again"));
ok("at most 3 named", (lateDoseText([met, met, met, met, met], "K", false).match(/Metformin/g) || []).length === 3);

// heartbeat: a gap is recorded only when ticks stop for over 2.5 minutes
const t = (h: number, mi: number) => new Date(Date.UTC(2026, 9, 5, h - 5, mi - 30)); // IST → UTC
let hb = nextHeartbeat(null, t(8, 0));
ok("first tick: no gap", hb.gaps.length === 0);
hb = nextHeartbeat(hb, t(8, 1));
ok("next minute: no gap", hb.gaps.length === 0);
hb = nextHeartbeat(hb, t(8, 47));
ok("46 min without ticks: one gap", hb.gaps.length === 1);
ok("dose at 08:00 was before the gap", !inGap(hb.gaps, doseAt("2026-10-05", m("08:00"))));
ok("dose at 08:30 fell in the gap", inGap(hb.gaps, doseAt("2026-10-05", m("08:30"))));
const later = nextHeartbeat(hb, new Date(t(8, 47).getTime() + 27 * 3600_000));
ok("old gaps forgotten after a day (the new silence is its own gap)", later.gaps.length === 1 && later.gaps[0].from.getTime() === t(8, 47).getTime(), later.gaps);
ok("IST dose time", doseAt("2026-10-05", m("08:30")).toISOString() === "2026-10-05T03:00:00.000Z");

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
