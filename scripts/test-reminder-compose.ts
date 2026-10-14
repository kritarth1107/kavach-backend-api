/**
 * A reminder's words are written when it goes out, from the engine, with the lines already sent for it (founder
 * 2026-10-13: the cigarette reminder repeated the same text every time). A habit with nothing fresh is skipped.
 * A medicine reminder still uses its stored text when the engine is down.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/remcompose NODE_ENV=test npx tsx scripts/test-reminder-compose.ts
 */
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

const calls: Array<Record<string, unknown>> = [];
let engineUp = true;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("/v2/brain/compose-reminder")) {
        if (!engineUp) return new Response("down", { status: 503 });
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push(body);
        return new Response(JSON.stringify({ text: `fresh line ${calls.length}`, fresh: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url as string, init);
}) as typeof fetch;

async function withDb(uri: string) {
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const SaheliNudgeLog = (await import("../src/models/saheliNudgeLog.model")).default;
    const { composeReminderLine, recentReminderLines } = await import("../src/services/saheliReminder.service");
    const base = { familyId: "famC", recipientUserId: "selfC", nudgeKind: "pre_reminder", channel: "whatsapp", attempts: 1, terminal: true };
    const sent = ["Reminder: Deep breath, skip the cigarette", "Lambi saans lo, cigarette ko aaj bhi na bolo", "Shaam ki jeet: ek aur cigarette-free ghanta"];
    const now = Date.now();
    for (const [i, t] of sent.entries()) {
        await SaheliNudgeLog.create({ ...base, scheduleId: `reminder:rem1:18:00`, dateKey: `2026-10-1${i}`, nudgeId: `n${i}`, delivered: true,
                                      messagePreview: t, lastAttemptAt: new Date(now - (sent.length - i) * 3_600_000) });
    }
    await SaheliNudgeLog.create({ ...base, scheduleId: `reminder:rem1:18:00`, dateKey: "2026-10-01", nudgeId: "nold", delivered: true,
                                  messagePreview: "weeks ago", lastAttemptAt: new Date(now - 10 * 24 * 3_600_000) });
    await SaheliNudgeLog.create({ ...base, scheduleId: `reminder:rem1:18:00`, dateKey: "2026-10-09", nudgeId: "nx", delivered: false,
                                  messagePreview: "never delivered", lastAttemptAt: new Date(Date.UTC(2026, 9, 9)) });
    await SaheliNudgeLog.create({ ...base, scheduleId: `reminder:rem2:09:00`, dateKey: "2026-10-12", nudgeId: "ny", delivered: true,
                                  messagePreview: "another reminder", lastAttemptAt: new Date() });

    await ok("the lines already sent for this reminder go to the engine, newest first, without the old label", async () => {
        assert.deepEqual(await recentReminderLines("rem1"), [sent[2], sent[1], "Deep breath, skip the cigarette"]);
    });

    await ok("each send gets a fresh line from the engine, with what it is for and when", async () => {
        const line = await composeReminderLine("famC", "selfC", { reminderId: "rem1", text: "Deep breath, skip the cigarette", aboutKey: null }, "18:00");
        assert.deepEqual(line, { text: "fresh line 1", down: false });
        assert.equal(calls[0].purpose, "Deep breath, skip the cigarette");
        assert.equal(calls[0].at, "18:00");
        assert.equal(calls[0].kind, "reminder");
        assert.deepEqual(calls[0].recent, [sent[2], sent[1], "Deep breath, skip the cigarette"]);
    });

    await ok("a medicine reminder says so (name and dose kept exact by the engine)", async () => {
        await composeReminderLine("famC", "selfC", { reminderId: "rem3", text: "Magnesium glycinate 1 tablet", aboutKey: "medicine:magnesium" }, "23:00");
        assert.equal(calls[1].kind, "medicine");
        assert.equal(calls[1].item, "Magnesium glycinate 1 tablet");
    });

    await ok("the engine down is a writer outage, not an empty line", async () => {
        engineUp = false;
        assert.deepEqual(await composeReminderLine("famC", "selfC", { reminderId: "rem1", text: "Deep breath", aboutKey: null }, "18:00"), { text: null, down: true });
        engineUp = true;
    });
    await mongoose.disconnect();
}

(async () => {
    const { outboundReminderLine } = await import("../src/services/saheliReminder.service");
    const stored = "Every hour is a new victory. Skip this cigarette and keep your streak going!";
    await ok("a habit is skipped when the writer has nothing new; a medicine still sends", async () => {
        assert.equal(outboundReminderLine(null, { text: stored, aboutKey: null }), null);
        assert.equal(outboundReminderLine(`Reminder: ${stored}`, { text: stored, aboutKey: null }), null);
        assert.equal(outboundReminderLine("Still skipping this hour?", { text: stored, aboutKey: null }, ["Still skipping this hour?"]), null);
        assert.equal(outboundReminderLine("Reminder: Still off them this hour?", { text: stored, aboutKey: null }), "Still off them this hour?");
        assert.equal(outboundReminderLine(null, { text: "Ecosprin 75", aboutKey: "medicine:eco" }), "Reminder: Ecosprin 75");
        assert.equal(outboundReminderLine(null, { text: stored, aboutKey: null }, [], true), stored);
        assert.equal(outboundReminderLine(null, { text: stored, aboutKey: null }, [stored], true), null);
        assert.equal(outboundReminderLine(null, { text: "Ecosprin 75", aboutKey: "medicine:eco" }, [], true), "Reminder: Ecosprin 75");
    });
    const uri = testDbUri("remcompose");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI)");
    console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
