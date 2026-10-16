/**
 * The daily score's backend side (trust plan C1, C2): the `delivery_day` host tool (the day's due slots with WhatsApp's
 * receipts, check 1), the `team_report` host tool (the 08:00 email and a failing nightly), and the admin "Daily score"
 * routes (masked by default; quotes only with break-glass access).
 *
 *   npx tsx scripts/test-quality.ts            (the DB part needs TEST_MONGODB_URI=mongodb://127.0.0.1:27017/x)
 */
process.env.NODE_ENV = "test";
process.env.ENGINE_URL = "";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { testDbUri } from "./test-db";

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        console.log(`ok - ${name}`);
    } catch (e) {
        failed++;
        console.error(`FAIL - ${name}\n  ${(e as Error).stack}`);
    }
}

async function main() {
    const { fromDueSlot, deliveryDay } = await import("../src/services/deliveryDay.service");
    const { maskPage, maskFailure, qualityRoutes } = await import("../src/admin/routes/quality");
    const due = new Date("2026-10-13T02:30:00Z");

    await t("a due slot becomes one check-1 slot: dose, receipts, held and failed", () => {
        const base = { slotKey: "dose:s1:2026-10-13", dateKey: "2026-10-13", familyId: "f1", recipientUserId: "u1", refId: "s1", title: "Metformin 500 mg", time: "08:00", dueAt: due, medicine: true };
        const sent = fromDueSlot({ ...base, kind: "dose", state: "delivered", sentAt: new Date(due.getTime() + 30_000), deliveredAt: new Date(due.getTime() + 40_000) }, "Kamla");
        assert.equal(sent.kind, "dose_reminder");
        assert.equal(sent.person, "Kamla");
        assert.ok(sent.sentAt && sent.deliveredAt && !sent.held && !sent.error);
        const held = fromDueSlot({ ...base, kind: "dose", state: "held", reason: "done" });
        assert.equal(held.held, true);
        assert.equal(held.heldReason, "done");
        const failedSlot = fromDueSlot({ ...base, kind: "reminder", state: "failed", reason: "no_template" });
        assert.equal(failedSlot.kind, "reminder");
        assert.equal(failedSlot.error, "no_template");
        assert.ok(failedSlot.failedAt);
    });

    await t("the page is masked: first names, no quotes without break-glass", () => {
        const page = {
            failures: [{ check: "replies", family: "abcd1234", person: "Kamla Devi", what: "wrong_name", words: "Maa, dawai lo" },
                       { check: "reminders", family: "abcd1234", person: "Kamla Devi", what: "not sent", item: "Metformin" }],
            memory: [{ family: "abcd1234", score: 80, unknowns: ["Kamla Devi: diet"], failures: [{ part: "used", problems: ["used 'Maa'"], person: "Kamla Devi" }] }],
            today: { remembered: { value: 90, detail: { invented: [{ words: "x" }] } } },
            world: { latest: { scores: { judge: { overall: { pct: 96 } }, examples: [{ text: "probe" }] } } },
        };
        const masked = maskPage(page, false) as any;
        assert.equal(masked.failures[0].person, "Kamla D.");
        assert.equal(masked.failures[0].words, undefined);
        assert.equal(masked.failures[1].item, undefined);
        assert.equal(masked.memory[0].failures[0].problems, undefined);
        assert.equal(masked.memory[0].unknowns[0], "Kamla D.: diet");
        assert.equal(masked.today.remembered.detail.invented, undefined);
        assert.equal(masked.world.latest.scores.examples, undefined);
        assert.equal(masked.world.latest.scores.judge.overall.pct, 96);
        const open = maskPage(page, true) as any;
        assert.equal(open.failures[0].words, "Maa, dawai lo");
        assert.equal(maskFailure({ person: "Asha" }, false).person, "Asha");
    });

    await t("routes: the page needs overview.read, calibration needs break-glass, labels are writes", () => {
        const defs = qualityRoutes();
        const by = Object.fromEntries(defs.map((d) => [`${d.method} ${d.path}`, d]));
        assert.equal(by["get /quality/daily-score"].perm, "overview.read");
        assert.equal(by["get /quality/calibration"].perm, "care.breakglass");
        assert.equal(by["post /quality/calibration/:id"].perm, "care.breakglass");
        assert.ok(defs.every((d) => d.action.startsWith("quality.")));
    });

    await t("team_report and ops_alert are not emailed (founder 17 Oct: only a crisis emails); delivery_day refuses a bad day", async () => {
        const { setEmailClientForTests } = await import("../src/services/email.service");
        const sent: Array<Record<string, unknown>> = [];
        setEmailClientForTests({ emails: { send: async (m) => { sent.push(m); return { error: null }; } } });
        const { executeSaheliTool } = await import("../src/services/saheliTools.service");
        const report = await executeSaheliTool({ tool: "team_report", args: { subject: "Saheli daily score 2026-10-13: 87%", text: "Overall 87%", html: "<div>87%</div>" },
                                                 familyId: "ops", recipientUserId: "ops", actorUserId: "ops" });
        const ops = await executeSaheliTool({ tool: "ops_alert", args: { subject: "Saved cart step broke on a store", text: "fix the saved step" },
                                              familyId: "ops", recipientUserId: "ops", actorUserId: "ops" });
        assert.deepEqual(report, { sent: false, muted: true, to: 0 });
        assert.deepEqual(ops, { sent: false, muted: true, to: 0 });
        assert.equal(sent.length, 0);
        setEmailClientForTests(null);
        await assert.rejects(() => deliveryDay("13-10-2026"));
    });

    const uri = testDbUri("test_quality");
    if (!uri) {
        console.log("skip - delivery_day on a database (set TEST_MONGODB_URI)");
    } else {
        await t("delivery_day reads the due list (test sends and removed slots left out), else the reminder ledger", async () => {
            await mongoose.connect(uri);
            await mongoose.connection.dropDatabase();
            const { default: DueSlot } = await import("../src/models/dueSlot.model");
            const base = { dateKey: "2026-10-13", familyId: "f1", recipientUserId: "u1", title: "Metformin", time: "08:00", dueAt: due, medicine: true, kind: "dose" };
            await DueSlot.create([{ ...base, slotKey: "a", refId: "s1", state: "read", sentAt: due, deliveredAt: due, readAt: due },
                                  { ...base, slotKey: "b", refId: "s2", state: "held", reason: "done" },
                                  { ...base, slotKey: "c", refId: "s3", state: "sent", test: true },
                                  { ...base, slotKey: "d", refId: "s4", state: "removed" }]);
            const day = await deliveryDay("2026-10-13");
            assert.equal(day.source, "due_slots");
            assert.equal(day.receipts, true);
            assert.deepEqual(day.slots.map((s) => s.refId).sort(), ["a", "b"]);
            const { default: Log } = await import("../src/models/saheliNudgeLog.model");
            await Log.create({ nudgeId: "n1", familyId: "f2", recipientUserId: "u2", scheduleId: "reminder:r1:09:30", dateKey: "2026-10-12", nudgeKind: "dose_due",
                               delivered: true, channel: "whatsapp" });
            const old = await deliveryDay("2026-10-12");
            assert.equal(old.source, "nudge_log");
            assert.equal(old.receipts, false);
            assert.equal(old.slots[0].kind, "reminder");
            assert.equal(old.slots[0].dueAt, "2026-10-12T04:00:00.000Z");
            await mongoose.connection.dropDatabase();
            await mongoose.disconnect();
        });
    }
    if (failed) process.exit(1);
    console.log("all quality checks passed");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
