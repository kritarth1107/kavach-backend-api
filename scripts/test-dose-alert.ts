/**
 * The dose alert to the Kavach team (trust plan B1.5): a dose not sent within 5 minutes of its time → one email; a failed
 * receipt → an email; sent but not delivered after 30 minutes → an email; a held slot (already marked taken, quiet hours)
 * → no email; several slots in the same tick → one email; each slot once; an admin alert row each time.
 * Resend and Meta are faked (no email or message reaches anyone). The DB checks need TEST_MONGODB_URI.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-dose-alert.ts
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

const emails: Array<{ subject: string; text: string; to: string[] }> = [];
// Resend is faked below, so the email path may run here (real email otherwise goes only from production)
process.env.EMAIL_SEND = "on";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("api.resend.com")) {
        emails.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ id: `email-${emails.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: "wamid.X" }] }), { status: 200 });
    return realFetch(url as string, init);
}) as typeof fetch;

const T0 = new Date("2026-10-14T08:00:00+05:30"); // the dose time
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

async function pure() {
    console.log("pure");
    const { doseAlertReason } = await import("../src/services/deliveryReport.service");
    const slot = (extra: Record<string, unknown>) => ({ state: "scheduled", dueAt: T0, medicine: true, ...extra }) as Parameters<typeof doseAlertReason>[0];
    await ok("not sent at +5 min alerts; at +4 it does not yet (its retries are at +1 and +3)", () => {
        assert.equal(doseAlertReason(slot({}), min(4)), null);
        assert.match(doseAlertReason(slot({}), min(6))!, /not sent within 5 minutes/);
        assert.match(doseAlertReason(slot({ state: "missed", reason: "never attempted" }), min(6))!, /not sent within 5 minutes/);
    });
    await ok("a failure alerts at once, with its reason", () => {
        assert.match(doseAlertReason(slot({ state: "failed", reason: "WhatsApp 131026 Message undeliverable" }), min(1))!, /failed: WhatsApp 131026/);
    });
    await ok("sent but not on the phone after 30 minutes alerts; delivered, read and held never do", () => {
        assert.equal(doseAlertReason(slot({ state: "sent", sentAt: T0 }), min(29)), null);
        assert.match(doseAlertReason(slot({ state: "sent", sentAt: T0 }), min(31))!, /not delivered it to the phone after 30 minutes/);
        assert.equal(doseAlertReason(slot({ state: "delivered", sentAt: T0, deliveredAt: min(1) }), min(60)), null);
        assert.equal(doseAlertReason(slot({ state: "read", sentAt: T0 }), min(60)), null);
        assert.equal(doseAlertReason(slot({ state: "held", reason: "already marked taken" }), min(60)), null);
    });
    await ok("only medicines, and never a test number's simulated send", () => {
        assert.equal(doseAlertReason(slot({ medicine: false }), min(60)), null);
        assert.equal(doseAlertReason(slot({ test: true }), min(60)), null);
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: DueSlot } = await import("../src/models/dueSlot.model");
    const { default: OpsAlertLog } = await import("../src/models/opsAlertLog.model");
    const { default: Family } = await import("../src/models/family.model");
    const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
    const { runDoseAlertCheck } = await import("../src/services/deliveryReport.service");
    const { resetOpsAlerts } = await import("../src/services/opsAlert.service");
    const L = await import("../src/services/deliveryLedger.service");
    const { default: User } = await import("../src/models/users.model");
    await User.create({ userId: "elder-a", firstName: "Asha Devi", lastName: "Test", email: "asha-a@world.kavach.test", passwordHash: "x" });
    await Family.create({ familyId: "fam-dose-alert-1", name: "Alert test", createdBy: "cg", members: [
        { userId: "elder-a", role: "CARE_RECIPIENT", status: "JOINED" },
        { userId: "cg", role: "PRIMARY_CAREGIVER", status: "JOINED" },
    ] });
    const make = (key: string, extra: Record<string, unknown> = {}) => DueSlot.create({
        slotKey: key, dateKey: "2026-10-14", familyId: "fam-dose-alert-1", recipientUserId: "elder-a", kind: "dose", refId: key, title: "Metformin 500 mg",
        time: "08:00", dueAt: T0, medicine: true, state: "scheduled", ...extra,
    });

    await ok("a dose not sent at +5 min → one email with family short id, first name, medicine, time, reason, attempts", async () => {
        resetOpsAlerts();
        emails.length = 0;
        await make("dose:a1:2026-10-14");
        assert.equal((await runDoseAlertCheck(min(4))).alerted, 0);
        const out = await runDoseAlertCheck(min(6));
        assert.equal(out.alerted, 1);
        assert.equal(out.emailed, true);
        assert.equal(emails.length, 1);
        const e = emails[0]!;
        assert.match(e.subject, /Asha, Metformin 500 mg at 08:00/);
        assert.match(e.text, /family fam-dose · Asha · Metformin 500 mg at 08:00 · not sent within 5 minutes of its time · 0 attempts/);
        assert.ok(!e.text.includes("Devi") && !e.text.includes("Test")); // first name only
        assert.deepEqual(e.to, ["kritarth@kavach.care"]);
        const row = await OpsAlertLog.findOne({ kind: "dose" }).lean();
        assert.ok(row && row.emailed && row.items.length === 1);
    });
    await ok("each slot alerts once (the next tick sends nothing)", async () => {
        emails.length = 0;
        assert.equal((await runDoseAlertCheck(min(7))).alerted, 0);
        assert.equal(emails.length, 0);
    });
    await ok("a held slot (already marked taken) never alerts; it shows in the report instead", async () => {
        emails.length = 0;
        await make("dose:a2:2026-10-14", { state: "held", reason: "already marked taken" });
        assert.equal((await runDoseAlertCheck(min(30))).alerted, 0);
        assert.equal(emails.length, 0);
    });
    await ok("several slots in the same tick → one email", async () => {
        emails.length = 0;
        await make("dose:a3:2026-10-14");
        await make("dose:a4:2026-10-14", { state: "failed", reason: "send_failed: Meta 500" });
        await make("dose:a5:2026-10-14", { state: "sent", sentAt: T0, wamid: "wamid.slow" });
        const out = await runDoseAlertCheck(min(40));
        assert.equal(out.alerted, 3);
        assert.equal(emails.length, 1);
        assert.match(emails[0]!.subject, /3 dose reminders did not reach the phone/);
        assert.match(emails[0]!.text, /failed: send_failed/);
        assert.match(emails[0]!.text, /not delivered it to the phone after 30 minutes/);
    });
    await ok("a second dose problem inside 15 minutes is kept for the next note, not a second email", async () => {
        emails.length = 0;
        await make("dose:a3b:2026-10-14", { time: "08:40" });
        const out = await runDoseAlertCheck(min(45));
        assert.equal(out.alerted, 1);
        assert.equal(out.emailed, false);
        assert.equal(emails.length, 0);
        const row = await OpsAlertLog.findOne({ kind: "dose", emailed: false }).lean();
        assert.ok(row);
    });
    await ok("a failed WhatsApp receipt on a sent dose → the slot fails → an email at once", async () => {
        emails.length = 0;
        await make("dose:a6:2026-10-14", { state: "sent", sentAt: min(0), wamid: "wamid.R6" });
        await MessageDelivery.create({ wamid: "wamid.R6", phone: "919000000401", kind: "dose_reminder", refId: "dose:a6:2026-10-14", status: "sent", sentAt: min(0) });
        await L.applyStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.R6", status: "failed", timestamp: String(Math.floor(min(1).getTime() / 1000)),
            recipient_id: "919000000401", errors: [{ code: 131026, title: "Message undeliverable" }] }] } }] }] });
        const slot = await DueSlot.findOne({ slotKey: "dose:a6:2026-10-14" }).lean();
        assert.equal(slot!.state, "failed");
        assert.match(slot!.reason!, /WhatsApp 131026 Message undeliverable/);
        const out = await runDoseAlertCheck(min(2));
        assert.equal(out.alerted, 1);
        assert.match(emails[0]!.text, /failed: WhatsApp 131026/);
    });
    await ok("a delivered receipt moves the slot on, and it never alerts", async () => {
        emails.length = 0;
        await make("dose:a7:2026-10-14", { state: "sent", sentAt: min(0), wamid: "wamid.R7" });
        await MessageDelivery.create({ wamid: "wamid.R7", phone: "919000000401", kind: "dose_reminder", refId: "dose:a7:2026-10-14", status: "sent", sentAt: min(0) });
        await L.applyStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.R7", status: "delivered", timestamp: String(Math.floor(min(1).getTime() / 1000)), recipient_id: "919000000401" }] } }] }] });
        assert.equal((await DueSlot.findOne({ slotKey: "dose:a7:2026-10-14" }).lean())!.state, "delivered");
        assert.equal((await runDoseAlertCheck(min(90))).alerted, 0);
        // a follow-up's receipt (same slot, kind dose_followup) never changes the slot
        await MessageDelivery.create({ wamid: "wamid.F7", phone: "919000000401", kind: "dose_followup", refId: "dose:a7:2026-10-14", status: "sent", sentAt: min(20) });
        await L.applyStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.F7", status: "read", timestamp: String(Math.floor(min(21).getTime() / 1000)), recipient_id: "919000000401" }] } }] }] });
        assert.equal((await DueSlot.findOne({ slotKey: "dose:a7:2026-10-14" }).lean())!.state, "delivered");
    });
    await ok("a test number's simulated send counts as delivered and never alerts", async () => {
        const { noteDueSent } = await import("../src/services/dueList.service");
        await make("dose:a8:2026-10-14");
        await noteDueSent("dose:a8:2026-10-14", { wamid: "mock.wamid.123", at: min(0) });
        const s = await DueSlot.findOne({ slotKey: "dose:a8:2026-10-14" }).lean();
        assert.equal(s!.state, "delivered");
        assert.equal(s!.test, true);
        assert.equal((await runDoseAlertCheck(min(90))).alerted, 0);
    });
    await mongoose.disconnect();
}

void (async () => {
    await pure();
    const uri = testDbUri("dose_alert");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
