/**
 * A reminder's Done button marks the dose it names, for whoever got the reminder (live 15 Oct 2026: a self-care
 * caregiver tapped Done on his own medicine, a keyword route read the care recipient's empty schedule and answered
 * "No care schedule items for today", and nothing was marked).
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { testDbUri } from "./test-db";
import { tryHandleCareScheduleQuery } from "../src/services/whatsappDashboardParity.service";

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

async function pure() {
    await ok("the keyword schedule route never answers a Done button", async () => {
        const out = await tryHandleCareScheduleQuery({ familyId: "f", recipientUserId: "e", actorUserId: "c", text: "I completed schedule 3f932029-deb9" });
        assert.equal(out.handled, false);
    });
}

async function withDb(uri: string) {
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: Family } = await import("../src/models/family.model");
    const { default: User } = await import("../src/models/users.model");
    const { default: CareSchedule } = await import("../src/models/careSchedule.model");
    const { closeRemindedDose } = await import("../src/services/saheliCareAction.service");
    const { getScheduleDayStatuses } = await import("../src/services/careScheduleCompletion.service");
    await User.create({ userId: "elder-d", firstName: "Kamla", email: "kamla-d@world.kavach.test", passwordHash: "x" });
    await User.create({ userId: "cg-d", firstName: "Ravi", email: "ravi-d@world.kavach.test", passwordHash: "x" });
    await User.create({ userId: "cg2-d", firstName: "Asha", email: "asha-d@world.kavach.test", passwordHash: "x" });
    await User.create({ userId: "doc-d", firstName: "Rao", email: "rao-d@world.kavach.test", passwordHash: "x" });
    await Family.create({ familyId: "fam-done", name: "Done test", createdBy: "cg-d", members: [
        { userId: "elder-d", role: "CARE_RECIPIENT", status: "JOINED" },
        { userId: "cg-d", role: "PRIMARY_CAREGIVER", status: "JOINED" },
        { userId: "cg2-d", role: "CO_CAREGIVER", status: "JOINED" },
        { userId: "doc-d", role: "VIEW_ONLY", status: "JOINED" },
    ] });
    const base = { familyId: "fam-done", type: "MEDICINE", daysOfWeek: [0, 1, 2, 3, 4, 5, 6], active: true, createdBy: "cg-d" };
    await CareSchedule.create({ ...base, scheduleId: "own-mag", recipientUserId: "cg-d", title: "Magnesium Glycinate", time: "02:00" });
    await CareSchedule.create({ ...base, scheduleId: "elder-met", recipientUserId: "elder-d", title: "Metformin 500 mg", time: "08:00" });
    const status = async (who: string, id: string) =>
        (await getScheduleDayStatuses("fam-done", who, who)).items.find((i: { scheduleId: string }) => i.scheduleId === id)?.status;

    await ok("a caregiver's Done on his own self-care medicine marks it taken", async () => {
        const line = await closeRemindedDose({ familyId: "fam-done", recipientUserId: "cg-d", actorUserId: "cg-d",
            message: "I completed schedule own-mag", mayMarkOthers: true });
        assert.ok(line && /Magnesium/i.test(line), line ?? "null");
        assert.equal(await status("cg-d", "own-mag"), "completed");
    });
    await ok("an elder's Done on her own medicine still marks it", async () => {
        const line = await closeRemindedDose({ familyId: "fam-done", recipientUserId: "elder-d", actorUserId: "elder-d",
            message: "I completed schedule elder-met" });
        assert.ok(line && /Metformin/i.test(line), line ?? "null");
        assert.equal(await status("elder-d", "elder-met"), "completed");
    });
    await ok("a caregiver may tap Done on the care recipient's dose; someone who may not gets no mark", async () => {
        await CareSchedule.create({ ...base, scheduleId: "elder-bp", recipientUserId: "elder-d", title: "Telma 40", time: "09:00" });
        assert.equal(await closeRemindedDose({ familyId: "fam-done", recipientUserId: "doc-d", actorUserId: "doc-d",
            message: "I completed schedule elder-bp" }), null, "view-only: not theirs");
        assert.notEqual(await status("elder-d", "elder-bp"), "completed");
        const line = await closeRemindedDose({ familyId: "fam-done", recipientUserId: "cg2-d", actorUserId: "cg2-d",
            message: "I completed schedule elder-bp", mayMarkOthers: true });
        assert.ok(line && /Telma/i.test(line), line ?? "null");
        assert.equal(await status("elder-d", "elder-bp"), "completed");
    });
    await ok("a Done for a schedule that no longer exists says so instead of guessing", async () => {
        const line = await closeRemindedDose({ familyId: "fam-done", recipientUserId: "cg-d", actorUserId: "cg-d",
            message: "I completed schedule gone-1", mayMarkOthers: true });
        assert.match(line ?? "", /could not find that reminder/i);
    });
    await ok("a schedule of another family is never marked", async () => {
        await CareSchedule.create({ ...base, familyId: "fam-other", scheduleId: "other-1", recipientUserId: "x", title: "X", time: "08:00" });
        const line = await closeRemindedDose({ familyId: "fam-done", recipientUserId: "cg-d", actorUserId: "cg-d",
            message: "I completed schedule other-1", mayMarkOthers: true });
        assert.match(line ?? "", /could not find that reminder/i);
    });
    await mongoose.disconnect();
}

void (async () => {
    await pure();
    const uri = testDbUri("done_button");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI)");
    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log(`${passed} passed`);
    process.exit(0);
})();
