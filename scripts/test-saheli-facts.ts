/**
 * Replies must not invent a dish, a wake-up, or the name Maa,
 * and a due medicine is a reminder at that time — not a story.
 */
import assert from "node:assert/strict";
import { learnBrief } from "../src/services/agentLoop/learn";
import { resolveItemStatus } from "../src/services/careScheduleCompletion.service";
import { doneScheduleId, isDoseDoneReply } from "../src/services/saheliCareAction.service";
import {
    finishElderReply,
    groundOutreachReply,
    medicineDueWindow,
    refusesMaa,
} from "../src/services/saheliFactGuard.service";
import { toDateKeyIST } from "../src/utils/istTime.util";

let n = 0;
const t = (name: string, fn: () => void) => {
    fn();
    n++;
    console.log(`  ✓ ${name}`);
};

const SLOW = "Main yahin hoon 🙏 Abhi mera connection thoda dheema hai — aapki baat mere paas hai, bas ek baar phir bhej dijiye, main turant jawab doongi.";

t("a check-in with no saved food fact does not mention a dish", () => {
    const reply = groundOutreachReply(
        "Maa, aaj achanak mujhe aapke haath ke us swadist paneer butter masala ki yaad aa rahi thi",
        "",
    );
    assert.equal(reply, "How are you?");
    assert.doesNotMatch(reply, /paneer|masala|biryani/i);
    const kept = groundOutreachReply("You mentioned paneer last week. How are you?", "likes paneer");
    assert.match(kept, /paneer/i);
});

t("a reply that invents a dish fails", () => {
    const reply = finishElderReply({
        inbound: "how are you",
        draft: "I remember the dal makhani you always cook",
        savedFacts: "",
    });
    assert.equal(reply, "How are you?");
    assert.doesNotMatch(reply, /dal makhani/i);
});

t("a model reply is not replaced by matching the question", () => {
    const reply = finishElderReply({
        inbound: "Why did you not remind me for medicine",
        draft: "I missed the medicine reminder. Please take it now.",
        savedFacts: "",
    });
    assert.equal(reply, "I missed the medicine reminder. Please take it now.");
});

t("a stored wake fact is the model's sentence, not a matched phrase", () => {
    const reply = finishElderReply({
        inbound: "Why did you not remind me for medicine. I woke up late",
        draft: "You woke up late. Please take the medicine now.",
        savedFacts: "I woke up late",
    });
    assert.equal(reply, "You woke up late. Please take the medicine now.");
});

t("after dont call me maa the next reply is not Maa and not a resend", () => {
    assert.equal(refusesMaa("Dont call me maa"), true);
    const reply = finishElderReply({
        inbound: "how are you",
        draft: `Maa, ${SLOW}`,
        refusedMaa: true,
    });
    assert.doesNotMatch(reply, /\bmaa\b/i);
    assert.doesNotMatch(reply, /dheema|phir bhej/i);
    assert.match(reply, /How are you/i);
});

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
