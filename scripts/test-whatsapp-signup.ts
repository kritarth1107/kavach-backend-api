/**
 * Sign-up on WhatsApp (founder 2026-10-12: "if a new user sends hi on WhatsApp, start their onboarding directly"):
 * a new number gets an account and a family, limits stop a flood, the profile name is read from the webhook, and the
 * setup tools Saheli uses (add the person cared for, set my name, finish setup).
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/signuptest NODE_ENV=test npx tsx scripts/test-whatsapp-signup.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { parseMetaWebhookMessages } from "../src/clients/metaWhatsApp.client";

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

async function pure() {
    console.log("pure");
    await ok("the webhook's profile name comes with the message", () => {
        const body = {
            object: "whatsapp_business_account",
            entry: [{ changes: [{ value: {
                contacts: [{ wa_id: "919000000101", profile: { name: "Ravi Kumar" } }],
                messages: [{ from: "919000000101", id: "wamid.X", type: "text", text: { body: "hi" } }],
            } }] }],
        };
        const [m] = parseMetaWebhookMessages(body);
        assert.equal(m.profileName, "Ravi Kumar");
        assert.equal(m.text, "hi");
        const none = parseMetaWebhookMessages({ ...body, entry: [{ changes: [{ value: { messages: [{ from: "919000000101", type: "text", text: { body: "hi" } }] } }] }] });
        assert.equal(none[0].profileName, undefined);
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const S = await import("../src/services/whatsappSignup.service");
    const User = (await import("../src/models/users.model")).default;
    const Family = (await import("../src/models/family.model")).default;
    const { FamilyRole } = await import("../src/types/family.types");
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");

    let userId = "", familyId = "";
    await ok("a new number gets an account and a family, the number proven by the message itself", async () => {
        const r = await S.startWhatsAppSignup("+919000000101", { profileName: "Ravi 😊 Kumar" });
        assert.equal(r.ok, true);
        if (!r.ok) return;
        userId = r.userId;
        familyId = r.familyId;
        const u = await User.findOne({ userId }).lean<Record<string, any>>();
        assert.equal(u!.firstName, "Ravi");
        assert.equal(u!.signupSource, "whatsapp");
        assert.equal(u!.onboarding.status, "pending");
        assert.ok(u!.phoneVerifiedAt);
        assert.equal(u!.phone.number, "9000000101");
        const fam = await Family.findOne({ familyId }).lean<Record<string, any>>();
        assert.equal(fam!.members[0].userId, userId);
        assert.equal(fam!.members[0].role, FamilyRole.PRIMARY_CAREGIVER);
        assert.equal(await S.setupPending(userId), true);
    });

    await ok("the same number again never makes a second account; a broken number makes none", async () => {
        assert.deepEqual(await S.startWhatsAppSignup("+919000000101"), { ok: true, userId, familyId, created: false });
        assert.equal(await User.countDocuments({ phoneKey: { $regex: "9000000101$" } }), 1);
        assert.deepEqual(await S.startWhatsAppSignup("123"), { ok: false, reason: "invalid" });
    });

    await ok("a flood of strangers stops at the hourly limit", async () => {
        const now = new Date();
        const docs = Array.from({ length: S.SIGNUPS_PER_HOUR }, (_, i) => ({
            userId: `flood-${i}`, email: `flood${i}@pending.kavach`, firstName: "X", passwordHash: "x", signupSource: "whatsapp",
            phoneKey: `+91${8000000000 + i}`, createdAt: now, updatedAt: now,
        }));
        await User.collection.insertMany(docs);
        assert.deepEqual(await S.startWhatsAppSignup("+919000000202"), { ok: false, reason: "limit" });
        await User.collection.deleteMany({ userId: { $regex: "^flood-" } });
        process.env.WHATSAPP_SIGNUP = "off";
        assert.deepEqual(await S.startWhatsAppSignup("+919000000202"), { ok: false, reason: "off" });
        delete process.env.WHATSAPP_SIGNUP;
    });

    const tool = (name: string, args: Record<string, unknown>, actor = userId) =>
        executeSaheliTool({ tool: name as never, args, familyId, recipientUserId: actor, actorUserId: actor }) as Promise<Record<string, any>>;

    await ok("setup on WhatsApp: their name, the person they look after, then done", async () => {
        const named = await tool("set_my_name", { firstName: "Ravi", lastName: "Kumar" });
        assert.equal(named.ok, true);
        assert.equal((await User.findOne({ userId }).lean<Record<string, any>>())!.lastName, "Kumar");
        const added = await tool("add_family_member", { name: "Kamla Devi", relationship: "mother", phone: "9000000303" });
        assert.equal(added.ok, true, JSON.stringify(added));
        assert.ok(added.userId, "the new member's id comes back");
        assert.match(added.joinLink, /^https:\/\/wa\.me\/\d+\?text=/);
        const fam = await Family.findOne({ familyId }).lean<Record<string, any>>();
        const elder = fam!.members.find((m: { role: string }) => m.role === FamilyRole.CARE_RECIPIENT);
        assert.ok(elder && elder.userId === added.userId);
        const again = await tool("add_family_member", { name: "Someone Else", phone: "9000000404" });
        assert.equal(again.ok, false, "one person cared for per family here; others on the dashboard");
        assert.equal((await tool("add_family_member", { name: "X", phone: "9000000505" }, added.userId)).ok, false, "only a caregiver adds");
        const done = await tool("finish_setup", {});
        assert.equal(done.ok, true);
        assert.equal(await S.setupPending(userId), false);
    });
}

(async () => {
    await pure();
    const uri = process.env.TEST_MONGODB_URI;
    if (uri) {
        try {
            await withDb(uri);
        } finally {
            await new Promise((r) => setTimeout(r, 500));
            await mongoose.disconnect().catch(() => undefined);
        }
    } else {
        console.log("  (DB checks skipped: set TEST_MONGODB_URI)");
    }
    if (process.exitCode) {
        console.error("FAILED");
        process.exit(1);
    }
    console.log(`all ${passed} passed`);
})();
