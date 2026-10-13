/**
 * The due list and the gaps found in B1 (trust plan B1.4, B1.7):
 *  - every dose and reminder slot of the day, built from the care schedules and the reminders Saheli set, rebuilt when
 *    either changes; held (skipped), removed (deleted), never due (added after its time);
 *  - retries inside the windows: doses at +1 and +3 min, reminders at +2 and +6 min, nothing after;
 *  - catch-up for custom medicine reminders Kavach missed while down (late → one "a little late"; too late → noted);
 *  - the reminder heartbeat: /api/health/reminders answers 503 when the tick is older than 3 minutes, and the backend's
 *    own watchdog emails the team.
 * Meta and Resend are faked. The DB checks need TEST_MONGODB_URI.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-due-list.ts
 */
process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_META_PHONE_NUMBER_ID = process.env.WHATSAPP_META_PHONE_NUMBER_ID || "1234567890";
process.env.WHATSAPP_META_ACCESS_TOKEN = process.env.WHATSAPP_META_ACCESS_TOKEN || "test-token";
process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_key";
process.env.CARE_TEAM_ALERT_TO = "";
process.env.OPS_ALERT_TO = "";

import assert from "node:assert/strict";
import mongoose from "mongoose";
import { testDbUri } from "./test-db";

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
    Promise.resolve()
        .then(fn)
        .then(
            () => {
                passed++;
                console.log(`  ✓ ${name}`);
            },
            (err) => {
                console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack || err.message : err}`);
                process.exitCode = 1;
            },
        );

const emails: Array<{ subject: string; text: string }> = [];
let wamids = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("api.resend.com")) {
        emails.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ id: "e" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: `wamid.D${++wamids}` }] }), { status: 200 });
    if (u.includes("/v2/events")) return new Response(JSON.stringify({ recorded: true }), { status: 200 });
    return realFetch(url as string, init);
}) as typeof fetch;

const DAY = "2026-10-14"; // a Wednesday
const at = (hhmm: string, plusSec = 0) => new Date(new Date(`${DAY}T${hhmm}:00+05:30`).getTime() + plusSec * 1000);

async function pure() {
    console.log("pure");
    const { planDueSlots } = await import("../src/services/dueList.service");
    const base = { scheduleId: "s1", familyId: "f", recipientUserId: "e", title: "Metformin", time: "08:00", dosage: "500 mg" };
    await ok("a medicine at 08:00 is one dose slot today; a weekly one only on its days; one added after its time is not due", () => {
        const slots = planDueSlots({ dateKey: DAY, dayOfWeek: 3, reminders: [], schedules: [
            base,
            { ...base, scheduleId: "s2", daysOfWeek: [1, 5] }, // Mon, Fri
            { ...base, scheduleId: "s3", time: "09:00", createdAt: at("09:30") }, // added after 09:00 today
            { ...base, scheduleId: "s4", time: "21:00", critical: true },
        ] });
        assert.deepEqual(slots.map((s) => s.slotKey), [`dose:s1:${DAY}`, `dose:s4:${DAY}`]);
        assert.equal(slots[0]!.title, "Metformin 500 mg");
        assert.equal(slots[0]!.dueAt.toISOString(), "2026-10-14T02:30:00.000Z");
        assert.equal(slots[1]!.critical, true);
        assert.equal(slots[0]!.medicine, true);
    });
    await ok("a reminder's times are slots; a skipped time is held; a medicine-linked reminder is a medicine", () => {
        const slots = planDueSlots({ dateKey: DAY, dayOfWeek: 3, schedules: [], reminders: [
            { reminderId: "r1", familyId: "f", recipientUserId: "e", text: "Walk", slots: ["07:00", "18:00"], skipped: (t) => t === "18:00" },
            { reminderId: "r2", familyId: "f", recipientUserId: "e", text: "Insulin", aboutKey: "medicine:insulin", slots: ["22:00"], skipped: () => false },
        ] });
        assert.deepEqual(slots.map((s) => [s.slotKey, s.state ?? "scheduled", s.medicine]), [
            [`reminder:r1:07:00:${DAY}`, "scheduled", false], [`reminder:r1:18:00:${DAY}`, "held", false], [`reminder:r2:22:00:${DAY}`, "scheduled", true]]);
    });
    await ok("retries land inside the windows: doses at +1 and +3 min, reminders at +2 and +6, others after 30 min", async () => {
        const A = await import("../src/services/saheliNudgeAttempt.service");
        const t0 = at("08:00");
        const row = (attempts: number, lastSec: number) => [{ _id: 1, delivered: false, attempts, lastAttemptAt: new Date(t0.getTime() + lastSec * 1000) }];
        const dose = A.retryPolicy({ nudgeKind: "dose_due", scheduleId: "s1" });
        assert.deepEqual(A.decideNudgeSlot(row(1, 0), at("08:00", 59), dose), { allowed: false, reason: "cooldown" });
        assert.deepEqual(A.decideNudgeSlot(row(1, 0), at("08:01"), dose), { allowed: true }); // +1
        assert.deepEqual(A.decideNudgeSlot(row(2, 60), at("08:02", 59), dose), { allowed: false, reason: "cooldown" });
        assert.deepEqual(A.decideNudgeSlot(row(2, 60), at("08:03"), dose), { allowed: true }); // +3
        assert.deepEqual(A.decideNudgeSlot(row(3, 180), at("08:04"), dose), { allowed: false, reason: "max_attempts" });
        const rem = A.retryPolicy({ nudgeKind: "pre_reminder", scheduleId: "reminder:r1:08:00" });
        assert.deepEqual(A.decideNudgeSlot(row(1, 0), at("08:01", 59), rem), { allowed: false, reason: "cooldown" });
        assert.deepEqual(A.decideNudgeSlot(row(1, 0), at("08:02"), rem), { allowed: true }); // +2
        assert.deepEqual(A.decideNudgeSlot(row(2, 120), at("08:05", 59), rem), { allowed: false, reason: "cooldown" });
        assert.deepEqual(A.decideNudgeSlot(row(2, 120), at("08:06"), rem), { allowed: true }); // +6
        assert.deepEqual(A.decideNudgeSlot(row(3, 360), at("08:10"), rem), { allowed: false, reason: "max_attempts" });
        const other = A.retryPolicy({ nudgeKind: "missed_followup", scheduleId: "s1" });
        assert.deepEqual(A.decideNudgeSlot(row(1, 0), at("08:29"), other), { allowed: false, reason: "cooldown" });
        assert.deepEqual(A.decideNudgeSlot(row(1, 0), at("08:30"), other), { allowed: true });
        assert.deepEqual(A.decideNudgeSlot(row(2, 1800), at("09:30"), other), { allowed: false, reason: "max_attempts" });
        assert.deepEqual(A.decideNudgeSlot([{ _id: 1, delivered: true }], at("08:05"), dose), { allowed: false, reason: "delivered" });
    });
    await ok("the dose window covers its retries (0–4 min); the follow-up window is unchanged", async () => {
        const { medicineDueWindow } = await import("../src/services/saheliFactGuard.service");
        assert.equal(medicineDueWindow(3, "due"), "dose_due");
        assert.equal(medicineDueWindow(4, "due"), "dose_due");
        assert.equal(medicineDueWindow(5, "due"), null);
        assert.equal(medicineDueWindow(15, "missed"), "followup");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { setClockForTest } = await import("../src/utils/clock.util");
    const { default: DueSlot } = await import("../src/models/dueSlot.model");
    const { default: CareSchedule } = await import("../src/models/careSchedule.model");
    const { default: SaheliReminder } = await import("../src/models/saheliReminder.model");
    const { default: SaheliCompanion } = await import("../src/models/saheliCompanion.model");
    const { default: SaheliNudgeLog } = await import("../src/models/saheliNudgeLog.model");
    const { default: User } = await import("../src/models/users.model");
    const { default: Family } = await import("../src/models/family.model");
    const D = await import("../src/services/dueList.service");
    const FAM = "fam-due";
    await User.create({ userId: "e1", firstName: "Asha", email: "asha-due@world.kavach.test", passwordHash: "x", phone: { countryCode: "+91", number: "9000000501" }, phoneKey: "+919000000501" });
    await Family.create({ familyId: FAM, name: "Due test", createdBy: "c1", members: [{ userId: "e1", role: "CARE_RECIPIENT", status: "JOINED" }, { userId: "c1", role: "PRIMARY_CAREGIVER", status: "JOINED" }] });
    await SaheliCompanion.create({ familyId: FAM, recipientUserId: "e1", enabled: true });
    await CareSchedule.create({ scheduleId: "sd1", familyId: FAM, recipientUserId: "e1", type: "MEDICINE", title: "Metformin", time: "08:00", createdBy: "c1",
        createdAt: new Date("2026-10-01T00:00:00Z") });
    await CareSchedule.create({ scheduleId: "sd2", familyId: FAM, recipientUserId: "e1", type: "MEDICINE", title: "Amlodipine", time: "20:00", createdBy: "c1",
        createdAt: new Date("2026-10-01T00:00:00Z") });
    await CareSchedule.create({ scheduleId: "sd3", familyId: FAM, recipientUserId: "e1", type: "APPOINTMENT", title: "Doctor", time: "11:00", createdBy: "c1" });
    await SaheliReminder.create({ reminderId: "rd1", familyId: FAM, recipientUserId: "e1", text: "Insulin", aboutKey: "medicine:insulin", kind: "multi_time",
        times: ["09:00", "21:00"], repeat: "daily", status: "active", createdBy: "c1", createdAt: new Date("2026-10-01T00:00:00Z") });

    await ok("the day's list: every medicine time and reminder time, nothing else", async () => {
        setClockForTest(at("00:01"));
        D.resetDueListCache();
        assert.equal(await D.ensureDueList(at("00:01")), true);
        const keys = (await DueSlot.find({ dateKey: DAY }).sort({ dueAt: 1 }).lean()).map((s) => s.slotKey);
        assert.deepEqual(keys, [`dose:sd1:${DAY}`, `reminder:rd1:09:00:${DAY}`, `dose:sd2:${DAY}`, `reminder:rd1:21:00:${DAY}`]);
        assert.equal(await D.ensureDueList(at("00:02")), false); // nothing changed: not rebuilt
    });
    await ok("rebuilt within a minute when a schedule changes: a deleted dose is removed, a new one added", async () => {
        await CareSchedule.deleteOne({ scheduleId: "sd2" });
        await CareSchedule.create({ scheduleId: "sd4", familyId: FAM, recipientUserId: "e1", type: "MEDICINE", title: "Thyronorm", time: "07:30", createdBy: "c1",
            createdAt: new Date("2026-10-01T00:00:00Z") });
        assert.equal(await D.ensureDueList(at("00:03")), true);
        assert.equal((await DueSlot.findOne({ slotKey: `dose:sd2:${DAY}` }).lean())!.state, "removed");
        assert.equal((await DueSlot.findOne({ slotKey: `dose:sd4:${DAY}` }).lean())!.state, "scheduled");
    });
    await ok("a slot already sent keeps its state through a rebuild", async () => {
        await D.noteDueSent(`dose:sd1:${DAY}`, { wamid: "wamid.k", attempts: 1, at: at("08:00") });
        await SaheliReminder.updateOne({ reminderId: "rd1" }, { $set: { updatedAt: new Date() } });
        await D.ensureDueList(at("08:05"));
        assert.equal((await DueSlot.findOne({ slotKey: `dose:sd1:${DAY}` }).lean())!.state, "sent");
    });
    await ok("held, failed and missed are recorded with their reasons; sent overrides a hold", async () => {
        await D.noteDueHeld(`dose:sd4:${DAY}`, "already marked taken");
        assert.equal((await DueSlot.findOne({ slotKey: `dose:sd4:${DAY}` }).lean())!.reason, "already marked taken");
        await D.noteDueHeld(`reminder:rd1:09:00:${DAY}`, "held: active_flow:pharmacy (sent once clear)");
        await D.noteDueSent(`reminder:rd1:09:00:${DAY}`, { wamid: "wamid.late", late: true });
        const s = await DueSlot.findOne({ slotKey: `reminder:rd1:09:00:${DAY}` }).lean();
        assert.equal(s!.state, "sent");
        assert.equal(s!.reason, "sent late (catch-up)");
        assert.equal(await D.markMissed(at("22:00")), 1); // the 21:00 reminder never went
        assert.equal((await DueSlot.findOne({ slotKey: `reminder:rd1:21:00:${DAY}` }).lean())!.state, "missed");
    });

    await ok("a slot first listed after its time (the first build after a deploy) takes its state from the reminder ledger and never alerts", async () => {
        const FAM2 = "fam-due-late";
        await User.create({ userId: "e2", firstName: "Gopal", email: "gopal-due@world.kavach.test", passwordHash: "x", phone: { countryCode: "+91", number: "9000000502" }, phoneKey: "+919000000502" });
        await Family.create({ familyId: FAM2, name: "Late build", createdBy: "e2", members: [{ userId: "e2", role: "CARE_RECIPIENT", status: "JOINED" }] });
        await SaheliCompanion.create({ familyId: FAM2, recipientUserId: "e2", enabled: true });
        for (const [id, time] of [["sl1", "06:00"], ["sl2", "06:30"], ["sl3", "23:00"]] as const) {
            await CareSchedule.create({ scheduleId: id, familyId: FAM2, recipientUserId: "e2", type: "MEDICINE", title: "Dose", time, createdBy: "e2",
                createdAt: new Date("2026-10-01T00:00:00Z") });
        }
        await SaheliNudgeLog.create({ nudgeId: "n-sl1", familyId: FAM2, recipientUserId: "e2", scheduleId: "sl1", dateKey: DAY, nudgeKind: "dose_due",
            delivered: true, channel: "whatsapp", attempts: 1, lastAttemptAt: at("06:00"), wamid: "wamid.sl1", deliveryStatus: "read" });
        await D.ensureDueList(at("10:00"));
        const s1 = await DueSlot.findOne({ slotKey: `dose:sl1:${DAY}` }).lean();
        assert.equal(s1!.state, "read");
        assert.ok(s1!.alertedAt);
        const s2 = await DueSlot.findOne({ slotKey: `dose:sl2:${DAY}` }).lean();
        assert.equal(s2!.state, "held");
        assert.equal(s2!.reason, "before tracking began");
        assert.equal((await DueSlot.findOne({ slotKey: `dose:sl3:${DAY}` }).lean())!.state, "scheduled"); // still ahead: watched as usual
        const { runDoseAlertCheck } = await import("../src/services/deliveryReport.service");
        await runDoseAlertCheck(at("10:00"));
        const reasons = (await DueSlot.find({ familyId: FAM2, alertedAt: { $exists: true } }).lean()).map((x) => x.alertReason);
        assert.deepEqual(reasons, ["listed after its time (not alerted)", "listed after its time (not alerted)"]);
    });

    await ok("catch-up: a medicine reminder missed while Kavach was down is sent once, a little late", async () => {
        const { default: HB } = await import("../src/models/schedulerHeartbeat.model");
        // Kavach down 08:50–09:40; the 09:00 insulin reminder fell in the gap and was never attempted
        await HB.updateOne({ _id: "care-nudge" }, { $set: { lastTickAt: at("09:40"), gaps: [{ from: at("08:50"), to: at("09:40") }] } }, { upsert: true });
        await SaheliNudgeLog.deleteMany({});
        await DueSlot.updateOne({ slotKey: `reminder:rd1:09:00:${DAY}` }, { $set: { state: "scheduled" }, $unset: { reason: 1, sentAt: 1 } });
        const { catchUpMedicineReminders } = await import("../src/services/saheliReminder.service");
        const sends: string[] = [];
        const rems = (await SaheliReminder.find({}).lean()) as never[];
        const out = await catchUpMedicineReminders(rems, at("09:41"), async ({ slot }) => {
            sends.push(slot);
            return { delivered: true, wamid: "wamid.catch" };
        });
        assert.deepEqual(out, { late: 1, tooLate: 0 });
        assert.deepEqual(sends, ["09:00"]);
        const log = await SaheliNudgeLog.findOne({ scheduleId: "reminder:rd1:09:00" }).lean();
        assert.equal(log!.delivered, true);
        assert.equal((await DueSlot.findOne({ slotKey: `reminder:rd1:09:00:${DAY}` }).lean())!.reason, "sent late (catch-up)");
        // once: the next tick sends nothing
        assert.deepEqual(await catchUpMedicineReminders(rems, at("09:42"), async () => ({ delivered: true })), { late: 0, tooLate: 0 });
    });
    await ok("catch-up: too late (over 90 min) or the next time near → not sent, noted; not in a gap → left alone", async () => {
        const { default: HB } = await import("../src/models/schedulerHeartbeat.model");
        const { catchUpMedicineReminders } = await import("../src/services/saheliReminder.service");
        await SaheliNudgeLog.deleteMany({});
        const rems = (await SaheliReminder.find({}).lean()) as never[];
        let called = 0;
        const send = async () => { called += 1; return { delivered: true }; };
        // no gap at all: nothing to catch up
        await HB.updateOne({ _id: "care-nudge" }, { $set: { gaps: [] } });
        assert.deepEqual(await catchUpMedicineReminders(rems, at("09:41"), send), { late: 0, tooLate: 0 });
        // down 08:50–11:00: the 09:00 time is now 2 hours late
        await HB.updateOne({ _id: "care-nudge" }, { $set: { gaps: [{ from: at("08:50"), to: at("11:00") }] } });
        assert.deepEqual(await catchUpMedicineReminders(rems, at("11:01"), send), { late: 0, tooLate: 1 });
        assert.equal(called, 0);
        const log = await SaheliNudgeLog.findOne({ scheduleId: "reminder:rd1:09:00" }).lean();
        assert.equal(log!.terminal, true);
        assert.match(log!.reason!, /missed_while_down: too late to help/);
        // down 20:10–20:50 for the 21:00? no: down 20:30–21:30 and now 21:35, next time is tomorrow → late (insulin twice a day)
    });

    await ok("the reminder heartbeat: /api/health/reminders is 200 while the tick runs, 503 when it is older than 3 minutes", async () => {
        const { default: HB } = await import("../src/models/schedulerHeartbeat.model");
        const { getRemindersHealth } = await import("../src/controllers/health.controller");
        const call = async () => {
            let code = 0;
            let body: Record<string, unknown> = {};
            await getRemindersHealth({} as never, { status(c: number) { code = c; return this; }, json(b: Record<string, unknown>) { body = b; return this; } } as never);
            return { code, body };
        };
        await HB.updateOne({ _id: "care-nudge" }, { $set: { lastTickAt: new Date(Date.now() - 60_000) } });
        let r = await call();
        assert.equal(r.code, 200);
        assert.equal(r.body.status, "ok");
        await HB.updateOne({ _id: "care-nudge" }, { $set: { lastTickAt: new Date(Date.now() - 4 * 60_000) } });
        r = await call();
        assert.equal(r.code, 503);
        assert.equal(r.body.status, "stale");
        await HB.deleteOne({ _id: "care-nudge" });
        r = await call();
        assert.equal(r.code, 503);
    });
    await ok("the backend's own watchdog emails the team when the tick stopped (once per 30 min)", async () => {
        const { default: HB } = await import("../src/models/schedulerHeartbeat.model");
        const { checkReminderHeartbeat } = await import("../src/workers/careNudgeScheduler");
        const { resetOpsAlerts } = await import("../src/services/opsAlert.service");
        resetOpsAlerts();
        emails.length = 0;
        await HB.updateOne({ _id: "care-nudge" }, { $set: { lastTickAt: new Date(Date.now() - 60_000) } }, { upsert: true });
        assert.equal((await checkReminderHeartbeat(Date.now(), 0)).alerted, undefined);
        await HB.updateOne({ _id: "care-nudge" }, { $set: { lastTickAt: new Date(Date.now() - 10 * 60_000) } });
        assert.equal((await checkReminderHeartbeat(Date.now(), 0)).alerted, true);
        await checkReminderHeartbeat(Date.now() + 60_000, 0);
        assert.equal(emails.length, 1);
        assert.match(emails[0]!.subject, /Reminders are not running/);
    });
    setClockForTest(null);
    await mongoose.disconnect();
}

void (async () => {
    await pure();
    const uri = testDbUri("due_list");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
