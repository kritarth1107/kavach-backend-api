/**
 * The nightly brief goes only to caregivers (live 2026-10-13: the raw brief data went out on WhatsApp; the engine no longer
 * sends it, and the backend refuses any send of kind "brief" to the person cared for).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-brief-recipient.ts
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
    const uri = testDbUri("brieftest");
    if (!uri) {
        console.log("brief recipient: no TEST_MONGODB_URI, DB checks skipped");
        return;
    }
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: Family } = await import("../src/models/family.model");
    await Family.create({
        familyId: "fam-b", name: "Test family", createdBy: "cg-b", status: "ACTIVE",
        members: [
            { userId: "cg-b", role: "PRIMARY_CAREGIVER", status: "JOINED" },
            { userId: "elder-b", role: "CARE_RECIPIENT", status: "JOINED" },
        ],
    });
    const S = await import("../src/services/careMemorySync.service");
    await ok("a brief to the person cared for is refused before any number is looked up", async () => {
        const r = await S.sendSaheliWhatsApp({ familyId: "fam-b", recipientUserId: "elder-b", toUserId: "elder-b", text: "Daily brief", kind: "brief" });
        assert.equal(r.delivered, false);
        assert.equal(r.reason, "a brief goes only to caregivers");
    });
    await ok("a brief to a caregiver passes the role check", async () => {
        const r = await S.sendSaheliWhatsApp({ familyId: "fam-b", recipientUserId: "elder-b", toUserId: "cg-b", text: "Daily brief", kind: "brief" });
        assert.notEqual(r.reason, "a brief goes only to caregivers");
    });
    await ok("other messages to the person cared for are not affected", async () => {
        const r = await S.sendSaheliWhatsApp({ familyId: "fam-b", recipientUserId: "elder-b", toUserId: "elder-b", text: "Good morning", kind: "nudge" });
        assert.notEqual(r.reason, "a brief goes only to caregivers");
    });
    await ok("isCareRecipient reads the member's role", async () => {
        assert.equal(await S.isCareRecipient("fam-b", "elder-b"), true);
        assert.equal(await S.isCareRecipient("fam-b", "cg-b"), false);
        assert.equal(await S.isCareRecipient("fam-b", "nobody"), false);
    });
    await mongoose.disconnect();
}

main()
    .then(() => console.log(`brief recipient: ${passed} passed`))
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });
