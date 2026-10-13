/**
 * WhatsApp never signs anyone up (founder 2026-10-13: "people can only access saheli via whatsapp when they have
 * completed the onboarding via web ... onboarding can not be done via sending hi with invite code on whatsapp"). With
 * sign-up open (invite-only off) a new number still gets no account and no family, only the way to the web; the profile
 * name is read from the webhook; the tools Saheli keeps for people already on Kavach (set my name, add the person cared
 * for) work, and finish_setup never marks an account set up (only the web onboarding does).
 * Invite codes, the waitlist and the "finish on the web" gate are in scripts/test-invites.ts.
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/signuptest NODE_ENV=test npx tsx scripts/test-whatsapp-signup.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { parseMetaWebhookMessages } from "../src/clients/metaWhatsApp.client";
import { testDbUri } from "./test-db";

process.env.DASHBOARD_URL = "https://app.example.com";

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
    // sign-up open: even then WhatsApp makes no account (invite-only and the waitlist are in scripts/test-invites.ts)
    process.env.INVITE_ONLY = "off";
    const WF = await import("../src/services/whatsappWebFirst.service");
    const User = (await import("../src/models/users.model")).default;
    const Family = (await import("../src/models/family.model")).default;
    const { FamilyRole } = await import("../src/types/family.types");
    const { createDefaultFamilyForUser } = await import("../src/services/family.service");
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");

    await ok("a new number gets no account and no family, whatever it says: just the way to the web sign-up", async () => {
        for (const text of ["hi", "hi KAVACH-7K2M9QXA4TBC8D1EFGHJ5NPRSV", "I want to sign up for my mother"]) {
            const r = await WF.answerUnknownNumber("+919000000101", { profileName: "Ravi 😊 Kumar", text });
            assert.equal(r?.kind, "open");
            assert.equal(r?.reply, "Namaste 🙏 I'm Saheli from Kavach. Sign up at https://app.example.com/auth/login, finish setting up there, then say hi here.");
        }
        assert.equal(await User.countDocuments({}), 0);
        assert.equal(await Family.countDocuments({}), 0);
        assert.equal(await WF.answerUnknownNumber("123"), null, "a broken number gets the usual line");
        assert.equal(await WF.answerUnknownNumber("+991234567890"), null, "the internal placeholder code is never a real number");
    });

    // a caregiver whose family was set up on the web, talking to Saheli on WhatsApp
    const u = await User.create({ email: "ravi@example.com", firstName: "Ravi", passwordHash: "x", emailVerified: true,
                                  phone: { countryCode: "+91", number: "9000000102" }, phoneKey: "+919000000102", onboarding: { status: "done" } });
    const familyId = (await createDefaultFamilyForUser(u)).familyId;
    const userId = u.userId;
    const tool = (name: string, args: Record<string, unknown>, actor = userId) =>
        executeSaheliTool({ tool: name as never, args, familyId, recipientUserId: actor, actorUserId: actor }) as Promise<Record<string, any>>;

    await ok("Saheli's tools for people already on Kavach: their name, the person they look after", async () => {
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
    });

    await ok("finish_setup on WhatsApp never marks an account set up: only the web onboarding does", async () => {
        await User.updateOne({ userId }, { $set: { onboarding: { status: "pending" } } });
        const done = await tool("finish_setup", {});
        assert.equal(done.ok, true);
        assert.equal((await User.findOne({ userId }).lean<Record<string, any>>())!.onboarding.status, "pending");
        assert.equal(await WF.webSetupUnfinished({ userId, role: FamilyRole.PRIMARY_CAREGIVER }), true);
    });
}

(async () => {
    await pure();
    const uri = testDbUri("signuptest");
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
