/**
 * WhatsApp's 24-hour window (founder 2026-10-12: "WhatsApp has its limitation of a 24-hour window"): every inbound
 * message notes the number; a send to a closed chat goes as an approved Utility template in the reader's language (the
 * message itself waits for their next message), or not at all when no template fits (a nudge).
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/windowtest NODE_ENV=test npx tsx scripts/test-whatsapp-window.ts
 */
process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_META_PHONE_NUMBER_ID = process.env.WHATSAPP_META_PHONE_NUMBER_ID || "1234567890";
process.env.WHATSAPP_META_ACCESS_TOKEN = process.env.WHATSAPP_META_ACCESS_TOKEN || "test-token";
process.env.WHATSAPP_META_WABA_ID = process.env.WHATSAPP_META_WABA_ID || "999";

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

/** Meta's Graph API, faked: every send is recorded and gets a wamid. */
const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) {
        sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.T${sent.length}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url as string, init);
}) as typeof fetch;

async function pure() {
    console.log("pure");
    const T = await import("../src/services/whatsappTemplates.service");
    await ok("a template is looked up in the reader's language, then Hindi, then English (Odia reads Hindi)", () => {
        assert.deepEqual(T.languageChain("ta"), ["ta", "hi", "en"]);
        assert.deepEqual(T.languageChain("en"), ["en", "hi"]);
        assert.deepEqual(T.languageChain("or"), ["hi", "en"]);
        assert.deepEqual(T.languageChain(undefined), ["en", "hi"]);
    });
    await ok("a language with its own name (filed apart after Meta called the shared one marketing) is tried first", async () => {
        T.setTemplateCatalogForTest(["kavach_care_reminder|hi", "kavach_care_reminder_bn|bn", "kavach_alert_health_ta|ta", "kavach_alert_health_en|en"]);
        assert.deepEqual(await T.pickTemplate("reminder", "bn"), { name: "kavach_care_reminder_bn", language: "bn" });
        assert.deepEqual(await T.pickTemplate("reminder", "mr"), { name: "kavach_care_reminder", language: "hi" });
        assert.deepEqual(await T.pickTemplate("alert_health", "ta"), { name: "kavach_alert_health_ta", language: "ta" });
        assert.deepEqual(await T.pickTemplate("alert_health", "gu"), { name: "kavach_alert_health_en", language: "en" });
        assert.equal(await T.pickTemplate("summary", "hi"), null); // not approved yet: no template
        assert.equal(await T.pickTemplate("alert", "en"), null); // the free-text alert was filed marketing
        // where the first wording of a kind was not filed UTILITY, the reworded alternate in the same language comes first
        T.setTemplateCatalogForTest(["kavach_alert_wellbeing_en|en", "kavach_alert_noreply_hi|hi"]);
        assert.deepEqual(await T.pickTemplate("alert_noreply", "en"), { name: "kavach_alert_wellbeing_en", language: "en" });
        assert.deepEqual(await T.pickTemplate("alert_noreply", "hi"), { name: "kavach_alert_noreply_hi", language: "hi" });
    });
    await ok("each caregiver alert kind has its fixed template; the others have none", () => {
        assert.equal(T.alertTemplateFor("health_red_flag"), "alert_health");
        assert.equal(T.alertTemplateFor("emergency"), "alert_health");
        assert.equal(T.alertTemplateFor("nudge_silence"), "alert_noreply");
        assert.equal(T.alertTemplateFor("missed_tasks"), "alert_dose");
        assert.equal(T.alertTemplateFor("lab_alert"), null);
        assert.equal(T.alertTemplateFor(undefined), null);
    });
    await ok("template params are one short line; the alert line is the first sentence; times read 8:30 PM", () => {
        assert.equal(T.templateParam("a\nb\t c    d"), "a b c d");
        assert.equal(T.templateParam(""), "-");
        assert.ok(T.templateParam("x ".repeat(200)).length <= 120);
        assert.equal(T.headlineOf("*Maa* missed the 8 PM dose. Please call her."), "Maa missed the 8 PM dose");
        assert.equal(T.headlineOf("आज की दवा छूट गई। शाम को पूछूँगी।"), "आज की दवा छूट गई");
        assert.equal(T.clockTime("08:05"), "8:05 AM");
        assert.equal(T.clockTime("20:30"), "8:30 PM");
        assert.equal(T.clockTime("00:15"), "12:15 AM");
        assert.equal(T.clockTime("12:00"), "12:00 PM");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const W = await import("../src/services/whatsappWindow.service");
    const T = await import("../src/services/whatsappTemplates.service");
    const { deliverOutboundMessage } = await import("../src/services/channelOutbound.service");
    const PHONE = "+919000000201";
    const t0 = new Date("2026-10-12T10:00:00Z");

    await ok("a number with no row yet is tried as before; its message opens the chat for 24 hours (a little less)", async () => {
        assert.equal(await W.windowOpen(PHONE, t0), true);
        await W.noteInbound(PHONE, t0);
        assert.equal(await W.windowOpen("919000000201", new Date(t0.getTime() + 23 * 3_600_000)), true);
        assert.equal(await W.windowOpen(PHONE, new Date(t0.getTime() + 24 * 3_600_000 - 60_000)), false);
    });
    await ok("Meta's 'outside the window' failure (131047) closes it until they write again", async () => {
        const body = { entry: [{ changes: [{ value: { statuses: [{ status: "failed", recipient_id: "919000000201", errors: [{ code: 131047 }] }] } }] }] };
        assert.equal(await W.noteStatusFailures(body), 1);
        assert.equal(await W.windowOpen(PHONE, new Date(t0.getTime() + 60_000)), false);
        assert.equal(await W.noteStatusFailures({ entry: [{ changes: [{ value: { statuses: [{ status: "delivered", recipient_id: "919000000201" }] } }] }] }), 0);
        await W.noteInbound(PHONE, new Date(Date.now()));
        assert.equal(await W.windowOpen(PHONE), true);
    });

    T.setTemplateCatalogForTest(["kavach_care_reminder|hi", "kavach_alert_health_hi|hi", "kavach_alert_health_en|en", "kavach_daily_summary|en"]);
    const CLOSED = "+919000000202";
    await W.noteInbound(CLOSED, new Date(Date.now() - 30 * 3_600_000)); // wrote 30 hours ago: closed
    const base = { familyId: "fam-w", recipientUserId: "elder-w", channel: "whatsapp" as const, channelIdentifier: CLOSED };

    await ok("an open chat gets the message itself", async () => {
        sent.length = 0;
        const d = await deliverOutboundMessage({ ...base, channelIdentifier: PHONE, purpose: "proactive", content: "Hello",
            template: { purpose: "alert_health", params: ["Maa"] } });
        assert.equal(d.delivered, true);
        assert.equal(d.via, undefined);
        assert.equal(sent[0]?.body.type, "text");
    });
    await ok("a dose reminder to a closed chat goes as the reminder template in her language, with the same Done button", async () => {
        sent.length = 0;
        const d = await deliverOutboundMessage({ ...base, purpose: "proactive", content: "Maa, Metformin ka samay ho gaya",
            template: { purpose: "reminder", params: ["Metformin 500 mg", "8:00 AM"], lang: "hi", quickReplyPayloads: ["done:sched-1"] } });
        assert.equal(d.delivered, true);
        assert.equal(d.via, "template");
        assert.equal(d.waiting, false); // the template is the reminder: nothing waits
        const tpl = sent[0]!.body.template as { name: string; language: { code: string }; components: Array<Record<string, unknown>> };
        assert.equal(tpl.name, "kavach_care_reminder");
        assert.equal(tpl.language.code, "hi");
        assert.deepEqual(tpl.components[0], { type: "body", parameters: [{ type: "text", text: "Metformin 500 mg" }, { type: "text", text: "8:00 AM" }] });
        assert.deepEqual(tpl.components[1], { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "done:sched-1" }] });
        assert.deepEqual(await W.takeWaiting("elder-w"), []);
    });
    await ok("an alert to a caregiver's closed chat goes as the alert template, and the alert waits for his next message", async () => {
        sent.length = 0;
        const d = await deliverOutboundMessage({ ...base, toUserId: "son-w", purpose: "alert", content: "Maa says her chest hurts.\nPlease call her.",
            template: { purpose: "alert_health", params: ["Maa"], lang: "en" } });
        assert.equal(d.via, "template");
        assert.equal(d.waiting, true);
        const tpl = sent[0]!.body.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> };
        assert.equal(tpl.name, "kavach_alert_health_en");
        assert.deepEqual(tpl.components[0]!.parameters, [{ type: "text", text: "Maa" }]);
        const waiting = await W.takeWaiting("son-w");
        assert.equal(waiting.length, 1);
        assert.equal(waiting[0]!.purpose, "alert_health");
        assert.equal(waiting[0]!.text, "Maa says her chest hurts.\nPlease call her.");
        assert.deepEqual(await W.takeWaiting("son-w"), []); // given once
    });
    await ok("a nudge to a closed chat is not sent (no template fits) and nothing waits", async () => {
        sent.length = 0;
        const d = await deliverOutboundMessage({ ...base, purpose: "proactive", content: "How was your walk today?" });
        assert.equal(d.delivered, false);
        assert.equal(d.reason, "outside_window");
        assert.equal(sent.length, 0);
    });
    await ok("no template for it approved yet (Meta still reviewing): the message itself is tried, as before, and nothing waits", async () => {
        sent.length = 0;
        const d = await deliverOutboundMessage({ ...base, toUserId: "son-w", purpose: "proactive", content: "Your ride is booked",
            template: { purpose: "order", params: ["Uber ride", "booked"] } });
        assert.equal(d.delivered, true);
        assert.equal(d.via, undefined);
        assert.equal(sent[0]?.body.type, "text");
        assert.deepEqual(await W.takeWaiting("son-w"), []);
    });
    await ok("the nightly summary notice is the template or nothing (never a placeholder sent as a message)", async () => {
        const { sendTemplateNotice } = await import("../src/services/channelOutbound.service");
        const notice = { familyId: "fam-w", recipientUserId: "elder-w", toUserId: "son-w", phone: CLOSED, template: { purpose: "summary" as const, params: ["Maa"], lang: "en" } };
        sent.length = 0;
        T.setTemplateCatalogForTest(["kavach_alert_en|en"]);
        assert.deepEqual(await sendTemplateNotice(notice), { sent: false, reason: "no approved template" });
        assert.equal(sent.length, 0);
        T.setTemplateCatalogForTest(["kavach_daily_summary|en"]);
        const out = await sendTemplateNotice(notice);
        assert.deepEqual({ ...out, wamid: undefined }, { sent: true, template: "kavach_daily_summary", wamid: undefined });
        assert.ok(out.wamid?.startsWith("wamid.")); // the engine keeps it (delivery ledger)
        const tpl = sent[0]!.body.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> };
        assert.equal(tpl.name, "kavach_daily_summary");
        assert.equal(tpl.components[0]!.parameters[0]!.text, "Maa");
    });
    await mongoose.disconnect();
}

(async () => {
    await pure();
    const uri = testDbUri("windowtest");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI)");
    console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
