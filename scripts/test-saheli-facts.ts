/**
 * Replies must not invent a dish, a wake-up, or the name Maa,
 * and a due medicine is a reminder at that time — not a story.
 */
import assert from "node:assert/strict";
import {
    finishElderReply,
    groundOutreachReply,
    medicineDueWindow,
    refusesMaa,
} from "../src/services/saheliFactGuard.service";

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

t("a missed medicine reminder is not explained with an early wake", () => {
    const reply = finishElderReply({
        inbound: "Why did you not remind me for medicine",
        draft: "I let you rest because you were awake early",
        savedFacts: "",
    });
    assert.match(reply, /missed the medicine reminder/i);
    assert.match(reply, /take it now/i);
    assert.doesNotMatch(reply, /awake early/i);
});

t("I woke up late replaces the early-wake story", () => {
    const reply = finishElderReply({
        inbound: "Why did you not remind me for medicine. I woke up late",
        draft: "You were awake early so I let you rest",
        savedFacts: "",
    });
    assert.match(reply, /woke up late/i);
    assert.match(reply, /take the medicine now/i);
    assert.doesNotMatch(reply, /awake early/i);
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

t("a medicine due at its time is sent, and a missed send is not a story", () => {
    assert.equal(medicineDueWindow(0, "missed"), "dose_due");
    assert.equal(medicineDueWindow(1, "due"), "dose_due");
    assert.equal(medicineDueWindow(20, "missed"), "followup");
    assert.equal(medicineDueWindow(0, "completed"), null);
    assert.equal(medicineDueWindow(-5, "upcoming"), null);
});

console.log(`all ${n} passed`);
process.exit(0);
