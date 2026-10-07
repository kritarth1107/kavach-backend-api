/** Onboarding: prescription timings, answers → care record entries and notes, verification replies, limits. */
import { AnswersSchema, VERIFY_RE, allow, factsFor, noteFor, quietHours, scheduleFromText, splitPhone, verifiedThanks, type Answers } from "../src/services/onboarding.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

// Prescription notes → dose times and food timing
const day = { breakfast: "08:30", lunch: "13:30", dinner: "20:30", activities: [] as string[] };
ok("1-0-1 → morning and night (their meal times)", JSON.stringify(scheduleFromText("1-0-1 after food", day)) === JSON.stringify({ times: ["08:30", "20:30"], food: "after_food" }), scheduleFromText("1-0-1 after food", day));
ok("1-1-1 / TDS → three times", scheduleFromText("1-1-1").times.length === 3 && scheduleFromText("TDS").times.length === 3);
ok("BD → twice; OD → morning; HS → night", scheduleFromText("BD").times.join() === "08:00,21:00" && scheduleFromText("OD").times.join() === "08:00" && scheduleFromText("HS").times.join() === "21:00");
ok("AC → before food; empty stomach", scheduleFromText("OD AC").food === "before_food" && scheduleFromText("morning empty stomach").food === "empty_stomach");
ok("nothing recognisable → no times (never a guess)", scheduleFromText("as directed").times.length === 0);

// Answers
const answers: Answers = AnswersSchema.parse({
    you: { name: "Riya Sharma" }, careFor: "mother",
    persons: [{
        relation: "Mother", name: "Kamla Devi", callThem: "Maa", addressAs: "Maa ji", language: "hi", dialect: "mwr", age: 72, city: "Jodhpur", livesWith: "alone",
        conditions: ["Diabetes (sugar)"], allergies: { items: ["Sulfa drugs"] }, sugarCheck: "daily",
        medicines: [{ name: "Metformin", dose: "500 mg", times: ["08:30", "20:30"], food: "after_food" }],
        day: { wake: "05:30", sleep: "21:30", activities: ["Puja / prayer"], notes: "Maid at 11" }, likes: ["Bhajans"], avoidTopics: "Papa's illness",
        problems: ["Knee pain"], problemsOther: "Misses Papa",
    }],
    helpWith: ["reminders"], followups: [{ q: "Painkiller for the knee?", a: "Volini gel at night" }], anythingElse: "Grandson calls on Sundays",
});
const facts = factsFor(answers.persons[0], answers, "Riya Sharma");
const by = (d: string) => facts.filter((f) => f.domain === d);
ok("naming: what Saheli calls her, and what the family calls her", by("naming")[0]?.details.name === "Maa ji" && by("naming")[0]?.details.family_calls === "Maa");
ok("language: Marwari with its base language", JSON.stringify(by("language")[0]?.details) === JSON.stringify({ dialect: "mwr", language: "hi" }));
ok("medicine with times and food timing (creates reminders)", by("medicine")[0]?.details.food_timing === "after_food" && (by("medicine")[0]?.details.times as string[]).join() === "08:30,20:30");
ok("condition, allergy, routine, home, age, likes, call-first", by("condition").length === 1 && by("allergy")[0]?.details.allergen === "Sulfa drugs" && by("routine").some((f) => f.name === "wake")
    && by("routine").some((f) => f.name === "sugar_check") && by("home")[0]?.sentence.includes("alone") && by("profile")[0]?.details.age === 72 && by("family")[0]?.name === "call_first");
ok("'no allergies' saves none", factsFor({ ...answers.persons[0], allergies: { none: true, items: ["x"] } }, answers, "R").filter((f) => f.domain === "allergy").length === 0);
const note = noteFor(answers.persons[0], answers);
ok("note carries the soft context", note.includes("Knee pain") && note.includes("Misses Papa") && note.includes("Volini") && note.includes("Grandson") && note.includes("Maid at 11"));
ok("answers must name the person and a valid number", !AnswersSchema.safeParse({ you: { name: "R" }, careFor: "mother", persons: [{ relation: "Mother", name: "" }] }).success
    && !AnswersSchema.safeParse({ ...answers, persons: [{ ...answers.persons[0], phone: "98765" }] }).success);

// Verification thank-you in their language and dialect
ok("Marwari greeting in Devanagari", verifiedThanks({ language: "hi", dialect: "mwr" }, "Maa ji").startsWith("राम राम सा Maa ji"));
ok("Tamil in Tamil script", /[஀-௿]/.test(verifiedThanks({ language: "ta" }, "Amma")));
ok("unknown language → Hindi", verifiedThanks({}, "").startsWith("नमस्ते"));

// Blank boxes, phone numbers, quiet hours, the WhatsApp code
const blank = AnswersSchema.safeParse({ ...answers, you: { name: "Riya", phone: "+91" }, persons: [{ ...answers.persons[0], phone: "", day: { wake: "", sleep: "21:30", activities: [] }, medicines: [{ name: "X", times: ["", "08:00"] }] }] });
ok("empty time and a lone country code mean 'not given'", blank.success && blank.data.you.phone === undefined && blank.data.persons[0].phone === undefined && blank.data.persons[0].day.wake === undefined && blank.data.persons[0].medicines[0].times.join() === "08:00", blank.success ? undefined : blank.error.issues[0]);
ok("phone split by known country code", JSON.stringify(splitPhone("+919876543210")) === JSON.stringify({ cc: "+91", number: "9876543210" })
    && JSON.stringify(splitPhone("+971501234567")) === JSON.stringify({ cc: "+971", number: "501234567" })
    && JSON.stringify(splitPhone("+6581234567")) === JSON.stringify({ cc: "+65", number: "81234567" })
    && JSON.stringify(splitPhone("+14155550123")) === JSON.stringify({ cc: "+1", number: "4155550123" }), splitPhone("+971501234567"));
ok("quiet hours: bedtime to waking when no dose falls inside", JSON.stringify(quietHours("21:30", "05:30", ["08:30", "20:30"])) === JSON.stringify({ start: "21:30", end: "05:30" }));
ok("quiet hours shrink around a late and an early dose", JSON.stringify(quietHours("21:00", "07:00", ["22:00", "06:00"])) === JSON.stringify({ start: "22:30", end: "06:00" }), quietHours("21:00", "07:00", ["22:00", "06:00"]));
ok("quiet hours: none when doses leave under 2 hours", JSON.stringify(quietHours("22:00", "06:00", ["01:00", "02:00"])) === "{}" && JSON.stringify(quietHours(undefined, "06:00")) === JSON.stringify({ end: "06:00" }), quietHours("22:00", "06:00", ["01:00", "02:00"]));
ok("WhatsApp code only as the whole message", VERIFY_RE.test("KAVACH 123456") && VERIFY_RE.test(" kavach-123456 ") && !VERIFY_RE.test("my code is KAVACH 123456 ok") && !VERIFY_RE.test("KAVACH 1234567"));

// Model-call limits
ok("limit per caregiver per hour", [1, 2, 3].every(() => allow("u1", "rx", 3, 1000)) && !allow("u1", "rx", 3, 1000) && allow("u2", "rx", 3, 1000) && allow("u1", "rx", 3, 1000 + 3_600_001));

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
