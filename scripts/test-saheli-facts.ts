/**
 * A due medicine is a reminder at that time — not a story — and a Done on a reminded dose is taken.
 */
import assert from "node:assert/strict";
import { learnBrief } from "../src/services/agentLoop/learn";
import { resolveItemStatus } from "../src/services/careScheduleCompletion.service";
import { doneScheduleId, isDoseDoneReply } from "../src/services/saheliCareAction.service";
import { medicineDueWindow } from "../src/services/saheliFactGuard.service";
import { toDateKeyIST } from "../src/utils/istTime.util";

let n = 0;
const t = (name: string, fn: () => void) => {
    fn();
    n++;
    console.log(`  ✓ ${name}`);
};

t("Done on a reminded dose stays due, then taken, and is not filed as missed", () => {
    const now = new Date("2026-10-01T07:31:00.000Z");
    const key = toDateKeyIST(now);
    assert.equal(resolveItemStatus({ scheduleTime: "1:00 PM", dateKey: key, now }), "due");
    const later = new Date(now.getTime() + 20 * 60 * 1000);
    assert.equal(resolveItemStatus({ scheduleTime: "1:00 PM", dateKey: toDateKeyIST(later), now: later }), "missed");
    assert.equal(resolveItemStatus({ scheduleTime: "1:00 PM", dateKey: key, now, manualStatus: "completed" }), "completed");
    assert.equal(doneScheduleId("I completed schedule folvite-1"), "folvite-1");
    assert.equal(doneScheduleId("Done"), null);
    assert.equal(isDoseDoneReply("Done"), true);
    assert.equal(isDoseDoneReply("Done ✅"), true);
    assert.equal(isDoseDoneReply("please get atta"), false);
    const brief = learnBrief({
        facts: ["Leela is allergic to milk."],
        record: "",
        medicines: [{ name: "Folvite 5mg", time: "1:00 PM", status: "taken" }],
        routines: [],
        reminders: [],
    });
    assert.match(brief, /Folvite 5mg/);
    assert.match(brief, /taken/);
    assert.doesNotMatch(brief, /missed/);
});

t("a medicine due at its time is sent, and a missed send is not a story", () => {
    assert.equal(medicineDueWindow(0, "missed"), "dose_due");
    assert.equal(medicineDueWindow(1, "due"), "dose_due");
    assert.equal(medicineDueWindow(20, "missed"), "followup");
    assert.equal(medicineDueWindow(0, "completed"), null);
    assert.equal(medicineDueWindow(-5, "upcoming"), null);
});

console.log(`all ${n} passed`);
process.exit(0);
