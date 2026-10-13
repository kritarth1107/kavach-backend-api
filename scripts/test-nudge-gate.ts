/**
 * Regular nudges (Kavach NUdge's plan §4, 2026-10-13): the engine asks the backend, in one call, what only the backend
 * knows about a person (open chat, pause, a flow in progress, their last message, what went out to them lately), and a
 * reminder's ledger entry carries the line that actually went out.
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-nudge-gate.ts
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

/** The engine, faked: care events pushed to it are recorded. */
const events: Array<Record<string, unknown>> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("/v2/events")) {
        events.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ recorded: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url as string, init);
}) as typeof fetch;

async function pure() {
    console.log("pure");
    const F = await import("../src/services/featureFlags.service");
    await ok("regular nudges are off unless the flag or NUDGE_REGULAR says shadow or on", () => {
        assert.equal(F.regularNudgeMode({}, {}), "off");
        assert.equal(F.regularNudgeMode({ NUDGE_REGULAR: "shadow" }, {}), "shadow");
        assert.equal(F.regularNudgeMode({ NUDGE_REGULAR: "yes" }, {}), "off");
        assert.equal(F.regularNudgeMode({ NUDGE_REGULAR: "shadow" }, { "nudge.regular": "on" }), "on"); // the admin flag wins
        assert.ok(F.validFlagValue("nudge.regular", "shadow") && !F.validFlagValue("nudge.regular", "loud"));
    });
}

async function db(uri: string) {
    console.log("db");
    await mongoose.connect(uri);
    await mongoose.connection.dropDatabase();
    const User = (await import("../src/models/users.model")).default;
    const Family = (await import("../src/models/family.model")).default;
    const WhatsAppWindow = (await import("../src/models/whatsappWindow.model")).default;
    const OutboundMessage = (await import("../src/models/outboundMessage.model")).default;
    const WhatsappSession = (await import("../src/models/whatsappSession.model")).default;
    const F = await import("../src/services/featureFlags.service");
    const { nudgeGate } = await import("../src/services/nudgeGate.service");

    const fam = "fam-nudge-gate";
    await User.create({ userId: "u-elder", firstName: "Asha", email: "asha@world.kavach.test", passwordHash: "x", phone: { countryCode: "+91", number: "9000000101" }, phoneKey: "+919000000101" });
    await User.create({ userId: "u-cg", firstName: "Ravi", email: "ravi@world.kavach.test", passwordHash: "x", phone: { countryCode: "+91", number: "9000000102" }, phoneKey: "+919000000102" });
    await Family.create({ familyId: fam, name: "Gate test", createdBy: "u-cg", members: [
        { userId: "u-elder", role: "CARE_RECIPIENT", status: "JOINED", name: "Asha" },
        { userId: "u-cg", role: "PRIMARY_CAREGIVER", status: "JOINED", name: "Ravi" },
    ] });
    const wroteAt = new Date(Date.now() - 90 * 60_000);
    await WhatsAppWindow.create({ phone: "919000000101", lastInboundAt: wroteAt });
    for (let i = 0; i < 7; i++) {
        await OutboundMessage.create({ messageId: `m${i}`, familyId: fam, recipientUserId: "u-elder", channel: "whatsapp", channelIdentifier: "+919000000101",
            content: `line ${i}`, deliveredAt: new Date(Date.now() - (60 - i) * 60_000) });
    }
    F.setFlagSnapshot({ "nudge.regular": "shadow" });

    await ok("an open chat with nothing in flight: ok, with the mode, their last message and the last 5 that went out, newest first", async () => {
        const g = await nudgeGate(fam, "u-elder");
        assert.equal(g.ok, true, JSON.stringify(g));
        assert.equal(g.reason, null);
        assert.equal(g.mode, "shadow");
        assert.equal(g.window_open, true);
        assert.equal(g.last_inbound_at, wroteAt.toISOString());
        assert.deepEqual(g.last_outbound_preview.map((p) => p.text), ["line 6", "line 5", "line 4", "line 3", "line 2"]);
        assert.equal(g.last_outbound_at, g.last_outbound_preview[0].at);
    });
    await ok("a closed chat (no message from them in 24 h, or never) is not ok: window_closed", async () => {
        const never = await nudgeGate(fam, "u-cg"); // never wrote: no record of a message from them, so no nudge
        assert.deepEqual([never.ok, never.reason, never.window_open], [false, "window_closed", false]);
        await WhatsAppWindow.create({ phone: "919000000102", lastInboundAt: new Date(Date.now() - 30 * 3_600_000) });
        const closed = await nudgeGate(fam, "u-cg");
        assert.equal(closed.ok, false);
        assert.equal(closed.reason, "window_closed");
        assert.deepEqual(closed.last_outbound_preview, []);
    });
    await ok("an order in flight for them is not ok: the flow is named", async () => {
        await WhatsappSession.create({ userId: "u-elder", phone: "919000000101", rideDraft: { phase: "await_choice" }, expiresAt: new Date(Date.now() + 3_600_000) });
        const g = await nudgeGate(fam, "u-elder");
        assert.equal(g.ok, false);
        assert.match(String(g.active_flow), /^active_flow:ride:/);
        await WhatsappSession.deleteMany({ userId: "u-elder" });
    });
    await ok("Saheli paused for the family is not ok, whatever else", async () => {
        F.setFlagSnapshot({ "nudge.regular": "on", "saheli.pausedFamilies": [fam] });
        const g = await nudgeGate(fam, "u-elder");
        assert.deepEqual([g.ok, g.reason, g.paused, g.mode], [false, "paused", true, "on"]);
        F.setFlagSnapshot({});
    });
    await ok("someone who is not in the family gets no phone and is not ok", async () => {
        const g = await nudgeGate(fam, "u-stranger");
        assert.equal(g.ok, false);
        assert.equal(g.reason, "not a family member");
    });
    await ok("a reminder's ledger entry in the engine carries the line that went out, not the stored text", async () => {
        const SaheliNudgeLog = (await import("../src/models/saheliNudgeLog.model")).default;
        const SaheliReminder = (await import("../src/models/saheliReminder.model")).default;
        const { finalizeNudgeAttempt } = await import("../src/services/saheliNudgeAttempt.service");
        await SaheliReminder.create({ reminderId: "rem-gym", familyId: fam, recipientUserId: "u-cg", text: "Get ready for the gym", kind: "multi_time",
            times: ["18:00"], repeat: "daily", status: "active", createdBy: "u-cg", timezone: "Asia/Kolkata", aboutKey: "activity:gym" });
        await SaheliNudgeLog.create({ nudgeId: "att-1", familyId: fam, recipientUserId: "u-cg", nudgeKind: "pre_reminder", channel: "whatsapp",
            scheduleId: "reminder:rem-gym:18:00", dateKey: "2026-10-13", attempts: 1, delivered: false, lastAttemptAt: new Date() });
        events.length = 0;
        await finalizeNudgeAttempt("att-1", { delivered: true, channel: "whatsapp", messagePreview: "Legs day today? Shoes by the door 👟" });
        for (let i = 0; i < 50 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
        const ev = events[0] as { kind?: string; payload?: Record<string, unknown> } | undefined;
        assert.equal(ev?.kind, "reminder_sent");
        assert.equal(ev?.payload?.preview, "Legs day today? Shoes by the door 👟");
        assert.equal(ev?.payload?.custom, true);
        assert.equal(ev?.payload?.aboutKey, "activity:gym"); // the engine asks a gym question, never one about a medicine
    });
    await mongoose.disconnect();
}

(async () => {
    await pure();
    const uri = testDbUri("nudge_gate");
    if (uri) await db(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
