/**
 * Readings told to Saheli reach Health Records (founder 2026-10-13: "if someone has sent weight or BMI or anything those
 * should go to health records"): cards with trends next to report values, BMI worked out from weight and height, the
 * day a scan was measured, and the list of readings.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/chatreadings NODE_ENV=test npx tsx scripts/test-chat-readings.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { heightCm } from "../src/services/healthRecordReview.service";
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

async function units() {
    await ok("height in cm, metres and feet", () => {
        assert.equal(heightCm("178", "cm"), 178);
        assert.equal(heightCm("1.78", "m"), 178);
        assert.equal(Math.round(heightCm("5.3", "ft")!), 160);
        assert.equal(Math.round(heightCm("5'10", "ft")!), 178);
        assert.equal(heightCm("abc", "cm"), null);
    });
}

async function withDb(uri: string) {
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { appendCareRecordEvent } = await import("../src/services/careRecord.service");
    const { logVitals } = await import("../src/services/saheliCareAction.service");
    const { recordHighlights } = await import("../src/services/healthRecordReview.service");
    const { CareRecordEventType, CareRecordSource, ChannelType } = await import("../src/types/careRecord.types");
    const fam = "famR", me = "selfR";
    const add = (kind: string, value: string, unit: string | undefined, at: Date) =>
        appendCareRecordEvent({ familyId: fam, subjectUserId: me, actorUserId: me, type: CareRecordEventType.VITAL, source: CareRecordSource.SAHELI,
                                channel: ChannelType.WHATSAPP, title: kind, detail: `${kind} ${value}`, status: "reported", payload: { kind, value, unit }, skipSignalCheck: true })
            .then(() => mongoose.connection.db!.collection("carerecordevents").updateOne({ familyId: fam, "payload.kind": kind, "payload.value": value }, { $set: { createdAt: at } }));
    await add("weight", "74.2", "kg", new Date("2026-10-01T05:00:00Z"));
    await add("weight", "73.5", "kg", new Date("2026-10-11T13:15:00Z"));

    await ok("weight told in chat is a card with its trend, from WhatsApp", async () => {
        const h = await recordHighlights(fam, me);
        const w = h.cards.find((c) => c.key === "weight")!;
        assert.equal(w.value, "73.5");
        assert.equal(w.unit, "kg");
        assert.equal(w.from, "chat");
        assert.deepEqual(w.trend.map((p) => p.value), [74.2, 73.5]);
        assert.equal(w.delta, -0.7);
        assert.equal(h.readings[0].name, "Weight");
        assert.equal(h.reports, 0);
    });

    await ok("with a height, BMI is worked out from the latest weight", async () => {
        await logVitals({ familyId: fam, recipientUserId: me, actorUserId: me, kind: "height", value: "178", unit: "cm" });
        const bmi = (await recordHighlights(fam, me)).all.find((c) => c.key === "bmi")!;
        assert.equal(bmi.value, "23.2");
        assert.equal(bmi.from, "calculated");
        assert.equal(bmi.flag, "normal");
    });

    await ok("a measured BMI (scan) on the day of the weight wins, dated the day it was measured", async () => {
        await logVitals({ familyId: fam, recipientUserId: me, actorUserId: me, kind: "bmi", value: "25.4", takenOn: "2026-10-11" });
        await logVitals({ familyId: fam, recipientUserId: me, actorUserId: me, kind: "other", name: "Visceral fat", value: "8", takenOn: "2026-10-11" });
        const h = await recordHighlights(fam, me);
        const bmi = h.all.find((c) => c.key === "bmi")!;
        assert.equal(bmi.value, "25.4");
        assert.equal(bmi.from, "chat");
        assert.equal(bmi.date, "2026-10-11");
        assert.equal(bmi.flag, "high");
        assert.ok(h.all.some((c) => c.name === "Visceral fat" && c.value === "8"));
    });
    await mongoose.disconnect();
}

(async () => {
    await units();
    const uri = testDbUri("chatreadings");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI)");
    console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
