/**
 * Saheli reminders: schedules (once on a date, every day, chosen weekdays, every hour in a window that may cross
 * midnight, start/end dates, skips), the scheduler following them, the calendar's day view, and who may manage whose
 * reminders. Founder 2026-10-12: reminders show in the calendar and can be skipped or stopped there or on WhatsApp.
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/remtest NODE_ENV=test npx tsx scripts/test-reminders.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { describe as words, nextOccurrence, readSchedule, slotsOn } from "../src/services/reminderSchedule.service";

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

// 2026-10-12 is a Monday
const MON = "2026-10-12", TUE = "2026-10-13", WED = "2026-10-14", SUN = "2026-10-11";
const at = (day: string, hm: string) => new Date(`${day}T${hm}:00+05:30`);

async function pure() {
    console.log("pure");
    await ok("every day at the listed times; older reminders without repeat are daily", () => {
        assert.deepEqual(slotsOn({ kind: "multi_time", times: ["19:30", "7:00"] } as never, MON), ["07:00", "19:30"]);
    });
    await ok("once: only on its date", () => {
        const r = { kind: "multi_time", times: ["17:00"], repeat: "once", date: WED } as never;
        assert.deepEqual(slotsOn(r, TUE), []);
        assert.deepEqual(slotsOn(r, WED), ["17:00"]);
        assert.deepEqual(nextOccurrence(r, MON, 600), { day: WED, time: "17:00" });
        assert.equal(nextOccurrence(r, WED, 17 * 60 + 1), null);
    });
    await ok("weekly: only on its days (0 = Sunday)", () => {
        const r = { kind: "multi_time", times: ["07:00"], repeat: "weekly", daysOfWeek: [1, 3, 5] } as never;
        assert.deepEqual(slotsOn(r, MON), ["07:00"]);
        assert.deepEqual(slotsOn(r, TUE), []);
        assert.deepEqual(nextOccurrence(r, MON, 8 * 60), { day: WED, time: "07:00" });
    });
    await ok("an hourly window across midnight belongs to the day it starts", () => {
        const r = { kind: "hourly_window", windowStartMinutes: 22 * 60, windowEndMinutes: 60, repeat: "weekly", daysOfWeek: [1] } as never;
        assert.deepEqual(slotsOn(r, MON), ["22:00", "23:00"], "Monday's window; Monday 00:00 belongs to Sunday's (not scheduled)");
        assert.deepEqual(slotsOn(r, TUE), ["00:00", "01:00"], "the rest of Monday's window");
        assert.deepEqual(slotsOn(r, SUN), []);
        const daily = { kind: "hourly_window", windowStartMinutes: 14 * 60, windowEndMinutes: 3 * 60 } as never;
        assert.equal(slotsOn(daily, MON).length, 14);
        assert.equal(words(daily), "Every hour 14:00–03:00");
    });
    await ok("start and end dates bound it; skips drop one time or a whole day", () => {
        const r = { kind: "multi_time", times: ["09:00", "21:00"], endDate: TUE, skips: [`${MON}@21:00`, TUE] } as never;
        assert.deepEqual(nextOccurrence(r, MON, 10 * 60), null, "21:00 Monday skipped, Tuesday skipped, then it has ended");
        assert.deepEqual(nextOccurrence({ ...(r as object), skips: [] } as never, MON, 10 * 60), { day: MON, time: "21:00" });
        assert.deepEqual(slotsOn({ kind: "multi_time", times: ["09:00"], startDate: TUE } as never, MON), []);
    });
    await ok("schedules read as data: bad ones are refused with a reason, nothing is guessed", () => {
        assert.equal(readSchedule({ times: ["7:30"] }, MON).ok, true);
        assert.deepEqual((readSchedule({ times: ["7:30"] }, MON) as { fields: { times: string[] } }).fields.times, ["07:30"]);
        assert.match((readSchedule({ times: ["19:00"], repeat: "once" }, MON) as { error: string }).error, /date/);
        assert.match((readSchedule({ times: ["19:00"], repeat: "once", date: SUN }, MON) as { error: string }).error, /gone/);
        assert.match((readSchedule({ times: ["19:00"], repeat: "weekly" }, MON) as { error: string }).error, /days/);
        assert.match((readSchedule({ windowStart: "14:00" }, MON) as { error: string }).error, /start and an end/);
        assert.match((readSchedule({ times: [] }, MON) as { error: string }).error, /time/);
        assert.equal(words({ kind: "multi_time", times: ["17:00"], repeat: "once", date: WED } as never), "Once on Wed 14 Oct at 17:00");
        const night = ["00:00", "01:00", "02:00", "03:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00", "22:00", "23:00"];
        assert.equal(words({ kind: "multi_time", times: night } as never), "14 times a day, 14:00 to 03:00", "a run across midnight reads as one");
        assert.equal(words({ kind: "multi_time", times: ["07:00"], repeat: "weekly", daysOfWeek: [5, 1, 3], endDate: "2026-11-30" } as never),
            "Mon, Wed, Fri at 07:00 until Mon 30 Nov");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const Family = (await import("../src/models/family.model")).default;
    const { FamilyRole, FamilyMemberStatus } = await import("../src/types/family.types");
    await Family.create({
        familyId: "famR",
        name: "Reminder family",
        createdBy: "cg1",
        members: [
            { userId: "cg1", role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED },
            { userId: "cg2", role: FamilyRole.CO_CAREGIVER, status: FamilyMemberStatus.JOINED },
            { userId: "el1", role: FamilyRole.CARE_RECIPIENT, status: FamilyMemberStatus.JOINED, name: "El" },
            { userId: "vo1", role: FamilyRole.VIEW_ONLY, status: FamilyMemberStatus.JOINED },
        ],
    });
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");
    const R = await import("../src/services/saheliReminder.service");
    const SaheliReminder = (await import("../src/models/saheliReminder.model")).default;
    const SaheliNudgeLog = (await import("../src/models/saheliNudgeLog.model")).default;
    const tool = (name: string, args: Record<string, unknown>, recipient = "el1", actor = "el1") =>
        executeSaheliTool({ tool: name as never, args, familyId: "famR", recipientUserId: recipient, actorUserId: actor }) as Promise<Record<string, any>>;

    let gym = "", bank = "", yoga = "", smoke = "";
    await ok("Saheli sets reminders from data: every day, once on a date, weekdays, an hourly window", async () => {
        const a = await tool("create_reminder", { text: "Get ready for the gym", schedule: { times: ["19:30"] } }, "cg1", "cg1");
        assert.equal(a.status, "created");
        gym = a.reminder.reminderId;
        assert.equal(a.reminder.schedule, "Every day at 19:30");
        const b = await tool("create_reminder", { text: "Call the bank", schedule: { times: ["17:00"], repeat: "once", date: WED } }, "cg1", "cg1");
        bank = b.reminder.reminderId;
        const c = await tool("create_reminder", { text: "Yoga", schedule: { times: ["07:00"], repeat: "weekly", days: [1, 3, 5] } }, "cg1", "cg1");
        yoga = c.reminder.reminderId;
        const d = await tool("create_reminder", { text: "Skip the cigarette", schedule: { windowStart: "14:00", windowEnd: "03:00" } }, "cg1", "cg1");
        smoke = d.reminder.reminderId;
        assert.equal(d.reminder.kind, "hourly_window");
        // the words are never read for a time when a schedule is given
        const e = await tool("create_reminder", { text: "every hour from 9 pm drink water", schedule: { times: ["10:00"] } }, "el1", "el1");
        assert.deepEqual([e.reminder.kind, e.reminder.times], ["multi_time", ["10:00"]]);
        const bad = await tool("create_reminder", { text: "Pay rent", schedule: { times: ["10:00"], repeat: "once" } }, "el1", "el1");
        assert.equal(bad.status, "not_set");
        assert.match(bad.error, /date/);
    });

    await ok("who may manage whose reminders: own, or a care recipient's as a caregiver; never another caregiver's", async () => {
        await assert.rejects(tool("list_reminders", {}, "cg1", "cg2"), /permission/);
        await assert.rejects(tool("list_reminders", {}, "el1", "vo1"), /permission/);
        await assert.rejects(tool("create_reminder", { text: "x", schedule: { times: ["10:00"] } }, "cg1", "el1"), /permission/);
        const mine = await tool("list_reminders", {}, "cg1", "cg1");
        assert.equal(mine.reminders.length, 4);
        const elders = await tool("list_reminders", {}, "el1", "cg2");
        assert.equal(elders.reminders.length, 1, "a co-caregiver sees the care recipient's");
    });

    await ok("the scheduler follows the schedule, skips and the end date; a once reminder finishes after it goes out", async () => {
        const fired: string[] = [];
        const fire = async (i: { reminder: { reminderId: string }; slotKey: string; dateKey: string }) => {
            fired.push(`${i.reminder.reminderId === gym ? "gym" : i.reminder.reminderId === bank ? "bank" : i.reminder.reminderId === yoga ? "yoga" : i.reminder.reminderId === smoke ? "smoke" : "other"} ${i.dateKey} ${i.slotKey}`);
            return true;
        };
        await R.runSaheliReminderTick(at(MON, "07:05"), fire as never);
        await R.runSaheliReminderTick(at(TUE, "07:00"), fire as never);
        assert.deepEqual(fired, [`yoga ${MON} 07:00`], "yoga on Monday (5 minutes late is still sent), not on Tuesday");
        fired.length = 0;
        await R.runSaheliReminderTick(at(TUE, "17:00"), fire as never);
        await R.runSaheliReminderTick(at(WED, "17:02"), fire as never);
        assert.deepEqual(fired.filter((f) => !f.startsWith("smoke")), [`bank ${WED} 17:00`], "the bank call only on its date");
        assert.deepEqual(fired.filter((f) => f.startsWith("smoke")), [`smoke ${TUE} 17:00`, `smoke ${WED} 17:00`], "the hourly one every day");
        fired.length = 0;
        await R.runSaheliReminderTick(at(WED, "17:20"), fire as never);
        assert.equal((await SaheliReminder.findOne({ reminderId: bank }).lean())!.status, "completed", "nothing left to send");
        await R.runSaheliReminderTick(at(MON, "02:00"), fire as never);
        assert.deepEqual(fired, [`smoke ${MON} 02:00`], "an hour after midnight of a window that started the day before");
        fired.length = 0;
        const skip = await tool("skip_reminder", { reminderId: gym, date: TUE }, "cg1", "cg1");
        assert.equal(skip.ok, true);
        await R.runSaheliReminderTick(at(TUE, "19:30"), fire as never);
        await R.runSaheliReminderTick(at(MON, "19:31"), fire as never);
        assert.deepEqual(fired, [`gym ${MON} 19:30`], "skipped on Tuesday only");
        fired.length = 0;
        await R.runSaheliReminderTick(at(MON, "19:50"), fire as never);
        assert.deepEqual(fired, [], "more than 15 minutes late: not sent");
    });

    await ok("skip with no day skips the next time; undo brings it back", async () => {
        const s = await R.skipSaheliReminder({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", reminderId: yoga, now: at(MON, "08:00") });
        assert.equal(s.ok && s.skipped, `${WED}@07:00`);
        const u = await R.skipSaheliReminder({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", reminderId: yoga, day: WED, time: "07:00", undo: true, now: at(MON, "08:00") });
        assert.equal(u.ok && u.reminder.skips.includes(`${WED}@07:00`), false);
        const bad = await R.skipSaheliReminder({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", reminderId: yoga, day: TUE, now: at(MON, "08:00") });
        assert.equal(bad.ok, false);
    });

    await ok("change the time or the days; what is not given stays", async () => {
        const out = await tool("update_reminder", { reminderId: gym, schedule: { times: ["19:00"] } }, "cg1", "cg1");
        assert.equal(out.ok, true);
        assert.equal(out.reminder.schedule, "Every day at 19:00");
        const weekly = await tool("update_reminder", { reminderId: gym, schedule: { repeat: "weekly", days: [1, 3] } }, "cg1", "cg1");
        assert.equal(weekly.reminder.schedule, "Mon, Wed at 19:00");
        const back = await tool("update_reminder", { reminderId: gym, schedule: { times: ["19:30"], repeat: "daily" } }, "cg1", "cg1");
        assert.equal(back.reminder.schedule, "Every day at 19:30");
    });

    await ok("the calendar's day: each time with what happened (sent, failed, skipped, not sent, scheduled)", async () => {
        await SaheliNudgeLog.create({ nudgeId: "n1", familyId: "famR", recipientUserId: "cg1", scheduleId: `reminder:${smoke}:14:00`, dateKey: MON,
                                      nudgeKind: "pre_reminder", delivered: true, channel: "whatsapp" });
        await SaheliNudgeLog.create({ nudgeId: "n2", familyId: "famR", recipientUserId: "cg1", scheduleId: `reminder:${smoke}:15:00`, dateKey: MON,
                                      nudgeKind: "pre_reminder", delivered: false, terminal: true, reason: "invalid_recipient", channel: "whatsapp" });
        await SaheliReminder.updateMany({}, { $set: { createdAt: at(SUN, "10:00") } }, { timestamps: false });
        await R.skipSaheliReminder({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", reminderId: smoke, day: MON, time: "17:00", now: at(MON, "09:00") });
        const view = await R.remindersForDay({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", day: MON, now: at(MON, "18:00") });
        const st = (id: string, t: string) => view.occurrences.find((o) => o.reminderId === id && o.time === t)?.status;
        assert.equal(st(smoke, "14:00"), "sent");
        assert.equal(st(smoke, "15:00"), "failed");
        assert.equal(st(smoke, "16:00"), "not_sent");
        assert.equal(st(smoke, "17:00"), "skipped");
        assert.equal(st(smoke, "19:00"), "scheduled");
        assert.equal(st(gym, "19:30"), "scheduled");
        assert.equal(st(yoga, "07:00"), "not_sent");
        assert.equal(view.occurrences.find((o) => o.reminderId === smoke)?.many, true);
        assert.equal(view.occurrences.find((o) => o.reminderId === gym)?.many, false);
        assert.equal(view.occurrences.some((o) => o.reminderId === bank), false, "the bank call is on Wednesday");
        const dentist = await R.createSaheliReminder({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", text: "Dentist",
                                                       schedule: { times: ["11:00"], repeat: "once", date: WED }, now: at(MON, "18:00") });
        assert.equal(dentist.ok, true);
        const wed = await R.remindersForDay({ familyId: "famR", recipientUserId: "cg1", actorUserId: "cg1", day: WED, now: at(MON, "18:00") });
        const d = dentist.ok ? dentist.reminder.reminderId : "";
        assert.deepEqual(wed.occurrences.filter((o) => o.reminderId === d).map((o) => [o.time, o.status]), [["11:00", "scheduled"]],
            "a future day shows what is coming");
    });

    await ok("stop: it never goes out again, and the day still shows what went out before", async () => {
        const out = await tool("cancel_reminder", { reminderId: smoke }, "cg1", "cg1");
        assert.equal(out.ok, true);
        assert.equal(out.reminder.status, "cancelled");
        assert.equal(out.reminder.stoppedBy, "cg1");
        const fired: string[] = [];
        await R.runSaheliReminderTick(at(TUE, "20:00"), (async (i: { slotKey: string }) => { fired.push(i.slotKey); return true; }) as never);
        assert.equal(fired.includes("20:00"), false);
        const all = await tool("list_reminders", { status: "all" }, "cg1", "cg1");
        assert.equal(all.reminders.some((r: { reminderId: string; status: string }) => r.reminderId === smoke && r.status === "cancelled"), true);
    });
}

(async () => {
    await pure();
    const uri = process.env.TEST_MONGODB_URI;
    if (uri) {
        try {
            await withDb(uri);
        } finally {
            await new Promise((r) => setTimeout(r, 500)); // let the activity-log writes land
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
