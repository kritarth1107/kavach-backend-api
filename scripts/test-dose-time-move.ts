/**
 * A dose marked today keeps its mark when its time moves, and a dose can be unmarked (live 15 Oct 2026: a 2 am dose was
 * marked taken, the time moved to 11:30 pm, the new row read "upcoming", Saheli said it was not marked while the dashboard
 * showed it taken, and there was no way to unmark today when the person asked).
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { testDbUri } from "./test-db";

let fail = 0;
let passed = 0;
async function ok(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        fail++;
        console.error(`  ✗ ${name}\n    ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
}

async function withDb(uri: string) {
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: Family } = await import("../src/models/family.model");
    const { default: User } = await import("../src/models/users.model");
    const { syncMedicineSchedule } = await import("../src/services/careMemorySync.service");
    const { markScheduleCompleted, clearScheduleCompletion } = await import("../src/services/saheliCareAction.service");
    const { getScheduleDayStatuses } = await import("../src/services/careScheduleCompletion.service");
    await User.create({ userId: "self-m", firstName: "Ravi", email: "ravi-m@world.kavach.test", passwordHash: "x" });
    await User.create({ userId: "view-m", firstName: "Rao", email: "rao-m@world.kavach.test", passwordHash: "x" });
    await User.create({ userId: "elder-m", firstName: "Kamla", email: "kamla-m@world.kavach.test", passwordHash: "x" });
    await Family.create({ familyId: "fam-move", name: "Move test", createdBy: "self-m", members: [
        { userId: "self-m", role: "PRIMARY_CAREGIVER", status: "JOINED" },
        { userId: "elder-m", role: "CARE_RECIPIENT", status: "JOINED" },
        { userId: "view-m", role: "VIEW_ONLY", status: "JOINED" },
    ] });
    const sync = (who: string, key: string, name: string, times: string[]) =>
        syncMedicineSchedule({ familyId: "fam-move", recipientUserId: who, actorUserId: "self-m", sourceKey: key, name, times, active: true });
    const statusOf = async (who: string, name: string) =>
        (await getScheduleDayStatuses("fam-move", who, "self-m")).items.filter((i) => i.title === name && i.time).map((i) => `${i.time}:${i.status}`);

    await ok("a dose marked today keeps its mark when its time moves (no second reminder for it)", async () => {
        await sync("self-m", "medicine:magnesium", "Magnesium", ["02:00"]);
        const r = await markScheduleCompleted({ familyId: "fam-move", recipientUserId: "self-m", actorUserId: "self-m", titleHint: "Magnesium", fromBrain: true });
        assert.ok(!("error" in r), JSON.stringify(r));
        await sync("self-m", "medicine:magnesium", "Magnesium", ["23:30"]);
        assert.deepEqual(await statusOf("self-m", "Magnesium"), ["23:30:completed"]);
    });
    await ok("unmarking clears today's mark, on the moved row too", async () => {
        const r = await clearScheduleCompletion({ familyId: "fam-move", recipientUserId: "self-m", actorUserId: "self-m", titleHint: "Magnesium" });
        assert.equal(r.cleared, 2, JSON.stringify(r)); // today's row and the 02:00 row it moved from
        const [s] = await statusOf("self-m", "Magnesium");
        assert.ok(s && !s.endsWith(":completed"), s);
    });
    await ok("a twice-daily medicine that moves keeps each dose's mark in time order", async () => {
        await sync("elder-m", "medicine:metformin", "Metformin", ["08:00", "20:00"]);
        await markScheduleCompleted({ familyId: "fam-move", recipientUserId: "elder-m", actorUserId: "self-m", titleHint: "Metformin", timeHint: "08:00", fromBrain: true });
        await sync("elder-m", "medicine:metformin", "Metformin", ["08:30", "20:30"]);
        const now = await statusOf("elder-m", "Metformin");
        assert.ok(now.includes("08:30:completed") && !now.includes("20:30:completed"), now.join(", "));
    });
    await ok("someone who may not manage the family cannot unmark", async () => {
        const r = await clearScheduleCompletion({ familyId: "fam-move", recipientUserId: "elder-m", actorUserId: "view-m", titleHint: "Metformin", timeHint: "08:30" });
        assert.ok("error" in r, JSON.stringify(r));
        assert.ok((await statusOf("elder-m", "Metformin")).includes("08:30:completed"));
    });
    await ok("unmarking something that is not on the list says so", async () => {
        const r = await clearScheduleCompletion({ familyId: "fam-move", recipientUserId: "self-m", actorUserId: "self-m", titleHint: "Atorvastatin" });
        assert.ok("error" in r, JSON.stringify(r));
    });
    await mongoose.disconnect();
}

void (async () => {
    const uri = testDbUri("dose_time_move");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI)");
    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log(`${passed} passed`);
    process.exit(0);
})();
