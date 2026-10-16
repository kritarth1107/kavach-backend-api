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
let wamids = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("graph.facebook.com")) {
        sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {} });
        // every wamid unique (the delivery ledger keeps one row per wamid), even after sent.length is reset
        return new Response(JSON.stringify({ messages: [{ id: `wamid.T${++wamids}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url as string, init);
}) as typeof fetch;

async function pure() {
    console.log("pure");
    const T = await import("../src/services/whatsappTemplates.service");
    await ok("a template is looked up in the reader's language, then Hindi, then English (Odia reads Hindi)", () => {
        assert.deepEqual(T.languageChain("ta"), ["ta", "en", "hi"], "a Tamil reader gets English before Hindi");
        assert.deepEqual(T.languageChain("ur"), ["ur", "en", "hi"]);
        assert.deepEqual(T.languageChain("bn"), ["bn", "hi", "en"]);
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
    await ok("a re-filed update copy is used in the reader's language on the next catalog (15 Oct)", async () => {
        // Hindi was MARKETING, so a Hindi reader got the English Utility copy.
        T.setTemplateCatalogForTest(["kavach_saheli_update_en|en", "kavach_saheli_update_mr|mr"]);
        assert.deepEqual(await T.pickTemplate("update", "hi"), { name: "kavach_saheli_update_en", language: "en" });
        // Meta re-filed the Hindi copy as APPROVED UTILITY. The next catalog read picks it, not English.
        T.setTemplateCatalogForTest(["kavach_saheli_update_hi|hi", "kavach_saheli_update_en|en", "kavach_saheli_update_mr|mr"]);
        assert.deepEqual(await T.pickTemplate("update", "hi"), { name: "kavach_saheli_update_hi", language: "hi" });
        assert.deepEqual(await T.pickTemplate("update", "bn"), { name: "kavach_saheli_update_hi", language: "hi" });
    });
    await ok("every caregiver alert kind that may go on WhatsApp has its own template (15 Oct)", () => {
        assert.equal(T.alertTemplateFor("health_red_flag"), "alert_health");
        assert.equal(T.alertTemplateFor("symptom"), "alert_health");
        assert.equal(T.alertTemplateFor("emergency"), "alert_emergency");
        assert.equal(T.alertTemplateFor("crisis"), "alert_emergency");
        assert.equal(T.alertTemplateFor("nudge_silence"), "alert_noreply");
        assert.equal(T.alertTemplateFor("missed_tasks"), "alert_dose");
        assert.equal(T.alertTemplateFor("lab_alert"), "alert_report");
        assert.equal(T.alertTemplateFor("order_placed"), "alert_order");
        assert.equal(T.alertTemplateFor("elder_share"), "alert_update");
        assert.equal(T.alertTemplateFor("unusual_activity"), "alert_update");
        assert.equal(T.alertTemplateFor(undefined), "alert_update", "an urgent alert without a kind");
        assert.equal(T.alertTemplateFor("care_note"), null, "a kind that never goes on WhatsApp");
        for (const p of ["alert_emergency", "alert_report", "alert_order", "alert_update"] as const) assert.equal(T.TEMPLATE_PARAMS[p], 1);
    });
    await ok("an emergency uses its own template, else the health one; the care-record wordings cover MARKETING languages", async () => {
        T.setTemplateCatalogForTest(["kavach_alert_health_en|en", "kavach_alert_symptom_ta|ta", "kavach_alert_emergency_hi|hi", "kavach_alert_update_en|en", "kavach_alert_medicine_pa|pa"]);
        assert.deepEqual(await T.pickTemplate("alert_emergency", "hi"), { name: "kavach_alert_emergency_hi", language: "hi" });
        assert.deepEqual(await T.pickTemplate("alert_emergency", "ta"), { name: "kavach_alert_symptom_ta", language: "ta" }, "Tamil first");
        assert.deepEqual(await T.pickTemplate("alert_emergency", "en"), { name: "kavach_alert_health_en", language: "en" });
        assert.deepEqual(await T.pickTemplate("alert_health", "ta"), { name: "kavach_alert_symptom_ta", language: "ta" });
        assert.deepEqual(await T.pickTemplate("alert_dose", "pa"), { name: "kavach_alert_medicine_pa", language: "pa" });
        assert.deepEqual(await T.pickTemplate("alert_report", "en"), { name: "kavach_alert_update_en", language: "en" }, "report not approved yet: the flagged-entry wording");
        assert.deepEqual(await T.pickTemplate("alert_order", "gu"), { name: "kavach_alert_update_en", language: "en" });
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

    await ok("a number with no row is closed (B3.1: it has not written since windows were kept); its message opens the chat for 24 hours (a little less)", async () => {
        assert.equal(await W.windowOpen(PHONE, t0), false);
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
    await ok("a nudge to a closed chat with no opener approved yet: never free text; it waits and the ledger says not sent", async () => {
        sent.length = 0;
        const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
        const d = await deliverOutboundMessage({ ...base, purpose: "proactive", content: "How was your walk today?", delivery: { kind: "nudge", refId: "nudge:w1" } });
        assert.equal(d.delivered, false);
        assert.equal(d.reason, "outside_window");
        assert.equal(d.waiting, true);
        assert.equal(sent.length, 0);
        const row = await MessageDelivery.findOne({ refId: "nudge:w1" }).lean();
        assert.equal(row!.status, "failed");
        assert.match(row!.errorTitle!, /^outside_window: waiting for their next message \(no approved template/);
        const w = await W.takeWaiting("elder-w");
        assert.deepEqual(w.map((x) => x.text), ["How was your walk today?"]);
    });
    await ok("no template for it approved yet (Meta still reviewing): never free text either; it waits", async () => {
        sent.length = 0;
        const d = await deliverOutboundMessage({ ...base, toUserId: "son-w", purpose: "proactive", content: "Your ride is booked",
            template: { purpose: "order", params: ["Uber ride", "booked"] } });
        assert.equal(d.delivered, false);
        assert.equal(d.waiting, true);
        assert.equal(sent.length, 0);
        assert.equal((await W.takeWaiting("son-w")).length, 1);
    });
    await ok("the general opener for what has no template: once a day for nudges and check-ins, never twice before they answer", async () => {
        T.setTemplateCatalogForTest(["kavach_saheli_message_hi|hi", "kavach_saheli_update_en|en", "kavach_care_reminder|hi"]);
        const { default: User } = await import("../src/models/users.model");
        await User.create({ userId: "elder-o", firstName: "Asha Rani", email: "asha-o@world.kavach.test", passwordHash: "x" });
        const OPEN_PHONE = "+919000000203";
        await W.noteInbound(OPEN_PHONE, new Date(Date.now() - 30 * 3_600_000));
        const ob = { familyId: "fam-w", recipientUserId: "elder-o", channel: "whatsapp" as const, channelIdentifier: OPEN_PHONE, purpose: "proactive" as const };
        sent.length = 0;
        const d1 = await deliverOutboundMessage({ ...ob, content: "Kaisi hain aap aaj?", delivery: { kind: "checkin" } });
        assert.equal(d1.delivered, true);
        assert.equal(d1.via, "template");
        assert.equal(d1.waiting, true);
        const tpl = sent[0]!.body.template as { name: string; language: { code: string }; components: Array<Record<string, unknown>> };
        assert.equal(tpl.name, "kavach_saheli_update_en"); // the account-update wording (the first was filed marketing)
        assert.deepEqual(tpl.components[0], { type: "body", parameters: [{ type: "text", text: "Asha" }] });
        assert.deepEqual(tpl.components[1], { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "open:waiting" }] });
        // a second nudge the same day: no second opener; it only waits
        sent.length = 0;
        const d2 = await deliverOutboundMessage({ ...ob, content: "Aur haan, paani piya?", delivery: { kind: "nudge" } });
        assert.equal(d2.delivered, false);
        assert.equal(d2.waiting, true);
        assert.equal(sent.length, 0);
        // a free-text alert (no template of its own) before they answered: no second opener either, but the team hears
        const d3 = await deliverOutboundMessage({ ...ob, toUserId: "elder-o", purpose: "alert", content: "A note for you" });
        assert.equal(d3.delivered, false);
        assert.equal(sent.length, 0);
        // they tap "Show message": everything that waited, in order, word for word
        const { deliverWaiting } = await import("../src/controllers/careRecord.controller");
        await W.noteInbound(OPEN_PHONE, new Date());
        const given = await deliverWaiting(OPEN_PHONE);
        assert.deepEqual(given.map((g) => g.text), ["Kaisi hain aap aaj?", "Aur haan, paani piya?", "A note for you"]);
        assert.deepEqual(sent.map((m) => (m.body.text as { body: string }).body), ["Kaisi hain aap aaj?", "Aur haan, paani piya?", "A note for you"]);
        assert.deepEqual(await deliverWaiting(OPEN_PHONE), []); // given once
        // then free chat
        sent.length = 0;
        const d4 = await deliverOutboundMessage({ ...ob, content: "Bahut accha!", delivery: { kind: "message" } });
        assert.equal(d4.delivered, true);
        assert.equal(sent[0]!.body.type, "text");
    });
    await ok("a caregiver alert is never held behind an old opener: a new one goes after 30 minutes (15 Oct)", async () => {
        T.setTemplateCatalogForTest(["kavach_saheli_update_en|en"]);
        const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
        const PHONE = "+919000000206";
        await W.noteInbound(PHONE, new Date(Date.now() - 40 * 3_600_000));
        await MessageDelivery.create({ phone: W.phoneKey(PHONE), familyId: "fam-w", kind: "checkin", template: "kavach_saheli_update_en",
            status: "delivered", sentAt: new Date(Date.now() - 2 * 3_600_000), attempt: 1 });
        const ob = { familyId: "fam-w", recipientUserId: "elder-o", channel: "whatsapp" as const, channelIdentifier: PHONE };
        sent.length = 0;
        // a nudge is still held (the opener went and they have not written)
        const nudge = await deliverOutboundMessage({ ...ob, purpose: "proactive" as const, content: "Paani piya?", delivery: { kind: "nudge" } });
        assert.equal(nudge.delivered, false);
        assert.equal(sent.length, 0);
        // an alert without its own template opens the chat again
        const alert = await deliverOutboundMessage({ ...ob, toUserId: "elder-o", purpose: "alert", content: "Urgent: please call Asha" });
        assert.equal(alert.delivered, true);
        assert.equal(alert.via, "template");
        assert.equal((sent[0]!.body.template as { name: string }).name, "kavach_saheli_update_en");
        // a second alert within 30 minutes waits behind that opener
        sent.length = 0;
        const again = await deliverOutboundMessage({ ...ob, toUserId: "elder-o", purpose: "alert", content: "Another note" });
        assert.equal(again.delivered, false);
        assert.equal(sent.length, 0);
    });
    await ok("more than 8 waiting: all of them, as one summary, newest first", async () => {
        const MANY = "+919000000204";
        for (let i = 1; i <= 10; i++) {
            await W.keepWaiting({ phone: MANY, familyId: "fam-w", toUserId: "elder-m", purpose: "message", text: `message ${i}` });
            await new Promise((r) => setTimeout(r, 3));
        }
        await W.noteInbound(MANY, new Date());
        sent.length = 0;
        const { deliverWaiting } = await import("../src/controllers/careRecord.controller");
        const given = await deliverWaiting(MANY);
        assert.equal(given.length, 10);
        assert.equal(sent.length, 1);
        const body = (sent[0]!.body.text as { body: string }).body;
        assert.ok(body.startsWith("📬 10"));
        assert.ok(body.indexOf("message 10") < body.indexOf("message 1\n") || body.indexOf("message 10") < body.lastIndexOf("message 1"));
        for (let i = 1; i <= 10; i++) assert.ok(body.includes(`message ${i}`), `message ${i} included`);
        assert.deepEqual(W.waitingTexts([{ text: "a", at: new Date().toISOString() }]), ["a"]); // fresh: no time stamp
    });
    await ok("a nudge that waited past its moment is dropped, an alert is still given (live 16 Oct: breakfast at 13:35)", async () => {
        const OLD = "+919000000299";
        const { default: WhatsAppWaiting } = await import("../src/models/whatsappWaiting.model");
        await W.keepWaiting({ phone: OLD, familyId: "fam-w", toUserId: "elder-x", purpose: "update", kind: "nudge", text: "8:30 ho gaye, nashta kiya?" });
        await W.keepWaiting({ phone: OLD, familyId: "fam-w", toUserId: "elder-x", purpose: "alert", kind: "alert", text: "Asha called, please call back" });
        await W.keepWaiting({ phone: OLD, familyId: "fam-w", toUserId: "elder-x", purpose: "update", kind: "nudge", text: "Dopahar ka khana ho gaya?" });
        const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000);
        await WhatsAppWaiting.updateMany({ phone: "919000000299", text: { $in: ["8:30 ho gaye, nashta kiya?", "Asha called, please call back"] } },
            { $set: { createdAt: threeHoursAgo } });
        const given = await W.takeWaitingByPhone(OLD);
        assert.deepEqual(given.map((g) => g.text), ["Asha called, please call back", "Dopahar ka khana ho gaya?"]);
        const dropped = await WhatsAppWaiting.findOne({ phone: "919000000299", text: "8:30 ho gaye, nashta kiya?" }).lean<{ expired?: boolean; deliveredAt?: Date }>();
        assert.equal(dropped?.expired, true);
        assert.ok(dropped?.deliveredAt);
        assert.deepEqual(await W.takeWaitingByPhone(OLD), []);
    });
    await ok("never free text to a closed chat, whichever code path tries it (the Meta client refuses and records it)", async () => {
        const { sendViaMetaWhatsApp } = await import("../src/clients/metaWhatsApp.client");
        const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
        const NEVER = "+919000000205";
        sent.length = 0;
        await assert.rejects(sendViaMetaWhatsApp(NEVER, "hello"), /window is closed/);
        assert.equal(sent.length, 0);
        assert.equal(await MessageDelivery.countDocuments({ phone: "919000000205", status: "failed" }), 1);
        // an answer to the number that just wrote always goes
        const L = await import("../src/services/deliveryLedger.service");
        await L.withDelivery({ kind: "reply", replyTo: "919000000205" }, () => sendViaMetaWhatsApp(NEVER, "hello back"));
        assert.equal(sent.length, 1);
    });
    await ok("a dose reminder with no template approved: waits, failed in the ledger and on the due list, and the team is alerted", async () => {
        T.setTemplateCatalogForTest([]);
        process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_key";
        const { default: DueSlot } = await import("../src/models/dueSlot.model");
        const DOSE = "+919000000206";
        await W.noteInbound(DOSE, new Date(Date.now() - 30 * 3_600_000));
        const due = new Date(Date.now() - 6 * 60_000);
        const { toDateKeyIST } = await import("../src/utils/istTime.util");
        await DueSlot.create({ slotKey: "dose:w-dose:2026-10-14", dateKey: toDateKeyIST(due), familyId: "fam-w", recipientUserId: "elder-d", kind: "dose", refId: "w-dose",
            title: "Metformin", time: "08:00", dueAt: due, medicine: true, state: "scheduled" });
        sent.length = 0;
        const d = await deliverOutboundMessage({ familyId: "fam-w", recipientUserId: "elder-d", channel: "whatsapp", channelIdentifier: DOSE, purpose: "proactive",
            content: "Metformin ka samay", template: { purpose: "reminder", params: ["Metformin", "8:00 AM"] }, delivery: { kind: "dose_reminder", refId: "dose:w-dose:2026-10-14" } });
        assert.equal(d.delivered, false);
        assert.equal(sent.length, 0);
        const { noteDueFailed } = await import("../src/services/dueList.service");
        await noteDueFailed("dose:w-dose:2026-10-14", d.reason ?? "send_failed"); // as the dose sender does
        const { runDoseAlertCheck, doseAlertReason } = await import("../src/services/deliveryReport.service");
        const slot = await DueSlot.findOne({ slotKey: "dose:w-dose:2026-10-14" }).lean();
        assert.match(doseAlertReason(slot!, new Date())!, /failed: outside_window/);
        const out = await runDoseAlertCheck(new Date());
        assert.ok(out.alerted >= 1);
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
