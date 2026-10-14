/**
 * Escalation, end to end on a fake clock (trust plan B2.5a: "fires on time every day", checked on every push). The real
 * scheduler functions run minute by minute: the reminder tick, the care-nudge tick (a critical dose and its follow-up),
 * the engine's sends (a nudge, a check-in, through send_whatsapp), the escalation tick, the 09:00 check.
 *   - reminder, nudge and check-in unanswered → the caregiver's alert at third + 60 min (±1 tick)
 *   - a reply at any point → no alert
 *   - quiet hours → deferred to the morning
 *   - a critical dose → at once, even in quiet hours
 *   - self-care → no family alert (the emergency contact hears, if set; never the person)
 *   - one alert per streak
 *   - the 09:00 check: on time, late, quiet-deferred, missing → "escalations on time x/y", a miss emails the team
 * Meta, Resend and the engine are faked: no message or email reaches anyone. Needs TEST_MONGODB_URI.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-escalation-e2e.ts
 */
process.env.WHATSAPP_PROVIDER = "meta";
process.env.WHATSAPP_META_PHONE_NUMBER_ID = process.env.WHATSAPP_META_PHONE_NUMBER_ID || "1234567890";
process.env.WHATSAPP_META_ACCESS_TOKEN = process.env.WHATSAPP_META_ACCESS_TOKEN || "test-token";
process.env.WHATSAPP_META_WABA_ID = process.env.WHATSAPP_META_WABA_ID || "999";
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

/** Meta, Resend and the engine, faked. */
const wa: Array<{ to: string; body: Record<string, unknown> }> = [];
const emails: Array<{ subject: string; text: string }> = [];
let contacts: Array<{ name: string; phone: string; emergency: boolean }> = [];
let n = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.includes("graph.facebook.com")) {
        if (u.includes("message_templates")) return json({ data: [] });
        wa.push({ to: String(body.to ?? ""), body });
        return json({ messages: [{ id: `wamid.E${++n}` }] });
    }
    if (u.includes("api.resend.com")) {
        emails.push(body);
        return json({ id: "e" });
    }
    if (u.includes("/emergency")) return json({ contacts });
    if (u.includes("/v2/brain/compose-reminder")) return json({ text: `Time for ${body.purpose || "this"}` });
    if (u.includes("/v2/")) return json({ recorded: true });
    return realFetch(url as string, init);
}) as typeof fetch;

const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:30`);
const sentTo = (phone: string) => wa.filter((m) => m.to === phone.replace(/\D/g, ""));

async function main(uri: string) {
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { setClockForTest } = await import("../src/utils/clock.util");
    const { default: User } = await import("../src/models/users.model");
    const { default: Family } = await import("../src/models/family.model");
    const { default: SaheliCompanion } = await import("../src/models/saheliCompanion.model");
    const { default: SaheliReminder } = await import("../src/models/saheliReminder.model");
    const { default: CareSchedule } = await import("../src/models/careSchedule.model");
    const { default: MessageDelivery } = await import("../src/models/messageDelivery.model");
    const { default: Escalation, EscalationCheck } = await import("../src/models/escalation.model");
    const W = await import("../src/services/whatsappWindow.service");
    const { claimWhatsAppInboundMessage } = await import("../src/services/whatsappInboundDedupe.service");
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");
    const { runSaheliReminderTick } = await import("../src/services/saheliReminder.service");
    const { runCareNudgeTick } = await import("../src/services/saheliCareNudge.service");
    const E = await import("../src/services/escalation.service");
    const { resetOpsAlerts } = await import("../src/services/opsAlert.service");
    const T = await import("../src/services/whatsappTemplates.service");
    T.setTemplateCatalogForTest(["kavach_alert_noreply_en|en", "kavach_care_reminder|en"]);

    let seq = 0;
    /** A family: an elder cared for by a caregiver (or a self-care person alone). Synthetic people, test numbers. */
    async function family(tag: string, opts: { selfCare?: boolean } = {}) {
        seq += 1;
        const elder = { id: `elder-${tag}`, phone: `+9190000${String(700 + seq * 2).padStart(5, "0")}` };
        const cg = { id: `cg-${tag}`, phone: `+9190000${String(701 + seq * 2).padStart(5, "0")}` };
        const fid = `fam-esc-${tag}`;
        await User.create({ userId: elder.id, firstName: `Elder${tag}`, email: `${elder.id}@world.kavach.test`, passwordHash: "x",
            phone: { countryCode: "+91", number: elder.phone.slice(3) }, phoneKey: elder.phone });
        const members: Array<Record<string, string>> = [{ userId: elder.id, role: opts.selfCare ? "PRIMARY_CAREGIVER" : "CARE_RECIPIENT", status: "JOINED" }];
        if (!opts.selfCare) {
            await User.create({ userId: cg.id, firstName: `Carer${tag}`, email: `${cg.id}@world.kavach.test`, passwordHash: "x",
                phone: { countryCode: "+91", number: cg.phone.slice(3) }, phoneKey: cg.phone });
            members.push({ userId: cg.id, role: "PRIMARY_CAREGIVER", status: "JOINED" });
        }
        await Family.create({ familyId: fid, name: `Escalation ${tag}`, createdBy: opts.selfCare ? elder.id : cg.id, members });
        await SaheliCompanion.create({ familyId: fid, recipientUserId: elder.id, enabled: true });
        return { fid, elder, cg };
    }
    /** Their message (as the webhook notes it): the window opens and the inbound log keeps the time. */
    async function reply(phone: string, when: Date) {
        setClockForTest(when);
        await claimWhatsAppInboundMessage(`wamid.in.${phone}.${when.getTime()}`, phone);
        await W.noteInbound(phone, when);
    }
    async function engineSend(f: Awaited<ReturnType<typeof family>>, when: Date, kind: "nudge" | "checkin") {
        setClockForTest(when);
        const res = (await executeSaheliTool({ tool: "send_whatsapp", args: { to: f.elder.id, text: `A ${kind} for you`, kind, ref: `${kind}:${when.getTime()}` },
            familyId: f.fid, recipientUserId: f.elder.id, actorUserId: f.elder.id })) as { delivered: boolean };
        assert.equal(res.delivered, true, `${kind} sent`);
    }
    async function tickEvery(from: Date, to: Date, stepMin = 1) {
        for (let t = from.getTime(); t <= to.getTime(); t += stepMin * 60_000) {
            setClockForTest(new Date(t));
            await E.runEscalationTick(new Date(t));
        }
    }
    const alertRows = async (elderId: string) => {
        const keys = (await Escalation.find({ personUserId: elderId }).lean()).map((e) => `escalation:${e.streakKey}`);
        return MessageDelivery.find({ kind: "alert", refId: { $in: keys } }).sort({ sentAt: 1 }).lean();
    };

    const D1 = "2026-10-20";
    const f1 = await family("a");
    await ok("a reminder, a nudge and a check-in unanswered → the caregiver hears at third + 60 min (±1 tick), with what they read", async () => {
        await reply(f1.elder.phone, at(D1, "08:00"));
        await reply(f1.cg.phone, at(D1, "08:00"));
        await SaheliReminder.create({ reminderId: "rem-esc-a", familyId: f1.fid, recipientUserId: f1.elder.id, text: "Morning walk", kind: "multi_time",
            times: ["09:00"], repeat: "daily", status: "active", createdBy: f1.cg.id, createdAt: at(D1, "07:00") });
        setClockForTest(at(D1, "09:00"));
        const r = await runSaheliReminderTick(at(D1, "09:00"));
        assert.equal(r.sent, 1);
        await engineSend(f1, at(D1, "10:00"), "nudge");
        await engineSend(f1, at(D1, "11:00"), "checkin");
        // WhatsApp says she read the check-in
        const checkin = await MessageDelivery.findOne({ toUserId: f1.elder.id, kind: "checkin" }).lean();
        const { applyStatuses } = await import("../src/services/deliveryLedger.service");
        await applyStatuses({ entry: [{ changes: [{ value: { statuses: [{ id: checkin!.wamid, status: "read", timestamp: String(Math.floor(at(D1, "11:05").getTime() / 1000)), recipient_id: "x" }] } }] }] });
        await tickEvery(at(D1, "11:00"), at(D1, "11:59"));
        assert.equal((await alertRows(f1.elder.id)).length, 0, "nothing during the grace");
        await tickEvery(at(D1, "12:00"), at(D1, "12:10"));
        const rows = await alertRows(f1.elder.id);
        assert.equal(rows.length, 1);
        const lag = rows[0]!.sentAt!.getTime() - at(D1, "12:00").getTime();
        assert.ok(lag >= 0 && lag <= 60_000, `alert at third + 60 (lag ${lag} ms)`);
        assert.equal(rows[0]!.phone, f1.cg.phone.replace(/\D/g, "")); // the caregiver, never the elder
        const text = JSON.stringify(sentTo(f1.cg.phone).at(-1)!.body);
        assert.match(text, /hasn't replied to Saheli's last 3 messages/);
        assert.match(text, /1 of them as read/);
        const esc = await Escalation.findOne({ personUserId: f1.elder.id }).lean();
        assert.equal(esc!.state, "sent");
        assert.equal(esc!.seen, 1);
        // the engine can ask (its ladder stops adding to a streak that is escalating)
        const st = (await executeSaheliTool({ tool: "escalation_status", args: { to: f1.elder.id }, familyId: f1.fid, recipientUserId: f1.elder.id,
            actorUserId: f1.elder.id })) as { unanswered: number; state: string };
        assert.deepEqual([st.unanswered, st.state], [3, "sent"]);
        await assert.rejects(executeSaheliTool({ tool: "escalation_status", args: { to: f1.elder.id }, familyId: "fam-not-theirs", recipientUserId: f1.elder.id,
            actorUserId: f1.elder.id })); // only for members of the family asking
    });
    await ok("one alert per streak: more unanswered messages, hours later, no second alert; a reply then a new streak alerts again", async () => {
        await engineSend(f1, at(D1, "13:00"), "nudge");
        await engineSend(f1, at(D1, "14:00"), "checkin");
        await tickEvery(at(D1, "14:00"), at(D1, "16:00"), 5);
        assert.equal((await alertRows(f1.elder.id)).length, 1);
        await reply(f1.elder.phone, at(D1, "16:30"));
        await engineSend(f1, at(D1, "17:00"), "nudge");
        await engineSend(f1, at(D1, "17:30"), "checkin");
        await engineSend(f1, at(D1, "18:00"), "nudge");
        await tickEvery(at(D1, "18:55"), at(D1, "19:05"));
        assert.equal((await alertRows(f1.elder.id)).length, 2);
    });

    const D2 = "2026-10-21";
    const f2 = await family("b");
    await ok("a reply at any point → no alert (after the third, inside the grace; and before the third)", async () => {
        await reply(f2.cg.phone, at(D2, "08:00"));
        await reply(f2.elder.phone, at(D2, "07:00")); // their chat is open (they wrote this morning)
        await engineSend(f2, at(D2, "09:00"), "nudge");
        await engineSend(f2, at(D2, "10:00"), "checkin");
        await engineSend(f2, at(D2, "11:00"), "nudge");
        await tickEvery(at(D2, "11:00"), at(D2, "11:29"), 1);
        await reply(f2.elder.phone, at(D2, "11:30")); // inside the grace
        await tickEvery(at(D2, "11:30"), at(D2, "13:00"), 1);
        assert.equal((await alertRows(f2.elder.id)).length, 0);
        assert.equal((await Escalation.findOne({ personUserId: f2.elder.id }).lean())!.state, "replied");
        // a reply between the second and the third: the count starts again
        await engineSend(f2, at(D2, "14:00"), "nudge");
        await engineSend(f2, at(D2, "15:00"), "checkin");
        await reply(f2.elder.phone, at(D2, "15:30"));
        await engineSend(f2, at(D2, "16:00"), "nudge");
        await tickEvery(at(D2, "16:55"), at(D2, "17:10"), 1);
        assert.equal((await alertRows(f2.elder.id)).length, 0);
        assert.equal(await Escalation.countDocuments({ personUserId: f2.elder.id }), 1);
    });

    const D3 = "2026-10-22";
    const D3b = "2026-10-23";
    const f3 = await family("c");
    await ok("the caregiver's quiet hours (22:00–07:00) → deferred, then sent when they end (±1 tick)", async () => {
        await reply(f3.cg.phone, at(D3, "19:00"));
        await reply(f3.elder.phone, at(D3, "19:00"));
        await engineSend(f3, at(D3, "20:00"), "checkin");
        await engineSend(f3, at(D3, "20:30"), "nudge");
        await engineSend(f3, at(D3, "21:00"), "checkin");
        await tickEvery(at(D3, "21:55"), at(D3, "22:05"));
        assert.equal((await alertRows(f3.elder.id)).length, 0);
        const esc = await Escalation.findOne({ personUserId: f3.elder.id }).lean();
        assert.equal(esc!.state, "deferred");
        assert.match(esc!.reason!, /quiet hours/);
        await tickEvery(at(D3, "22:10"), at(D3b, "06:50"), 20);
        assert.equal((await alertRows(f3.elder.id)).length, 0, "nothing in the night");
        await tickEvery(at(D3b, "06:55"), at(D3b, "07:05"));
        const rows = await alertRows(f3.elder.id);
        assert.equal(rows.length, 1);
        const lag = rows[0]!.sentAt!.getTime() - at(D3b, "07:00").getTime();
        assert.ok(lag >= 0 && lag <= 60_000, `sent at 07:00 (lag ${lag} ms)`);
        assert.equal((await Escalation.findOne({ personUserId: f3.elder.id }).lean())!.reason, "deferred for quiet hours");
    });

    const D4 = "2026-10-24";
    const f4 = await family("d");
    await ok("a critical medicine among them → the alert goes at third + 60 even in quiet hours", async () => {
        await reply(f4.cg.phone, at(D4, "19:00"));
        await reply(f4.elder.phone, at(D4, "19:00"));
        await CareSchedule.create({ scheduleId: "sch-esc-d", familyId: f4.fid, recipientUserId: f4.elder.id, type: "MEDICINE", title: "Insulin", time: "21:00",
            critical: true, createdBy: f4.cg.id, createdAt: at(D4, "08:00") });
        setClockForTest(at(D4, "21:00"));
        await runCareNudgeTick(at(D4, "21:00")); // the dose reminder
        setClockForTest(at(D4, "21:15"));
        await runCareNudgeTick(at(D4, "21:15")); // its follow-up (not marked taken)
        const doseRows = await MessageDelivery.find({ toUserId: f4.elder.id, kind: { $in: ["dose_reminder", "dose_followup"] } }).lean();
        assert.deepEqual(doseRows.map((r) => [r.kind, r.critical]).sort(), [["dose_followup", true], ["dose_reminder", true]]);
        await engineSend(f4, at(D4, "21:20"), "checkin");
        await tickEvery(at(D4, "22:15"), at(D4, "22:25"));
        const rows = await alertRows(f4.elder.id);
        assert.equal(rows.length, 1);
        const lag = rows[0]!.sentAt!.getTime() - at(D4, "22:20").getTime();
        assert.ok(lag >= 0 && lag <= 60_000, `immediately at third + 60 (lag ${lag} ms)`);
        assert.match((await Escalation.findOne({ personUserId: f4.elder.id }).lean())!.reason!, /critical/);
    });

    const D5 = "2026-10-25";
    const f5 = await family("e", { selfCare: true });
    await ok("self-care → no family alert, never to the person; none recorded when there is no emergency contact", async () => {
        contacts = [];
        await reply(f5.elder.phone, at(D5, "08:00"));
        await engineSend(f5, at(D5, "09:00"), "nudge");
        await engineSend(f5, at(D5, "10:00"), "checkin");
        await engineSend(f5, at(D5, "11:00"), "nudge");
        const before = sentTo(f5.elder.phone).length;
        await tickEvery(at(D5, "11:55"), at(D5, "12:10"));
        assert.equal(sentTo(f5.elder.phone).length, before, "nothing more to the person");
        assert.equal((await alertRows(f5.elder.id)).length, 0);
        const esc = await Escalation.findOne({ personUserId: f5.elder.id }).lean();
        assert.equal(esc!.state, "none");
        assert.match(esc!.reason!, /self-care: no caregiver to tell and no emergency contact/);
    });
    await ok("self-care with an emergency contact → the contact hears (by template), never the person", async () => {
        contacts = [{ name: "Neighbour", phone: "+919000000799", emergency: true }];
        await reply(f5.elder.phone, at(D5, "13:00"));
        await engineSend(f5, at(D5, "14:00"), "nudge");
        await engineSend(f5, at(D5, "15:00"), "checkin");
        await engineSend(f5, at(D5, "16:00"), "nudge");
        const before = sentTo(f5.elder.phone).length;
        await tickEvery(at(D5, "16:55"), at(D5, "17:05"));
        assert.equal(sentTo(f5.elder.phone).length, before);
        const toContact = sentTo("+919000000799");
        assert.equal(toContact.length, 1);
        assert.equal((toContact[0]!.body.template as { name: string }).name, "kavach_alert_noreply_en");
        assert.equal((await alertRows(f5.elder.id)).length, 1);
        contacts = [];
    });

    await ok("the second dose follow-up (persistent) has its own slot and sends, 30+ min after the first; self-care intensity is their own", async () => {
        const D8 = "2026-10-28";
        const f8 = await family("h");
        await SaheliCompanion.updateOne({ familyId: f8.fid, recipientUserId: f8.elder.id }, { $set: { nudgeIntensity: "persistent" } });
        await reply(f8.elder.phone, at(D8, "07:00"));
        await CareSchedule.create({ scheduleId: "sch-esc-h", familyId: f8.fid, recipientUserId: f8.elder.id, type: "MEDICINE", title: "Metformin", time: "08:00",
            createdBy: f8.cg.id, createdAt: at(D8, "06:00") });
        for (const hhmm of ["08:00", "08:15", "08:55", "09:00"]) {
            setClockForTest(at(D8, hhmm));
            await runCareNudgeTick(at(D8, hhmm));
        }
        const { default: SaheliNudgeLog } = await import("../src/models/saheliNudgeLog.model");
        const kinds = (await SaheliNudgeLog.find({ recipientUserId: f8.elder.id, delivered: true, scheduleId: "sch-esc-h" }).sort({ createdAt: 1 }).lean()).map((r) => r.nudgeKind);
        assert.deepEqual(kinds, ["dose_due", "missed_followup", "missed_followup_2"]);
        const rows = await MessageDelivery.find({ toUserId: f8.elder.id, kind: "dose_followup" }).sort({ sentAt: 1 }).lean();
        assert.equal(rows.length, 2);
        assert.ok(rows[1]!.sentAt!.getTime() - rows[0]!.sentAt!.getTime() >= 30 * 60_000);
        // self-care: their own setting, gentle when never chosen
        const f9 = await family("i", { selfCare: true });
        await CareSchedule.create({ scheduleId: "sch-esc-i", familyId: f9.fid, recipientUserId: f9.elder.id, type: "MEDICINE", title: "Vitamin", time: "10:00", createdBy: f9.elder.id });
        const { listSelfCareTargets } = await import("../src/services/saheliCareNudge.service");
        assert.equal((await listSelfCareTargets()).find((t) => t.recipientUserId === f9.elder.id)?.nudgeIntensity, "standard"); // the companion row's default
        await SaheliCompanion.updateOne({ familyId: f9.fid, recipientUserId: f9.elder.id }, { $set: { nudgeIntensity: "persistent" } });
        assert.equal((await listSelfCareTargets()).find((t) => t.recipientUserId === f9.elder.id)?.nudgeIntensity, "persistent");
        await SaheliCompanion.deleteOne({ familyId: f9.fid, recipientUserId: f9.elder.id });
        assert.equal((await listSelfCareTargets()).find((t) => t.recipientUserId === f9.elder.id)?.nudgeIntensity, "gentle");
    });

    await ok("the 09:00 check: on time, quiet-deferred, critical, self-care, late and missing → escalations on time x/y; misses email the team", async () => {
        resetOpsAlerts();
        // a late one: the alert went 30 minutes after it was due (written as the tick would have, but late)
        const D6 = "2026-10-26";
        const f6 = await family("f");
        await reply(f6.cg.phone, at(D6, "08:00"));
        await reply(f6.elder.phone, at(D6, "08:00"));
        await engineSend(f6, at(D6, "09:00"), "nudge");
        await engineSend(f6, at(D6, "09:30"), "checkin");
        await engineSend(f6, at(D6, "10:00"), "nudge");
        await tickEvery(at(D6, "10:00"), at(D6, "10:30"), 10); // the streak is recorded, still in its grace
        await tickEvery(at(D6, "11:30"), at(D6, "11:30")); // the tick was late (down for 30 minutes)
        // a missing one: three unanswered and no tick at all
        const f7 = await family("g");
        await reply(f7.elder.phone, at(D6, "11:00"));
        await engineSend(f7, at(D6, "12:00"), "nudge");
        await engineSend(f7, at(D6, "12:30"), "checkin");
        await engineSend(f7, at(D6, "13:00"), "nudge");
        emails.length = 0;
        const check = (await E.runEscalationCheck(at("2026-10-27", "09:00")))!;
        assert.equal(check.dateKey, D6);
        const byPerson = Object.fromEntries(check.cases.map((c) => [c.personUserId, c]));
        assert.equal(byPerson[f6.elder.id]?.outcome, "alert late");
        assert.equal(byPerson[f7.elder.id]?.outcome, "no escalation recorded");
        assert.equal(check.total, 2);
        assert.equal(check.onTime, 0);
        assert.equal(emails.length, 1);
        assert.match(emails[0]!.subject, /Escalations on time 0\/2 on 2026-10-26/);
        assert.match(emails[0]!.text, /alert late/);
        assert.match(emails[0]!.text, /no escalation recorded/);
        assert.ok(await EscalationCheck.exists({ dateKey: D6 }));
        assert.equal(await E.runEscalationCheck(at("2026-10-27", "09:30")), null); // once a day
        // the earlier days were all on time
        const d1 = (await E.runEscalationCheck(at("2026-10-21", "09:00"), { force: true }))!;
        assert.deepEqual([d1.onTime, d1.total], [2, 2]);
        const d2 = (await E.runEscalationCheck(at("2026-10-22", "09:00"), { force: true }))!;
        assert.deepEqual([d2.onTime, d2.total], [1, 1]);
        assert.equal(d2.cases[0]!.outcome, "replied before the alert was due");
        const d3 = (await E.runEscalationCheck(at("2026-10-23", "09:00"), { force: true }))!;
        assert.equal(d3.cases[0]!.outcome, "deferred for quiet hours, then sent");
        assert.equal(d3.cases[0]!.onTime, true);
        const d4 = (await E.runEscalationCheck(at("2026-10-25", "09:00"), { force: true }))!;
        assert.deepEqual([d4.onTime, d4.total], [1, 1]);
        const d5 = (await E.runEscalationCheck(at("2026-10-26", "09:00"), { force: true }))!;
        assert.deepEqual(d5.cases.map((c) => [c.outcome, c.onTime]).sort(), [["alert sent", true], ["no one to tell", true]]);
    });
    setClockForTest(null);
    await mongoose.disconnect();
}

async function pure() {
    console.log("pure");
    const E = await import("../src/services/escalation.service");
    const t = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 20, h, m));
    const s = (id: string, at: Date) => ({ id, at, kind: "nudge" });
    await ok("streaks in a timeline: a message from them starts the count again", () => {
        const sends = [s("a", t(1)), s("b", t(2)), s("c", t(3)), s("d", t(4)), s("e", t(6)), s("f", t(7)), s("g", t(8))];
        const streaks = E.findStreaks(sends, [t(5), t(9)]);
        assert.deepEqual(streaks.map((x) => [x.key, x.sends.length, x.thirdAt.getTime() === (x.key === "a" ? t(3) : t(8)).getTime(), x.repliedAt?.getTime()]),
            [["a", 4, true, t(5).getTime()], ["e", 3, true, t(9).getTime()]]);
        assert.deepEqual(E.findStreaks([s("a", t(1)), s("b", t(2))], []), []);
        assert.deepEqual(E.unansweredSince(sends, t(5)).map((x) => x.id), ["e", "f", "g"]);
    });
    await ok("quiet hours cross midnight; the wake time is the first minute outside them", () => {
        const q = { start: 22 * 60, end: 7 * 60 };
        assert.equal(E.inQuiet(23 * 60, q), true);
        assert.equal(E.inQuiet(6 * 60 + 59, q), true);
        assert.equal(E.inQuiet(7 * 60, q), false);
        assert.equal(E.wakeAfter(new Date("2026-10-20T23:10:00+05:30"), q).toISOString(), new Date("2026-10-21T07:00:00+05:30").toISOString());
        assert.equal(E.wakeAfter(new Date("2026-10-20T12:00:00+05:30"), q).toISOString(), new Date("2026-10-20T12:00:00+05:30").toISOString());
    });
    await ok("the 09:00 verdicts: replied in the grace, sent on time, late, deferred then sent, missing, no one to tell", () => {
        const third = new Date("2026-10-20T10:00:00+05:30");
        const now = new Date("2026-10-21T09:00:00+05:30");
        const base = { thirdAt: third, repliedAt: null, alertAt: null, wakeAt: null, now };
        assert.equal(E.judgeCase({ ...base, repliedAt: new Date("2026-10-20T10:30:00+05:30"), escalation: null }).onTime, true);
        assert.equal(E.judgeCase({ ...base, escalation: { state: "sent", sentAt: new Date("2026-10-20T11:01:00+05:30") } }).outcome, "alert sent");
        assert.equal(E.judgeCase({ ...base, escalation: { state: "sent", sentAt: new Date("2026-10-20T11:30:00+05:30") } }).outcome, "alert late");
        assert.equal(E.judgeCase({ ...base, escalation: { state: "sent", sentAt: new Date("2026-10-21T07:01:00+05:30"), deferredAt: new Date("2026-10-20T22:00:00+05:30"), reason: "deferred for quiet hours" },
            wakeAt: new Date("2026-10-21T07:00:00+05:30") }).outcome, "deferred for quiet hours, then sent");
        assert.equal(E.judgeCase({ ...base, escalation: null }).outcome, "no escalation recorded");
        assert.deepEqual(E.judgeCase({ ...base, escalation: { state: "none", reason: "self-care: no caregiver to tell and no emergency contact set" } }).onTime, true);
        assert.equal(E.judgeCase({ ...base, escalation: { state: "pending" } }).outcome, "alert missing");
    });
}

void (async () => {
    await pure();
    const uri = testDbUri("escalation_e2e");
    if (uri) await main(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
