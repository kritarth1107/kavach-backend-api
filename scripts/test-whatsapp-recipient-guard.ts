/**
 * Unit-style check for the WhatsApp placeholder-recipient guard and the nudge
 * retry policy. No DB, no network: fetch is stubbed and Meta creds are dummies.
 *
 *   npx tsx scripts/test-whatsapp-recipient-guard.ts
 */
import assert from "node:assert/strict";

// Dummy creds BEFORE config loads (dotenv never overrides existing vars).
process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_META_PHONE_NUMBER_ID = "TEST_PHONE_ID";
process.env.WHATSAPP_META_ACCESS_TOKEN = "TEST_TOKEN";

const sentTo: string[] = [];
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    sentTo.push(body.to);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), { status: 200 });
}) as typeof fetch;

async function main() {
    const guard = await import("../src/services/whatsappRecipientGuard.service");
    const client = await import("../src/clients/metaWhatsApp.client");
    const attempt = await import("../src/services/saheliNudgeAttempt.service");

    let passed = 0;
    const ok = (name: string) => {
        passed += 1;
        console.log(`  ✓ ${name}`);
    };

    // --- shape checks ---
    assert.equal(guard.couldBePlaceholderNumber("+999980531439"), true);
    assert.equal(guard.couldBePlaceholderNumber("+998686245770"), true);
    assert.equal(guard.couldBePlaceholderNumber("+919876543210"), false);
    assert.equal(guard.couldBePlaceholderNumber("+14155550123"), false);
    assert.equal(guard.isDefinitelyPlaceholderNumber("+999980531439"), true);
    assert.equal(guard.isDefinitelyPlaceholderNumber("+998686245770"), false);
    ok("placeholder shape detection");

    // --- async guard, no DB needed for these ---
    assert.equal(await guard.isPlaceholderWhatsAppNumber("+999980531439"), true);
    assert.equal(await guard.isPlaceholderWhatsAppNumber("+919876543210"), false);
    assert.equal(await guard.isPlaceholderWhatsAppNumber("918310905372"), false);
    ok("isPlaceholderWhatsAppNumber: +999… blocked, Indian numbers allowed");

    // --- central send layer ---
    await assert.rejects(
        client.sendViaMetaWhatsApp("+999980531439", "hello"),
        (err: unknown) => guard.isWhatsAppPlaceholderRecipientError(err),
    );
    await assert.rejects(
        client.sendMetaWhatsAppTemplate({ to: "+999980531439", templateName: "x", bodyParameters: [] }),
        (err: unknown) => guard.isWhatsAppPlaceholderRecipientError(err),
    );
    assert.equal(sentTo.length, 0, "no HTTP call for placeholder");
    ok("send layer refuses placeholder (text + template) without calling Meta");

    await client.sendViaMetaWhatsApp("+919876543210", "Reminder: BP tablet");
    assert.deepEqual(sentTo, ["919876543210"]);
    ok("send layer still sends to a real Indian number");

    // --- retry policy ---
    const now = new Date("2026-09-25T15:00:00Z");
    const mins = (m: number) => new Date(now.getTime() - m * 60_000);
    const d = attempt.decideNudgeSlot;
    assert.deepEqual(d([], now), { allowed: true });
    assert.equal(d([{ _id: 1, delivered: true, attempts: 1, lastAttemptAt: mins(90) }], now).allowed, false);
    assert.deepEqual(d([{ _id: 1, terminal: true, attempts: 1, lastAttemptAt: mins(90) }], now), {
        allowed: false,
        reason: "terminal",
    });
    assert.deepEqual(d([{ _id: 1, attempts: 1, lastAttemptAt: mins(1) }], now), {
        allowed: false,
        reason: "cooldown",
    });
    assert.deepEqual(d([{ _id: 1, attempts: 1, lastAttemptAt: mins(29) }], now), {
        allowed: false,
        reason: "cooldown",
    });
    assert.deepEqual(d([{ _id: 1, attempts: 1, lastAttemptAt: mins(31) }], now), { allowed: true });
    assert.deepEqual(d([{ _id: 1, attempts: 2, lastAttemptAt: mins(120) }], now), {
        allowed: false,
        reason: "max_attempts",
    });
    // legacy row (no attempts / lastAttemptAt) created a minute ago → cooldown, not resend
    assert.deepEqual(d([{ _id: 1, createdAt: mins(1) }], now), { allowed: false, reason: "cooldown" });
    ok("nudge retry policy: 1 retry max, ≥30 min apart, terminal/delivered stop");

    console.log(`\n${passed} checks passed`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("FAILED:", err);
        process.exit(1);
    });
