/** Languages, dialects and scripts: what Saheli writes and speaks to each person. */
import { buildCareNudgeText, nudgeLanguage } from "../src/services/saheliNudgeCopy.service";
import { DIALECTS, LANGUAGES, dialectBase, normaliseSpeech, replyScript, speechLabel, voiceHint } from "../src/services/language.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

ok("a dialect brings its base language", JSON.stringify(normaliseSpeech({ language: "Marwari" })) === JSON.stringify({ dialect: "mwr", language: "hi" }), normaliseSpeech({ language: "Marwari" }));
ok("dialect by native name and common spellings", normaliseSpeech({ dialect: "मैथिली" }).dialect === "mai" && normaliseSpeech({ dialect: "chhatisgarhi" }).dialect === "hne" && normaliseSpeech({ dialect: "Tulu" }).language === "kn");
ok("old stored values map", normaliseSpeech({ language: "hinglish" }).language === "hi" && normaliseSpeech({ language: "Tamil" }).language === "ta");
ok("unknown dropped, not stored as free text", JSON.stringify(normaliseSpeech({ language: "Klingon" })) === "{}");
ok("script: own script unless Roman asked", replyScript({ language: "hi" }) === "devanagari" && replyScript({ language: "ta" }) === "tamil"
    && replyScript({ language: "hi", script: "roman" }) === "latin" && replyScript({ language: "pa" }) === "gurmukhi");
ok("label", speechLabel({ language: "hi", dialect: "mwr" }) === "Marwari (मारवाड़ी)" && speechLabel({ language: "en" }) === "English");
ok("voice hint: dialect first, its base for the voice", voiceHint({ language: "hi", dialect: "hne" }) === "hne" && dialectBase("hne") === "hi" && dialectBase("syl") === "bn");
ok("every dialect has a known base", DIALECTS.every((d) => LANGUAGES.some((l) => l.code === d.base)));

// Reminders
const dose = (speech: Parameters<typeof buildCareNudgeText>[0]["speech"], pref?: string) =>
    buildCareNudgeText({ nudgeKind: "dose_due", title: "Metformin 500mg", time: "8:00", displayName: "Kamla", addressAs: "अम्मा जी", speech, preferredLanguage: pref });
ok("Hindi reminder in Devanagari", /अभी Metformin 500mg का समय है/.test(dose({ language: "hi" })), dose({ language: "hi" }));
ok("old 'hinglish' setting now gets Devanagari", nudgeLanguage(null, "hinglish") === "hi");
ok("Roman only when asked", nudgeLanguage({ language: "hi", script: "roman" }) === "roman_hi" && /abhi Metformin/.test(dose({ language: "hi", script: "roman" })));
ok("Marwari → Hindi wording in Devanagari", nudgeLanguage({ language: "hi", dialect: "mwr" }) === "hi");
ok("Tamil / Bengali / Marathi in their scripts", /[஀-௿]/.test(dose({ language: "ta" })) && /[ঀ-৿]/.test(dose({ language: "bn" })) && /घेण्याची/.test(dose({ language: "mr" })));
ok("English stays English", /^अम्मा जी, it's time for Metformin/.test(dose({ language: "en" })));
for (const kind of ["dose_due", "pre_reminder", "missed_followup", "completion_praise", "appointment_prep", "daily_schedule"] as const) {
    for (const lang of ["hi", "mr", "bn", "ta", "te", "kn", "ml", "gu", "pa", "or", "en"]) {
        const t = buildCareNudgeText({ nudgeKind: kind, title: "X", time: "9:00", displayName: "D", speech: { language: lang } });
        if (!t.includes("X") || !t.includes("D")) ok(`${kind} ${lang} keeps name and item`, false, t);
    }
}
ok("all reminder kinds × 11 languages fill in name and item", true);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
