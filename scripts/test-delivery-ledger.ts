/**
 * The delivery ledger (trust plan B1.1–B1.3): every WhatsApp message we send has a row with its wamid; WhatsApp's own
 * receipts (sent, delivered, read, failed) update it, in any order; a receipt for a wamid we never sent is ignored; the
 * reminder ledger and the dashboard read WhatsApp's word; the engine gets the wamid back and can ask how far it got.
 * Meta is faked (no message reaches anyone). Pure checks always; the DB checks need TEST_MONGODB_URI.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-delivery-ledger.ts
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

/** Meta's Graph API and the engine, faked: every send is recorded and gets a wamid; failNext makes the next send fail. */
const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
const events: Array<Record<string, unknown>> = [];
let failNext: { status: number; body: unknown } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("graph.facebook.com")) {
        if (failNext) {
            const f = failNext;
            failNext = null;
            return new Response(JSON.stringify(f.body), { status: f.status, headers: { "Content-Type": "application/json" } });
        }
        sent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.L${sent.length}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/v2/events")) {
        events.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ recorded: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("/v2/brain/compose-reminder")) return new Response(JSON.stringify({ text: null }), { status: 200, headers: { "Content-Type": "application/json" } });
    return realFetch(url as string, init);
}) as typeof fetch;

const status = (id: string, s: string, atSec: number, extra: Record<string, unknown> = {}) => ({
    entry: [{ changes: [{ value: { statuses: [{ id, status: s, timestamp: String(atSec), recipient_id: "919000000301", ...extra }] } }] }],
});

async function pure() {
    console.log("pure");
    const L = await import("../src/services/deliveryLedger.service");
    const t = (s: number) => new Date(1_760_000_000_000 + s * 1000);
    await ok("receipts move a message forward: sent → delivered → read", () => {
        let row: Parameters<typeof L.mergeReceipt>[0] = { status: "sent" };
        row = L.mergeReceipt(row, { status: "sent", at: t(1) });
        assert.equal(row.status, "sent");
        row = L.mergeReceipt(row, { status: "delivered", at: t(2) });
        assert.equal(row.status, "delivered");
        assert.equal(row.deliveredAt!.getTime(), t(2).getTime());
        row = L.mergeReceipt(row, { status: "read", at: t(9) });
        assert.equal(row.status, "read");
        assert.equal(row.readAt!.getTime(), t(9).getTime());
    });
    await ok("out of order: a read before its delivered still ends read, with delivered set (read implies delivered)", () => {
        let row: Parameters<typeof L.mergeReceipt>[0] = { status: "sent" };
        row = L.mergeReceipt(row, { status: "read", at: t(9) });
        assert.equal(row.status, "read");
        assert.equal(row.deliveredAt!.getTime(), t(9).getTime());
        row = L.mergeReceipt(row, { status: "delivered", at: t(2) });
        assert.equal(row.status, "read");
        assert.equal(row.deliveredAt!.getTime(), t(2).getTime()); // the earlier, truer time wins
        row = L.mergeReceipt(row, { status: "sent", at: t(1) });
        assert.equal(row.status, "read");
    });
    await ok("a failure is recorded with its code; a failure after delivery stays delivered (the phone had it)", () => {
        const failed = L.mergeReceipt({ status: "sent" }, { status: "failed", at: t(3), errorCode: 131047, errorTitle: "Re-engagement message" });
        assert.equal(failed.status, "failed");
        assert.equal(failed.errorCode, 131047);
        const after = L.mergeReceipt({ status: "delivered", deliveredAt: t(2) }, { status: "failed", at: t(3), errorCode: 131000 });
        assert.equal(after.status, "delivered");
    });
    await ok("Meta's status entries are read: wamid, status, time, error, recipient", () => {
        const r = L.parseStatuses(status("wamid.X", "failed", 1_760_000_100, { errors: [{ code: 131047, title: "Re-engagement message" }] }));
        assert.equal(r.length, 1);
        assert.equal(r[0]!.wamid, "wamid.X");
        assert.equal(r[0]!.errorCode, 131047);
        assert.equal(r[0]!.at.getTime(), 1_760_000_100_000);
        assert.equal(r[0]!.recipient, "919000000301");
        assert.deepEqual(L.parseStatuses({ entry: [{ changes: [{ value: { messages: [{ id: "x" }] } }] }] }), []);
        assert.deepEqual(L.parseStatuses(null), []);
    });
    await ok("the best of several (a message split in parts) and the engine's kinds", async () => {
        assert.equal(L.bestStatus([{ status: "sent" }, { status: "read" }, { status: "failed" }]), "read");
        assert.equal(L.bestStatus([]), null);
        const { engineDeliveryKind } = await import("../src/services/careMemorySync.service");
        assert.equal(engineDeliveryKind("nudge"), "nudge");
        assert.equal(engineDeliveryKind("checkin"), "checkin");
        assert.equal(engineDeliveryKind("reply"), "message"); // only the engine's own kinds
        assert.equal(engineDeliveryKind(undefined), "message");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
    await MessageDelivery.syncIndexes();
    const L = await import("../src/services/deliveryLedger.service");
    const W = await import("../src/services/whatsappWindow.service");
    const { deliverOutboundMessage } = await import("../src/services/channelOutbound.service");
    const PHONE = "+919000000301";
    await W.noteInbound(PHONE, new Date()); // their chat is open
    const base = { familyId: "fam-l", recipientUserId: "elder-l", channel: "whatsapp" as const, channelIdentifier: PHONE, purpose: "proactive" as const };

    const kinds = ["dose_reminder", "dose_followup", "reminder", "nudge", "checkin", "alert", "brief", "message"] as const;
    await ok("every kind of send gets a row with its wamid, kind, slot, reader and who it is about", async () => {
        for (const kind of kinds) {
            const d = await deliverOutboundMessage({ ...base, content: `a ${kind}`, delivery: { kind, refId: `ref-${kind}`, attempt: 1 } });
            assert.equal(d.delivered, true);
            const row = await MessageDelivery.findOne({ wamid: d.messageIds![0] }).lean();
            assert.ok(row, `row for ${kind}`);
            assert.equal(row!.kind, kind);
            assert.equal(row!.refId, `ref-${kind}`);
            assert.equal(row!.status, "sent");
            assert.equal(row!.familyId, "fam-l");
            assert.equal(row!.toUserId, "elder-l");
            assert.equal(row!.phone, "919000000301");
            assert.ok(row!.sentAt);
        }
        // a caregiver alert: read by the caregiver, about the elder
        const d = await deliverOutboundMessage({ ...base, toUserId: "son-l", purpose: "alert", content: "an alert" });
        const row = await MessageDelivery.findOne({ wamid: d.messageIds![0] }).lean();
        assert.equal(row!.kind, "alert");
        assert.equal(row!.toUserId, "son-l");
        assert.equal(row!.aboutUserId, "elder-l");
    });
    await ok("a send with no context (a direct send) is still recorded, as a message; a reply context records replies", async () => {
        const { sendViaMetaWhatsApp } = await import("../src/clients/metaWhatsApp.client");
        const [id] = await sendViaMetaWhatsApp(PHONE, "direct");
        assert.equal((await MessageDelivery.findOne({ wamid: id }).lean())!.kind, "message");
        const [rid] = await L.withDelivery({ kind: "reply", replyTo: "919000000301" }, () => sendViaMetaWhatsApp(PHONE, "an answer"));
        assert.equal((await MessageDelivery.findOne({ wamid: rid }).lean())!.kind, "reply");
    });
    await ok("a message that goes as several WhatsApp messages is one row per part; only the first is part 0", async () => {
        const d = await deliverOutboundMessage({ ...base, content: "two parts", delivery: { kind: "checkin", refId: "long" },
            whatsappPayloads: [{ type: "text", text: { body: "first part" } }, { type: "text", text: { body: "second part" } }] });
        assert.equal(d.messageIds!.length, 2);
        const rows = await MessageDelivery.find({ refId: "long" }).sort({ createdAt: 1 }).lean();
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.part ?? 0, 0);
        assert.equal(rows[1]!.part, 1);
    });

    let wamid = "";
    await ok("receipts update the row by wamid: sent, delivered, read", async () => {
        const d = await deliverOutboundMessage({ ...base, content: "Metformin time", delivery: { kind: "dose_reminder", refId: "dose:s1:2026-10-14" } });
        wamid = d.messageIds![0]!;
        const now = Math.floor(Date.now() / 1000);
        assert.deepEqual(await L.applyStatuses(status(wamid, "sent", now)), { updated: 1, unknown: 0, closed: 0 }); // the first receipt
        assert.equal((await MessageDelivery.findOne({ wamid }).lean())!.status, "sent");
        assert.ok((await MessageDelivery.findOne({ wamid }).lean())!.receiptAt);
        assert.deepEqual(await L.applyStatuses(status(wamid, "sent", now)), { updated: 0, unknown: 0, closed: 0 }); // a repeat changes nothing
        assert.equal((await L.applyStatuses(status(wamid, "delivered", now + 2))).updated, 1);
        assert.equal((await MessageDelivery.findOne({ wamid }).lean())!.status, "delivered");
        assert.equal((await L.applyStatuses(status(wamid, "read", now + 60))).updated, 1);
        const row = await MessageDelivery.findOne({ wamid }).lean();
        assert.equal(row!.status, "read");
        assert.equal(row!.readAt!.getTime(), (now + 60) * 1000);
    });
    await ok("out of order in the database too: read first, then delivered, ends read", async () => {
        const d = await deliverOutboundMessage({ ...base, content: "x", delivery: { kind: "reminder" } });
        const id = d.messageIds![0]!;
        const now = Math.floor(Date.now() / 1000);
        await L.applyStatuses(status(id, "read", now + 30));
        await L.applyStatuses(status(id, "delivered", now + 5));
        const row = await MessageDelivery.findOne({ wamid: id }).lean();
        assert.equal(row!.status, "read");
        assert.equal(row!.deliveredAt!.getTime(), (now + 5) * 1000);
    });
    await ok("a failed receipt records the error; 131047 also closes their window", async () => {
        const d = await deliverOutboundMessage({ ...base, content: "x", delivery: { kind: "nudge" } });
        const id = d.messageIds![0]!;
        const out = await L.applyStatuses(status(id, "failed", Math.floor(Date.now() / 1000), { errors: [{ code: 131047, title: "Re-engagement message" }] }));
        assert.equal(out.updated, 1);
        assert.equal(out.closed, 1);
        const row = await MessageDelivery.findOne({ wamid: id }).lean();
        assert.equal(row!.status, "failed");
        assert.equal(row!.errorCode, 131047);
        assert.equal(await W.windowOpen(PHONE), false);
        await W.noteInbound(PHONE, new Date(Date.now() + 1000)); // they write again: open
    });
    await ok("a receipt for a wamid we never sent is ignored (no row is made)", async () => {
        const before = await MessageDelivery.countDocuments({});
        const out = await L.applyStatuses(status("wamid.NOT_OURS", "delivered", Math.floor(Date.now() / 1000)));
        assert.equal(out.unknown, 1);
        assert.equal(out.updated, 0);
        assert.equal(await MessageDelivery.countDocuments({}), before);
        assert.equal(await MessageDelivery.countDocuments({ wamid: "wamid.NOT_OURS" }), 0);
    });
    await ok("a receipt that beats its row (Meta faster than our insert) is applied when the row is written", async () => {
        L.resetEarlyReceipts();
        await L.applyStatuses(status("wamid.EARLY", "delivered", Math.floor(Date.now() / 1000)));
        await L.withDelivery({ kind: "checkin" }, () => L.recordSent({ wamid: "wamid.EARLY", phone: PHONE }));
        assert.equal((await MessageDelivery.findOne({ wamid: "wamid.EARLY" }).lean())!.status, "delivered");
    });
    await ok("a send Meta refuses is a failed row with Meta's code, never delivered", async () => {
        failNext = { status: 400, body: { error: { message: "Recipient phone number not in allowed list", code: 131030 } } };
        const d = await deliverOutboundMessage({ ...base, content: "x", delivery: { kind: "dose_reminder", refId: "dose:refused" } });
        assert.equal(d.delivered, false);
        const rows = await MessageDelivery.find({ refId: "dose:refused" }).lean();
        assert.equal(rows.length, 1); // recorded once, not twice
        assert.equal(rows[0]!.status, "failed");
        assert.equal(rows[0]!.errorCode, 131030);
        assert.equal(rows[0]!.wamid, undefined);
    });
    await ok("a template to a closed chat is a row too, marked as the template", async () => {
        const T = await import("../src/services/whatsappTemplates.service");
        T.setTemplateCatalogForTest(["kavach_care_reminder|en"]);
        const CLOSED = "+919000000302";
        await W.noteInbound(CLOSED, new Date(Date.now() - 30 * 3_600_000));
        const d = await deliverOutboundMessage({ ...base, channelIdentifier: CLOSED, content: "x", delivery: { kind: "dose_reminder", refId: "dose:tpl" },
            template: { purpose: "reminder", params: ["Metformin", "8:00 AM"], lang: "en" } });
        assert.equal(d.via, "template");
        const row = await MessageDelivery.findOne({ wamid: d.messageIds![0] }).lean();
        assert.equal(row!.viaTemplate, true);
        assert.equal(row!.template, "kavach_care_reminder");
        assert.equal(row!.kind, "dose_reminder");
    });

    await ok("the reminder ledger links to it: the wamid, and WhatsApp's own delivered and read", async () => {
        const { default: SaheliNudgeLog } = await import("../src/models/saheliNudgeLog.model");
        const { claimNudgeAttempt, finalizeNudgeAttempt } = await import("../src/services/saheliNudgeAttempt.service");
        const nudgeId = (await claimNudgeAttempt({ familyId: "fam-l", recipientUserId: "elder-l", scheduleId: "s9", dateKey: "2026-10-14", nudgeKind: "dose_due" }, "Metformin"))!;
        const d = await deliverOutboundMessage({ ...base, content: "Metformin", delivery: { kind: "dose_reminder", refId: "dose:s9:2026-10-14", nudgeId } });
        await finalizeNudgeAttempt(nudgeId, { delivered: true, channel: "whatsapp", wamid: d.messageIds![0] });
        let log = await SaheliNudgeLog.findOne({ nudgeId }).lean();
        assert.equal(log!.wamid, d.messageIds![0]);
        assert.equal(log!.deliveryStatus, "sent");
        const now = Math.floor(Date.now() / 1000);
        await L.applyStatuses(status(d.messageIds![0]!, "delivered", now + 3));
        log = await SaheliNudgeLog.findOne({ nudgeId }).lean();
        assert.equal(log!.deliveryStatus, "delivered");
        assert.ok(log!.deliveredAt);
        await L.applyStatuses(status(d.messageIds![0]!, "read", now + 40));
        log = await SaheliNudgeLog.findOne({ nudgeId }).lean();
        assert.equal(log!.deliveryStatus, "read");
        assert.equal(log!.delivered, true); // the slot stays sent: nothing resends it
        // the engine's reminder event carries the wamid
        await new Promise((r) => setTimeout(r, 50));
        const ev = events.find((e) => (e.payload as { scheduleId?: string } | undefined)?.scheduleId === "s9");
        assert.equal((ev?.payload as { wamid?: string } | undefined)?.wamid, d.messageIds![0]);
    });
    await ok("a held-back slot is not a send: no delivery status; a failed send is failed", async () => {
        const { default: SaheliNudgeLog } = await import("../src/models/saheliNudgeLog.model");
        const { claimNudgeAttempt, finalizeNudgeAttempt } = await import("../src/services/saheliNudgeAttempt.service");
        const held = (await claimNudgeAttempt({ familyId: "fam-l", recipientUserId: "elder-l", scheduleId: "s10", dateKey: "2026-10-14", nudgeKind: "dose_due" }, "x"))!;
        await finalizeNudgeAttempt(held, { delivered: false, channel: "whatsapp", reason: "gated:active_flow" });
        assert.equal((await SaheliNudgeLog.findOne({ nudgeId: held }).lean())!.deliveryStatus, undefined);
        const failed = (await claimNudgeAttempt({ familyId: "fam-l", recipientUserId: "elder-l", scheduleId: "s11", dateKey: "2026-10-14", nudgeKind: "dose_due" }, "x"))!;
        await finalizeNudgeAttempt(failed, { delivered: false, channel: "whatsapp", reason: "send_failed" });
        assert.equal((await SaheliNudgeLog.findOne({ nudgeId: failed }).lean())!.deliveryStatus, "failed");
    });

    await ok("the engine's send gets the wamid back, labelled with its kind and ref; delivery_status reads the receipts", async () => {
        const User = (await import("../src/models/users.model")).default;
        const Family = (await import("../src/models/family.model")).default;
        await User.create({ userId: "u-eng", firstName: "Asha", email: "asha-l@world.kavach.test", passwordHash: "x", phone: { countryCode: "+91", number: "9000000303" }, phoneKey: "+919000000303" });
        await Family.create({ familyId: "fam-eng", name: "Ledger test", createdBy: "u-eng", members: [{ userId: "u-eng", role: "PRIMARY_CAREGIVER", status: "JOINED", name: "Asha" }] });
        await W.noteInbound("+919000000303", new Date());
        const { executeSaheliTool } = await import("../src/services/saheliTools.service");
        const res = (await executeSaheliTool({ tool: "send_whatsapp", args: { to: "u-eng", text: "How was the walk?", kind: "nudge", ref: "nudge:42" },
            familyId: "fam-eng", recipientUserId: "u-eng", actorUserId: "u-eng" })) as { delivered: boolean; wamid?: string; wamids?: string[] };
        assert.equal(res.delivered, true);
        assert.ok(res.wamid?.startsWith("wamid."));
        const row = await MessageDelivery.findOne({ wamid: res.wamid }).lean();
        assert.equal(row!.kind, "nudge");
        assert.equal(row!.refId, "nudge:42");
        await L.applyStatuses(status(res.wamid!, "read", Math.floor(Date.now() / 1000)));
        const st = (await executeSaheliTool({ tool: "delivery_status", args: { wamids: [res.wamid, "wamid.unknown"] },
            familyId: "fam-eng", recipientUserId: "u-eng", actorUserId: "u-eng" })) as { messages: Array<{ wamid: string; status: string; readAt?: string }> };
        assert.equal(st.messages.length, 1);
        assert.equal(st.messages[0]!.status, "read");
        assert.ok(st.messages[0]!.readAt);
    });

    await ok("the dashboard's reminder day shows WhatsApp's ticks for a sent reminder", async () => {
        const User = (await import("../src/models/users.model")).default;
        const Family = (await import("../src/models/family.model")).default;
        const { default: SaheliReminder } = await import("../src/models/saheliReminder.model");
        const { default: SaheliNudgeLog } = await import("../src/models/saheliNudgeLog.model");
        await User.create({ userId: "u-rem", firstName: "Ravi", email: "ravi-l@world.kavach.test", passwordHash: "x", phone: { countryCode: "+91", number: "9000000304" }, phoneKey: "+919000000304" });
        await Family.create({ familyId: "fam-rem", name: "Ticks", createdBy: "u-rem", members: [{ userId: "u-rem", role: "PRIMARY_CAREGIVER", status: "JOINED", name: "Ravi" }] });
        await SaheliReminder.create({ reminderId: "rem-t", familyId: "fam-rem", recipientUserId: "u-rem", text: "Walk", kind: "multi_time", times: ["09:00"],
            repeat: "daily", status: "active", createdBy: "u-rem", createdAt: new Date("2026-10-01T00:00:00Z") });
        await SaheliNudgeLog.create({ nudgeId: "n-t", familyId: "fam-rem", recipientUserId: "u-rem", scheduleId: "reminder:rem-t:09:00", dateKey: "2026-10-14",
            nudgeKind: "pre_reminder", delivered: true, channel: "whatsapp", attempts: 1, wamid: "wamid.T", deliveryStatus: "read" });
        const { remindersForDay } = await import("../src/services/saheliReminder.service");
        const day = await remindersForDay({ familyId: "fam-rem", recipientUserId: "u-rem", actorUserId: "u-rem", day: "2026-10-14", now: new Date("2026-10-14T12:00:00+05:30") });
        const occ = day.occurrences.find((o) => o.time === "09:00");
        assert.equal(occ?.status, "sent");
        assert.equal(occ?.delivery, "read");
    });
    await mongoose.disconnect();
}

void (async () => {
    await pure();
    const uri = testDbUri("delivery_ledger");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
