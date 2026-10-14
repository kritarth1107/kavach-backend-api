/**
 * An alert never goes to the person it is about, the engine's alert kind decides WhatsApp, and crisis talk emails the
 * Kavach care team (founder 2026-10-13: a self-care user got five "urgent care alert" messages about himself, and no one
 * at Kavach knew he had written of suicide).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/careteam NODE_ENV=test npx tsx scripts/test-care-team-alert.ts
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

const whatsapp: Array<{ to: string; body: Record<string, unknown> }> = [];
let wamids = 0; // unique even after whatsapp.length is reset (the delivery ledger keeps one row per wamid)
const emails: Array<Record<string, unknown>> = [];
// Resend's API is faked below, so the email path may run here (real email otherwise goes only from production)
process.env.EMAIL_SEND = "on";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.includes("graph.facebook.com")) {
        whatsapp.push({ to: String(body.to ?? ""), body });
        return new Response(JSON.stringify({ messages: [{ id: `wamid.T${++wamids}` }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.includes("api.resend.com")) {
        emails.push(body);
        return new Response(JSON.stringify({ id: `email-${emails.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(url as string, init);
}) as typeof fetch;

async function withDb(uri: string) {
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const Family = (await import("../src/models/family.model")).default;
    const User = (await import("../src/models/users.model")).default;
    const { FamilyMemberStatus, FamilyRole } = await import("../src/types/family.types");
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");
    const { noteInbound } = await import("../src/services/whatsappWindow.service");

    const user = async (userId: string, first: string, number: string) => {
        await User.create({ userId, firstName: first, email: `${userId}@test.kavach`, phone: { countryCode: "+91", number }, phoneKey: `+91${number}`,
                            passwordHash: "x-not-a-real-hash" });
        await noteInbound(`+91${number}`); // their chat is open: a free WhatsApp message can reach them
    };
    await user("self1", "Rahul", "9000000301");
    await user("elder1", "Kamla", "9000000302");
    await user("son1", "Ravi", "9000000303");
    await Family.create({ familyId: "famSelf", name: "Rahul's care", createdBy: "self1",
                          members: [{ userId: "self1", role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED }] });
    await Family.create({ familyId: "famElder", name: "Kamla's family", createdBy: "son1",
                          members: [{ userId: "son1", role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED },
                                    { userId: "elder1", role: FamilyRole.CARE_RECIPIENT, status: FamilyMemberStatus.JOINED }] });

    await ok("an alert about someone caring for themselves never goes to them (no one else: nobody on WhatsApp)", async () => {
        whatsapp.length = 0;
        const out = await executeSaheliTool({ tool: "notify_caregivers", familyId: "famSelf", recipientUserId: "self1", actorUserId: "self1",
                                              args: { message: "Rahul talked of jumping from the roof.", urgency: "high", kind: "crisis" } });
        assert.equal(out.notifiedCount, 0);
        assert.equal(out.others, 0);
        assert.equal(whatsapp.length, 0, "he got nothing about himself");
        const esc = await executeSaheliTool({ tool: "trigger_emergency_escalation", familyId: "famSelf", recipientUserId: "self1", actorUserId: "self1",
                                              args: { message: "I have been shot in the chest" } });
        assert.equal((esc as { caregiversNotified?: number }).caregiversNotified ?? 0, 0);
        assert.equal(whatsapp.length, 0, "the emergency escalation does not message him either");
    });

    await ok("the engine's kind decides WhatsApp: a crisis about the elder reaches her son (it was dropped: medium went nowhere)", async () => {
        whatsapp.length = 0;
        const out = await executeSaheliTool({ tool: "notify_caregivers", familyId: "famElder", recipientUserId: "elder1", actorUserId: "elder1",
                                              args: { message: "Kamla ji talked of not wanting to live.", urgency: "medium", kind: "crisis" } });
        assert.equal(out.notifiedCount, 1);
        assert.equal(out.others, 1);
        assert.deepEqual(whatsapp.map((w) => w.to), ["919000000303"]);
        whatsapp.length = 0;
        const note = await executeSaheliTool({ tool: "notify_caregivers", familyId: "famElder", recipientUserId: "elder1", actorUserId: "elder1",
                                               args: { message: "Asked for more tea.", urgency: "medium", kind: "care_note" } });
        assert.equal(note.notifiedCount, 0, "a care note stays on the dashboard");
        assert.equal(whatsapp.length, 0);
    });

    await ok("the alert record says who was told: no one else to tell is a dashboard note, not a WhatsApp alert", async () => {
        const ActivityLog = (await import("../src/models/activityLog.model")).default;
        await ActivityLog.deleteMany({});
        await executeSaheliTool({ tool: "notify_caregivers", familyId: "famSelf", recipientUserId: "self1", actorUserId: "self1",
                                  args: { message: "Care note (not a diagnosis): stomach upset recurred.", urgency: "medium", kind: "symptom" } });
        const self = await ActivityLog.findOne({ familyId: "famSelf", kind: "caregiver_alert" }).lean<{ title: string; data: Record<string, unknown> }>();
        assert.ok(self, "the alert is still recorded");
        assert.equal(self.title, "Caregiver dashboard note: symptom");
        assert.equal(self.data.whatsapp, false, "nobody got a WhatsApp alert");
        assert.equal(self.data.whatsappKind, true);
        assert.equal(self.data.told, 0);
        assert.equal(self.data.caregivers, 0);

        await executeSaheliTool({ tool: "notify_caregivers", familyId: "famElder", recipientUserId: "elder1", actorUserId: "elder1",
                                  args: { message: "Kamla ji felt dizzy after lunch.", urgency: "medium", kind: "symptom" } });
        const told = await ActivityLog.findOne({ familyId: "famElder", kind: "caregiver_alert" }).lean<{ title: string; data: Record<string, unknown> }>();
        assert.equal(told?.title, "Caregiver WhatsApp alert: symptom");
        assert.equal(told?.data.whatsapp, true);
        assert.equal(told?.data.told, 1);
    });

    await ok("an order alert names the person the family way, never a fixed \"Amma\"", async () => {
        const Notification = (await import("../src/models/notification.model")).default;
        await Notification.deleteMany({});
        const { notifyCaregiversOrderPlaced } = await import("../src/services/saheliCaregiverAlert.service");
        await notifyCaregiversOrderPlaced({ familyId: "famElder", recipientUserId: "elder1", actorUserId: "elder1", partnerLabel: "Blinkit",
                                            item: "Milk 1 L", orderId: "ord-test-1" });
        await new Promise((r) => setTimeout(r, 200)); // the in-app notification is written without waiting
        const n = await Notification.findOne({ familyId: "famElder", kind: "order_placed" }).lean<{ title: string }>();
        assert.equal(n?.title, "Kamla placed an order");
    });

    await ok("crisis talk emails the Kavach care team with who, their number, what they said and a link", async () => {
        emails.length = 0;
        const out = await executeSaheliTool({ tool: "alert_care_team", familyId: "famSelf", recipientUserId: "self1", actorUserId: "self1",
                                              args: { kind: "crisis", family_told: 0,
                                                      lines: [{ at: "2026-10-12T19:58:00Z", said: "मैं छत से कूद रहा हूं", summary: "He says he will jump from the roof." }] } });
        assert.equal(out.sent, true);
        const [mail] = emails;
        assert.deepEqual(mail.to, ["kritarth@kavach.care"]);
        assert.match(String(mail.subject), /^\[Kavach\] URGENT: Rahul may be in crisis/);
        const text = String(mail.text);
        for (const bit of ["Who: Rahul, +91 9000000301", "caring for themselves; no one else in the family", "They said: \"मैं छत से कूद रहा हूं\"",
                           "13 Oct, 01:28", "/families/famSelf", "Tele-MANAS 14416", "does not cancel this alert"]) {
            assert.ok(text.includes(bit), `missing: ${bit}\n${text}`);
        }
    });

    await ok("an emergency with no one else to tell is an urgent email too; an update says so", async () => {
        emails.length = 0;
        await executeSaheliTool({ tool: "alert_care_team", familyId: "famSelf", recipientUserId: "self1", actorUserId: "self1",
                                  args: { kind: "emergency_alone", update: true, lines: [{ summary: "Severe chest pain and breathlessness." }] } });
        assert.match(String(emails[0].subject), /^\[Kavach\] Update: Rahul reported an emergency and has no one else to alert/);
    });
    await mongoose.disconnect();
}

(async () => {
    const uri = testDbUri("careteam");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI)");
    console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
