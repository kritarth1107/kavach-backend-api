/**
 * The WhatsApp webhook is signed by Meta or refused (founder 2026-10-13: "if reminder data is lost or spoofed, nothing
 * else matters"). Run: npx tsx scripts/test-meta-signature.ts
 */
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { metaSignatureStatus, noteRejected, rejectWebhook, resetRejections } from "../src/services/metaSignature.service";
import { alertOps, resetOpsAlerts } from "../src/services/opsAlert.service";

const SECRET = "test-app-secret";
const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "910000000000", text: { body: "hi" } }] } }] }] }));
const sign = (raw: Buffer, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
}

async function main() {
    await t("a body signed with the app secret is ok", () => {
        assert.equal(metaSignatureStatus(SECRET, sign(body), body), "ok");
    });
    await t("a forged signature is bad", () => {
        assert.equal(metaSignatureStatus(SECRET, sign(body, "someone-else"), body), "bad");
    });
    await t("a changed body is bad (the signature covers the raw bytes)", () => {
        const changed = Buffer.from(body.toString().replace("hi", "done:sched-1"));
        assert.equal(metaSignatureStatus(SECRET, sign(body), changed), "bad");
    });
    await t("no header, a malformed header or no raw body is missing", () => {
        assert.equal(metaSignatureStatus(SECRET, undefined, body), "missing");
        assert.equal(metaSignatureStatus(SECRET, "md5=abc", body), "missing");
        assert.equal(metaSignatureStatus(SECRET, sign(body), undefined), "missing");
    });
    await t("a short or long header is bad without throwing", () => {
        assert.equal(metaSignatureStatus(SECRET, "sha256=abc", body), "bad");
    });
    await t("no secret configured is no_secret", () => {
        assert.equal(metaSignatureStatus(undefined, sign(body), body), "no_secret");
        assert.equal(metaSignatureStatus("", sign(body), body), "no_secret");
    });
    await t("enforce refuses everything but ok, and fails closed without a secret", () => {
        assert.equal(rejectWebhook("ok", "enforce"), false);
        for (const s of ["bad", "missing", "no_secret"] as const) assert.equal(rejectWebhook(s, "enforce"), true, s);
    });
    await t("log mode refuses nothing", () => {
        for (const s of ["ok", "bad", "missing", "no_secret"] as const) assert.equal(rejectWebhook(s, "log"), false, s);
    });
    await t("production mode comes from WHATSAPP_META_SIGNATURE", () => {
        const before = process.env.WHATSAPP_META_SIGNATURE;
        process.env.WHATSAPP_META_SIGNATURE = "enforce";
        assert.equal(rejectWebhook("bad"), true);
        process.env.WHATSAPP_META_SIGNATURE = "log";
        assert.equal(rejectWebhook("bad"), false);
        if (before === undefined) delete process.env.WHATSAPP_META_SIGNATURE; else process.env.WHATSAPP_META_SIGNATURE = before;
    });
    await t("ops alerts are throttled per problem and count what was held back", async () => {
        resetOpsAlerts();
        // no RESEND key in tests: the first send fails quietly but still opens the window
        const first = await alertOps("k", "s", "t", { now: 0 });
        assert.equal(first.suppressed, undefined);
        const second = await alertOps("k", "s", "t", { now: 60_000 });
        assert.deepEqual(second, { sent: false, suppressed: 1 });
        const other = await alertOps("other", "s", "t", { now: 60_000 });
        assert.notEqual(other.suppressed, 1);
    });
    await t("a burst of refused calls is noted without throwing", async () => {
        resetRejections();
        resetOpsAlerts();
        for (let i = 0; i < 25; i++) await noteRejected("bad", 1_000 + i);
        await noteRejected("no_secret", 2_000);
    });
    console.log(`\n${passed} passed`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
