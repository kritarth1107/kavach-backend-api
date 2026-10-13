/**
 * The daily due-vs-sent report (trust plan B1.6; founder D6: the Kavach team email + the admin "Delivery" page): at 23:30
 * IST, once a day, per family and in total: due, sent, delivered, read, held and failed by reason, missed, the on-time
 * rate (doses within 2 minutes, reminders within 15), and every dose that did not reach the phone. First names only.
 * Resend is faked. The DB checks need TEST_MONGODB_URI.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-daily-delivery-report.ts
 */
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

const emails: Array<{ subject: string; text: string; to: string[] }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("api.resend.com")) {
        emails.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ id: "e" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url as string, init);
}) as typeof fetch;

const DAY = "2026-10-14";
const at = (hhmm: string, plusSec = 0) => new Date(new Date(`${DAY}T${hhmm}:00+05:30`).getTime() + plusSec * 1000);

async function pure() {
    console.log("pure");
    const R = await import("../src/services/deliveryReport.service");
    await ok("counts: sent, delivered, read, held and failed by reason, missed, on time, later tonight", () => {
        const c = R.countSlots([
            { kind: "dose", state: "read", dueAt: at("08:00"), sentAt: at("08:00", 30) }, // on time
            { kind: "dose", state: "delivered", dueAt: at("09:00"), sentAt: at("09:03") }, // late (3 min)
            { kind: "reminder", state: "sent", dueAt: at("10:00"), sentAt: at("10:12") }, // on time for a reminder
            { kind: "dose", state: "held", reason: "already marked taken", dueAt: at("11:00") },
            { kind: "dose", state: "held", reason: "quiet hours", dueAt: at("06:00") },
            { kind: "dose", state: "failed", reason: "WhatsApp 131047 Re-engagement message", dueAt: at("12:00") },
            { kind: "reminder", state: "failed", reason: "no WhatsApp number for them", dueAt: at("13:00") },
            { kind: "dose", state: "missed", reason: "never attempted", dueAt: at("14:00") },
            { kind: "dose", state: "scheduled", dueAt: at("23:45") }, // later tonight
            { kind: "dose", state: "removed", dueAt: at("15:00") },
        ], at("23:30"));
        assert.equal(c.due, 8);
        assert.equal(c.sent, 3);
        assert.equal(c.delivered, 2);
        assert.equal(c.read, 1);
        assert.deepEqual(c.held, { "already marked taken": 1, "quiet hours": 1 });
        assert.deepEqual(c.failed, { "chat closed (131047)": 1, "no WhatsApp number for them": 1 });
        assert.equal(c.missed, 1);
        assert.equal(c.onTime, 2);
        assert.equal(c.attemptable, 6);
        assert.equal(c.later, 1);
    });
    await ok("reasons are counted by kind, not by every detail", () => {
        assert.equal(R.reasonBucket("held: active_flow:pharmacy (sent once clear)"), "held");
        assert.equal(R.reasonBucket("send_failed: Meta WhatsApp send failed (500)"), "send_failed");
        assert.equal(R.reasonBucket("WhatsApp 131026 Message undeliverable"), "WhatsApp 131026");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: DueSlot } = await import("../src/models/dueSlot.model");
    const { default: DeliveryReport } = await import("../src/models/deliveryReport.model");
    const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
    const { default: User } = await import("../src/models/users.model");
    const { default: Family } = await import("../src/models/family.model");
    const R = await import("../src/services/deliveryReport.service");
    const { resetOpsAlerts } = await import("../src/services/opsAlert.service");
    await User.create({ userId: "ea", firstName: "Asha Devi", email: "asha-r@world.kavach.test", passwordHash: "x" });
    await User.create({ userId: "eb", firstName: "Gopal", email: "gopal-r@world.kavach.test", passwordHash: "x" });
    await Family.create({ familyId: "famreport-A", name: "A", createdBy: "x", members: [{ userId: "ea", role: "CARE_RECIPIENT", status: "JOINED" }] });
    await Family.create({ familyId: "famreport-B", name: "B", createdBy: "x", members: [{ userId: "eb", role: "PRIMARY_CAREGIVER", status: "JOINED" }] });
    const slot = (familyId: string, who: string, key: string, extra: Record<string, unknown>) => DueSlot.create({
        slotKey: key, dateKey: DAY, familyId, recipientUserId: who, kind: "dose", refId: key, title: "Metformin", time: "08:00", dueAt: at("08:00"),
        medicine: true, state: "scheduled", ...extra,
    });
    await slot("famreport-A", "ea", "a1", { state: "read", sentAt: at("08:00", 20), deliveredAt: at("08:01"), readAt: at("08:05") });
    await slot("famreport-A", "ea", "a2", { time: "20:00", dueAt: at("20:00"), state: "sent", sentAt: at("20:00", 40) });
    await slot("famreport-A", "ea", "a3", { time: "14:00", dueAt: at("14:00"), state: "held", reason: "already marked taken" });
    await slot("famreport-B", "eb", "b1", { title: "Thyronorm", time: "07:00", dueAt: at("07:00"), state: "failed", reason: "WhatsApp 131047 Re-engagement message", attempts: 3 });
    await slot("famreport-B", "eb", "b2", { kind: "reminder", medicine: false, title: "Walk", time: "18:00", dueAt: at("18:00"), state: "delivered", sentAt: at("18:05"), deliveredAt: at("18:06") });
    await slot("famreport-B", "eb", "b3", { title: "Vitamin D", time: "21:00", dueAt: at("21:00"), state: "scheduled" }); // never attempted → missed
    await slot("famreport-B", "eb", "b4", { state: "delivered", test: true }); // a test number: left out
    await MessageDelivery.create({ wamid: "w1", phone: "1", kind: "dose_reminder", status: "read", sentAt: at("08:00"), receiptAt: at("08:01"), createdAt: at("08:00") });
    await MessageDelivery.create({ wamid: "w2", phone: "1", kind: "reply", status: "sent", sentAt: at("09:00"), createdAt: at("09:00") });
    await MessageDelivery.create({ phone: "1", kind: "dose_reminder", status: "failed", errorTitle: "send_failed", createdAt: at("07:00") });

    await ok("before 23:30 nothing is sent", async () => {
        emails.length = 0;
        assert.equal(await R.runDailyDeliveryReport(at("23:29")), null);
        assert.equal(emails.length, 0);
    });
    await ok("at 23:30: one report, saved and emailed to the team, per family and in total", async () => {
        resetOpsAlerts();
        const r = await R.runDailyDeliveryReport(at("23:30"));
        assert.ok(r);
        assert.equal(r!.totals.due, 6);
        assert.equal(r!.totals.sent, 3);
        assert.equal(r!.totals.delivered, 2);
        assert.equal(r!.totals.read, 1);
        assert.equal(r!.totals.missed, 1);
        assert.deepEqual(r!.totals.held, { "already marked taken": 1 });
        assert.deepEqual(r!.totals.failed, { "chat closed (131047)": 1 });
        assert.equal(r!.families.length, 2);
        const a = r!.families.find((f) => f.family === "famrepor" && f.people.includes("Asha"));
        assert.ok(a, JSON.stringify(r!.families));
        assert.deepEqual(r!.ledger, { sends: 2, withWamid: 2, withReceipt: 1, failed: 1 });
        // every dose that did not reach the phone: the one still only "sent", the failed one, the missed one
        assert.deepEqual(r!.notDelivered.map((d) => `${d.person}:${d.medicine}:${d.state}`).sort(), ["Asha:Metformin:sent", "Gopal:Thyronorm:failed", "Gopal:Vitamin D:missed"]);
        assert.equal(emails.length, 1);
        const e = emails[0]!;
        assert.deepEqual(e.to, ["kritarth@kavach.care"]);
        assert.match(e.subject, /Kavach reminders 2026-10-14: 3\/6 sent, 2 delivered, 1 read, 3 doses not delivered/);
        assert.match(e.text, /All families: due 6, sent 3, delivered 2, read 1, missed 1/);
        assert.match(e.text, /on time 3\/5 \(60%\)/);
        assert.match(e.text, /family famrepor · Gopal · Thyronorm at 07:00 · failed \(WhatsApp 131047 Re-engagement message\) · 3 attempts/);
        assert.ok(!e.text.includes("Devi")); // first names only
        const saved = await DeliveryReport.findOne({ dateKey: DAY }).lean();
        assert.ok(saved?.emailedAt);
    });
    await ok("once a day: a later tick (or a second instance) sends nothing", async () => {
        emails.length = 0;
        assert.equal(await R.runDailyDeliveryReport(at("23:31")), null);
        assert.equal(await R.runDailyDeliveryReport(at("23:59")), null);
        assert.equal(emails.length, 0);
        assert.equal(await DeliveryReport.countDocuments({}), 1);
    });
    await ok("the admin page's live view reads without writing (a slot past its time counts as missed anyway)", async () => {
        await DueSlot.create({ slotKey: "c1", dateKey: "2026-10-15", familyId: "famreport-A", recipientUserId: "ea", kind: "dose", refId: "c1", title: "X",
            time: "08:00", dueAt: new Date("2026-10-15T08:00:00+05:30"), medicine: true, state: "scheduled" });
        const r = await R.buildDeliveryReport("2026-10-15", new Date("2026-10-15T09:00:00+05:30"), { readOnly: true });
        assert.equal(r.totals.missed, 1);
        assert.equal((await DueSlot.findOne({ slotKey: "c1" }).lean())!.state, "scheduled");
    });
    await mongoose.disconnect();
}

void (async () => {
    await pure();
    const uri = testDbUri("delivery_report");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
