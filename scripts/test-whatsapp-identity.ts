/**
 * WhatsApp identity for people whose account carries only the internal "+99" placeholder (most accounts) or whose real
 * number was saved under it (live 2026-10-11: a caregiver typed his number in settings while "+99" was still filled in;
 * he could write to Saheli but every message she started was dropped as "placeholder").
 * Pure helpers + (with TEST_MONGODB_URI, a throwaway local mongod) the inbound repair, the number Saheli's own messages
 * use, the settings page and the invite path. Synthetic numbers only.
 * Usage: NODE_ENV=test npx tsx scripts/test-whatsapp-identity.ts
 *        TEST_MONGODB_URI=mongodb://127.0.0.1:27999/widtest NODE_ENV=test npx tsx scripts/test-whatsapp-identity.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { realNumberFromSender } from "../src/services/identityResolver.service";

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
                console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
                process.exitCode = 1;
            },
        );

const TYPED = { phone: { countryCode: "+99", number: "9876501234" }, phoneKey: "+995550001111" }; // typed over the placeholder
const KEYED = { phone: { countryCode: "+99", number: "9876502345" }, phoneKey: "+999876502345" }; // real digits, key to match (the founder's account)

async function pure() {
    console.log("pure helpers");
    await ok("the real number of a number typed under +99 comes from the sender", () => {
        assert.deepEqual(realNumberFromSender(TYPED, "+919876501234"), { countryCode: "+91", number: "9876501234", phoneKey: "+919876501234" });
        assert.deepEqual(realNumberFromSender(TYPED, "+19876501234"), { countryCode: "+1", number: "9876501234", phoneKey: "+19876501234" }, "abroad too");
        assert.equal(realNumberFromSender(TYPED, "+919876509999"), null, "another number");
        assert.equal(realNumberFromSender(TYPED, "+999876501234"), null, "never the internal code");
        assert.deepEqual(realNumberFromSender(KEYED, "+919876502345"), { countryCode: "+91", number: "9876502345", phoneKey: "+919876502345" }, "key matching the digits");
        assert.equal(realNumberFromSender({ phone: { countryCode: "+91", number: "9876501234" }, phoneKey: "+919876501234" }, "+919876501234"), null, "already real");
    });
}

async function withDb(uri: string) {
    console.log("database");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const User = (await import("../src/models/users.model")).default;
    const Family = (await import("../src/models/family.model")).default;
    const ChannelIdentity = (await import("../src/models/channelIdentity.model")).default;
    const { resolveWhatsAppSender } = await import("../src/services/identityResolver.service");
    const { familyMemberPhone } = await import("../src/services/careMemorySync.service");
    const { buildUserProfile, updateUserProfile } = await import("../src/services/user.service");
    const { createInvitedUser } = await import("../src/services/familyMember.service");

    const FAM = "fam-wid";
    const person = (userId: string, email: string, phone: { countryCode: string; number: string }, phoneKey: string) => ({
        userId, email, phone, phoneKey, passwordHash: "x", firstName: userId, status: "ACTIVE", emailVerified: true,
        primaryAuthProvider: "EMAIL", socialAccounts: [], preferences: {}, createdAt: new Date(), updatedAt: new Date(),
    });
    await User.collection.insertMany([
        person("u-carer", "carer@example.test", TYPED.phone, TYPED.phoneKey),
        person("u-elder", "elder@pending.kavach", { countryCode: "+91", number: "9876505678" }, "+919876505678"),
        person("u-linked", "linked@example.test", { countryCode: "+99", number: "5550002222" }, "+995550002222"),
        person("u-keyed", "keyed@example.test", KEYED.phone, KEYED.phoneKey),
        person("u-fresh", "fresh@example.test", { countryCode: "+99", number: "5550003333" }, "+995550003333"),
    ]);
    await Family.collection.insertOne({
        familyId: FAM, name: "Test family", status: "ACTIVE", createdBy: "u-carer", createdAt: new Date(), updatedAt: new Date(),
        members: [
            { userId: "u-carer", role: "PRIMARY_CAREGIVER", status: "JOINED" },
            { userId: "u-elder", role: "CARE_RECIPIENT", status: "JOINED" },
            { userId: "u-linked", role: "CO_CAREGIVER", status: "JOINED" },
            { userId: "u-keyed", role: "CO_CAREGIVER", status: "JOINED" },
        ],
    });
    await ChannelIdentity.collection.insertOne({
        identityId: "ci-linked", channelType: "whatsapp", channelIdentifier: "+919876503333", familyId: FAM, userId: "u-linked",
        role: "CO_CAREGIVER", active: true, createdAt: new Date(), updatedAt: new Date(),
    });

    await ok("Saheli's own messages never go to a +99 number", async () => {
        const got = await familyMemberPhone(FAM, "u-carer");
        assert.deepEqual(got, { reason: "no WhatsApp number" }, `was ${JSON.stringify(got)}`);
    });
    await ok("someone with only the placeholder is reached on their WhatsApp link", async () => {
        assert.deepEqual(await familyMemberPhone(FAM, "u-linked"), { phone: "+919876503333" });
        assert.deepEqual(await familyMemberPhone(FAM, "u-elder"), { phone: "+919876505678" });
        assert.deepEqual(await familyMemberPhone(FAM, "u-fresh"), { reason: "not a family member" });
    });
    await ok("a message from the typed number repairs the account", async () => {
        const who = await resolveWhatsAppSender("919876501234");
        assert.equal(who.userId, "u-carer");
        assert.equal(who.familyId, FAM);
        const u = await User.findOne({ userId: "u-carer" }).lean();
        assert.deepEqual({ cc: u?.phone?.countryCode, n: u?.phone?.number, key: u?.phoneKey }, { cc: "+91", n: "9876501234", key: "+919876501234" });
        assert.deepEqual(await familyMemberPhone(FAM, "u-carer"), { phone: "+919876501234" });
        assert.equal((await resolveWhatsAppSender("+919876501234")).userId, "u-carer", "still recognised after the repair");
    });
    await ok("real digits saved under +99 with a matching key are still recognised, and repaired", async () => {
        assert.deepEqual(await familyMemberPhone(FAM, "u-keyed"), { reason: "no WhatsApp number" });
        assert.equal((await resolveWhatsAppSender("+919876502345")).userId, "u-keyed");
        const u = await User.findOne({ userId: "u-keyed" }).lean();
        assert.deepEqual({ cc: u?.phone?.countryCode, key: u?.phoneKey }, { cc: "+91", key: "+919876502345" });
        assert.deepEqual(await familyMemberPhone(FAM, "u-keyed"), { phone: "+919876502345" });
    });
    await ok("a number nobody holds is not recognised", async () => {
        await assert.rejects(resolveWhatsAppSender("919876500000"), /not recognized/);
    });
    await ok("settings never show the placeholder and refuse the +99 code", async () => {
        const doc = await User.findOne({ userId: "u-linked" });
        assert.equal(buildUserProfile(doc!).phone, null);
        await assert.rejects(updateUserProfile("u-linked", { phone: "9876504444", phoneCountryCode: "+99" }), /country code/);
        const saved = await updateUserProfile("u-linked", { phone: "9876504444", phoneCountryCode: "+91" });
        assert.deepEqual({ cc: saved.phone?.countryCode, n: saved.phone?.number }, { cc: "+91", n: "9876504444" });
        assert.equal((await User.findOne({ userId: "u-linked" }).lean())?.phoneKey, "+919876504444");
    });
    await ok("inviting someone whose account has only the placeholder gives it the number", async () => {
        const u = await createInvitedUser("fresh@example.test", "Fresh Person", undefined, "9876506666", "+91");
        assert.equal(u.userId, "u-fresh");
        const row = await User.findOne({ userId: "u-fresh" }).lean();
        assert.deepEqual({ cc: row?.phone?.countryCode, n: row?.phone?.number, key: row?.phoneKey }, { cc: "+91", n: "9876506666", key: "+919876506666" });
    });

    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
}

(async () => {
    await pure();
    const uri = process.env.TEST_MONGODB_URI;
    if (uri) {
        if (/cosmos|azure|mongodb\+srv|firestore|googleapis/i.test(uri)) throw new Error("TEST_MONGODB_URI must be a throwaway local DB");
        await withDb(uri);
    } else console.log("(set TEST_MONGODB_URI to a throwaway local mongod for the DB tests)");
    console.log(`${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
