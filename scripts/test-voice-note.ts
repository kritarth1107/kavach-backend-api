/**
 * A chosen line goes as a WhatsApp voice note to the asker or another family member, and only to them.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27017/x NODE_ENV=test npx tsx scripts/test-voice-note.ts
 */
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

async function main() {
    const uri = testDbUri("voicenote");
    if (!uri) {
        console.log("voice note: no TEST_MONGODB_URI, DB checks skipped");
        return;
    }
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: Family } = await import("../src/models/family.model");
    const { default: User } = await import("../src/models/users.model");
    await User.create({
        userId: "asker-v", firstName: "Kamla", email: "kamla-v@world.kavach.test", passwordHash: "x",
        phone: { countryCode: "+999", number: "100000001" }, phoneKey: "+999100000001",
    });
    await User.create({
        userId: "kin-v", firstName: "Asha", email: "asha-v@world.kavach.test", passwordHash: "x",
        phone: { countryCode: "+999", number: "100000002" }, phoneKey: "+999100000002",
    });
    await Family.create({
        familyId: "fam-v", name: "Voice family", createdBy: "kin-v", status: "ACTIVE",
        members: [
            { userId: "asker-v", role: "CARE_RECIPIENT", status: "JOINED" },
            { userId: "kin-v", role: "PRIMARY_CAREGIVER", status: "JOINED" },
        ],
    });
    const S = await import("../src/services/careMemorySync.service");
    const heard: Array<{ to: string; text: string; listenerUserId?: string }> = [];
    const voiceNote = async (input: { to: string; text: string; listenerUserId?: string }) => {
        heard.push(input);
        return "sent" as const;
    };
    await ok("a voice note to the asker speaks their words", async () => {
        const r = await S.sendSaheliWhatsApp({
            familyId: "fam-v", recipientUserId: "asker-v", toUserId: "asker-v", text: "I love you, beta", voice: true, voiceNote,
        });
        assert.equal(r.delivered, true);
        assert.equal(r.voice, "sent");
        assert.equal(heard.at(-1)?.text, "I love you, beta");
        assert.equal(heard.at(-1)?.listenerUserId, "asker-v");
        assert.ok(heard.at(-1)?.to.includes("999100000001"));
    });
    await ok("a voice note to another family member uses their number", async () => {
        const r = await S.sendSaheliWhatsApp({
            familyId: "fam-v", recipientUserId: "asker-v", toUserId: "kin-v", text: "She asked me to tell you this", voice: true, voiceNote,
        });
        assert.equal(r.delivered, true);
        assert.equal(r.voice, "sent");
        assert.ok(heard.at(-1)?.to.includes("999100000002"));
    });
    await ok("without voice, nothing is spoken", async () => {
        const before = heard.length;
        const r = await S.sendSaheliWhatsApp({
            familyId: "fam-v", recipientUserId: "asker-v", toUserId: "asker-v", text: "Just the words", voiceNote,
        });
        assert.equal(r.delivered, true);
        assert.equal(r.voice, undefined);
        assert.equal(heard.length, before);
    });
    await ok("someone outside the family is not sent a voice note", async () => {
        const before = heard.length;
        const r = await S.sendSaheliWhatsApp({
            familyId: "fam-v", recipientUserId: "asker-v", toUserId: "stranger", text: "I love you", voice: true, voiceNote,
        });
        assert.equal(r.delivered, false);
        assert.equal(r.reason, "not a family member");
        assert.equal(r.voice, "none");
        assert.equal(heard.length, before);
    });
    await mongoose.disconnect();
}

main()
    .then(() => console.log(`voice note: ${passed} passed`))
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });
