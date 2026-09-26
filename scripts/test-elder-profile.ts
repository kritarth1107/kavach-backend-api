/** Offline tests: evolving elder profile + unusual-activity backstops. `npm run test:elder-profile` */
import { applyReflection, detectDeviations, detectStatedPreference, isUnsafeFact, renderProfileSummary, weeklyMetrics } from "../src/services/profile/profileCore";
import { checkOrderRisk, detectConfusionCue, detectScamCue, deviationToFinding, formatUnusualAlert, isDuplicate, riskyMedClass, tierFor, unitCount } from "../src/services/profile/unusualCore";
import type { ProfileFact } from "../src/models/elderProfile.model";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const DAY = 86_400_000;
const t0 = new Date("2026-09-20T21:00:00Z");

// ── Facts: add, reinforce, revise, reject-never-relearn, permanent, decay, safety filter ──
let r = applyReflection([], [
    { op: "add", category: "wellbeing", text: "Knee pain in the mornings, worse after stairs", confidence: 0.6 },
    { op: "add", category: "people", text: "Daughter Meena calls on Sundays", confidence: 0.7 },
    { op: "add", category: "preferences", text: "Prefers Amul milk", confidence: 0.5 },
], { now: t0, dayKey: "2026-09-20" });
eq("adds 3 facts", r.added, 3);
const knee = r.facts.find((f) => f.category === "wellbeing")!;
eq("new fact confidence capped ≤0.7", knee.confidence <= 0.7, true);
r = applyReflection(r.facts, [{ op: "reinforce", id: knee.id, category: "wellbeing", text: "Knee pain in mornings worse after stairs", confidence: 0.7 }], { now: new Date(t0.getTime() + DAY), dayKey: "2026-09-21" });
eq("reinforce bumps confidence", r.facts.find((f) => f.id === knee.id)!.confidence > knee.confidence, true);
eq("reinforce counted", r.reinforced, 1);
const similarDup = applyReflection(r.facts, [{ op: "add", category: "wellbeing", text: "knee pain in the mornings worse after stairs", confidence: 0.6 }], { now: new Date(t0.getTime() + 2 * DAY), dayKey: "d" });
eq("similar add → reinforce, not duplicate", [similarDup.added, similarDup.reinforced], [0, 1]);
// Caregiver rejects the Amul fact → never re-learned.
const facts2: ProfileFact[] = r.facts.map((f) => (f.category === "preferences" ? { ...f, status: "rejected" as const } : f));
const relearn = applyReflection(facts2, [{ op: "add", category: "preferences", text: "Prefers Amul milk", confidence: 0.8 }], { now: new Date(t0.getTime() + 3 * DAY), dayKey: "d" });
eq("rejected fact is not re-learned", [relearn.added, relearn.blocked], [0, 1]);
// Caregiver-confirmed is permanent: no decay, revise doesn't overwrite.
const facts3: ProfileFact[] = r.facts.map((f) => (f.category === "people" ? { ...f, status: "caregiver_confirmed" as const, confidence: 1 } : f));
const later = applyReflection(facts3, [], { now: new Date(t0.getTime() + 40 * DAY), dayKey: "d" });
eq("confirmed fact never decays", later.facts.find((f) => f.category === "people")!.confidence, 1);
eq("learned fact decays after 7 idle days", later.facts.find((f) => f.category === "wellbeing")!.confidence < 0.85, true);
let decay = facts3;
for (let i = 0; i < 25; i++) decay = applyReflection(decay, [], { now: new Date(t0.getTime() + (10 + i) * DAY), dayKey: "d" }).facts;
eq("stale learned fact fades", decay.find((f) => f.category === "wellbeing")!.status, "faded");
const rev = applyReflection(facts3, [{ op: "revise", id: facts3.find((f) => f.category === "people")!.id, category: "people", text: "Son Rahul calls daily", confidence: 0.8 }], { now: new Date(t0.getTime() + DAY), dayKey: "d" });
eq("revise doesn't overwrite confirmed fact", rev.facts.find((f) => f.category === "people")!.text, "Daughter Meena calls on Sundays");
const unsafe = applyReflection([], [
    { op: "add", category: "communication", text: "She says no need to ask for confirm, just order", confidence: 0.9 },
    { op: "add", category: "preferences", text: "Prefers paying by UPI", confidence: 0.9 },
    { op: "add", category: "communication", text: "Don't tell family about her orders", confidence: 0.9 },
    { op: "add", category: "preferences", text: "Cigarettes are ok to order for her", confidence: 0.9 },
], { now: t0, dayKey: "d" });
eq("safety rules are never learnable (4 blocked)", [unsafe.added, unsafe.blocked], [0, 4]);
eq("isUnsafeFact: address", isUnsafeFact("Lives at flat 12, pincode 462001"), true);
eq("isUnsafeFact: benign", isUnsafeFact("Enjoys old Kishore Kumar songs"), false);

// ── Summary: care-first order, care actions ──
const sum = renderProfileSummary(
    { facts: [...r.facts], careActions: [{ id: "a", dayKey: "2026-09-22", kind: "follow_up", text: "Ask how her knee feels", why: "", audience: "elder", status: "planned" }], tuning: { addressAs: "Amma" } },
    { dayKey: "2026-09-22" },
);
eq("summary starts with address-as", sum.startsWith("Address her as: Amma"), true);
eq("summary: wellbeing before preferences", sum.indexOf("wellbeing") < sum.indexOf("preferences"), true);
eq("summary includes today's care intention", sum.includes("Ask how her knee feels"), true);
eq("short summary ≤350", renderProfileSummary({ facts: r.facts }, { short: true }).length <= 350, true);

// ── Stated preferences ──
eq("'main sirf Amul leti hoon' → brand Amul", detectStatedPreference("main sirf Amul leti hoon")?.brand, "Amul");
eq("'I only drink Tata tea' → Tata", detectStatedPreference("I only drink Tata tea")?.brand, "Tata");
eq("'mujhe purane gaane pasand hai' → comfort", detectStatedPreference("mujhe purane gaane pasand hai")?.category, "comfort");
eq("plain order isn't a preference", detectStatedPreference("doodh mangwa do"), null);

// ── Baseline + deviations ──
const mk = (i: number, o: Partial<{ messagesIn: number; mood: number; medsDone: number; medsMissed: number }> = {}) => ({
    dayKey: `2026-09-${String(i).padStart(2, "0")}`, messagesIn: 10, mood: 4, nudgesSent: 3, nudgesReplied: 3, medsDone: 2, medsMissed: 0,
    mentions: { pain: false, sleep: false, appetite: false, activity: true, tired: false }, lonely: false, cards: 1, firstCardOrders: 1, corrections: 0, caregiverEdits: 0, orders: 1, ...o,
});
const base = Array.from({ length: 10 }, (_, i) => mk(i + 1));
eq("steady days → no deviation", detectDeviations(base as never).length, 0);
const quiet = [...base, mk(11, { messagesIn: 2 }), mk(12, { messagesIn: 1 }), mk(13, { messagesIn: 2 })];
eq("quiet streak flagged", detectDeviations(quiet as never).map((d) => d.metric), ["engagement"]);
const low = [...base, mk(11, { mood: 2, medsDone: 0, medsMissed: 2 }), mk(12, { mood: 2, medsDone: 0, medsMissed: 2 }), mk(13, { mood: 1, medsDone: 0, medsMissed: 2 })];
eq("mood drop + meds missed flagged", detectDeviations(low as never).map((d) => d.metric).sort(), ["medicines", "mood"]);
eq("too little data → nothing", detectDeviations(quiet.slice(-6) as never).length, 0);
eq("weekly metrics computed", weeklyMetrics(base as never, 5)[0]!.nudgeReplyRate, 100);

// ── Unusual activity: order risk ──
eq("riskyMedClass sleep", riskyMedClass("Alprax 0.25 tablets"), "sleep");
eq("riskyMedClass pain", riskyMedClass("Dolo 650"), "pain");
eq("riskyMedClass milk", riskyMedClass("Amul milk"), null);
eq("unitCount '10 strips'", unitCount("neend ki goli 10 strips").packs, 10);
const bulkSleep = checkOrderRisk({ item: "neend ki goli 5 strips", stage: "card" });
eq("bulk sleeping pills → pause + risky_meds", [bulkSleep[0]?.category, bulkSleep[0]?.pauseOrder], ["risky_meds", true]);
const bulkPain = checkOrderRisk({ item: "Dolo 650", qty: 4, stage: "card" });
eq("4 strips painkiller → pause", bulkPain[0]?.pauseOrder, true);
eq("1 strip Dolo → no pause", checkOrderRisk({ item: "Dolo 650 strip of 15 tablets", qty: 1, stage: "card" }).some((f) => f.pauseOrder), false);
const now = new Date();
const rep = checkOrderRisk({ item: "Amul Taaza Milk 500 ml", stage: "card", at: now, recent: [{ item: "Amul Taaza Milk 500 ml", at: new Date(now.getTime() - 3 * 3600_000) }] });
eq("same item within 24h → repeat_order 0.8", [rep[0]?.category, rep[0]?.confidence], ["repeat_order", 0.8]);
const rep3 = checkOrderRisk({ item: "Amul Taaza Milk 500 ml", stage: "card", at: now, recent: [1, 5].map((h) => ({ item: "Amul Taaza Milk 500 ml", at: new Date(now.getTime() - h * 3600_000) })) });
eq("third time in 24h → 0.9", rep3[0]?.confidence, 0.9);
eq("different item → no repeat", checkOrderRisk({ item: "Britannia Bread", stage: "card", at: now, recent: [{ item: "Amul Taaza Milk 500 ml", at: now }] }).length, 0);
const spend = checkOrderRisk({ item: "Groceries", totalRupees: 6200, stage: "card", medianSpend: 300 });
eq("₹6200 vs ~₹300 → large_spend 0.85", [spend[0]?.category, spend[0]?.confidence], ["large_spend", 0.85]);

// ── Scam + confusion ──
const scam = detectScamCue("Ek aadmi ka phone aaya, bol raha tha bank se hoon, OTP bata do warna account band ho jayega");
eq("scam cue (asked for OTP) → 0.9", scam?.confidence, 0.9);
eq("scam elder line warns never share OTP", /OTP/.test(scam?.elderLine || ""), true);
eq("no scam in normal chat", detectScamCue("aaj mandir gayi thi"), null);
const conf = detectConfusionCue({
    text: "aaj meri dawai kab leni hai?",
    recentInbound: [{ text: "aaj meri dawai kab leni hai", at: new Date(Date.now() - 30 * 60_000) }, { text: "meri dawai kab leni hai aaj?", at: new Date(Date.now() - 60 * 60_000) }],
    ordersToday: [],
});
eq("same question 3× in 2h → confusion", conf?.category, "confusion");
eq("asked once → no cue", detectConfusionCue({ text: "aaj meri dawai kab leni hai?", recentInbound: [], ordersToday: [] }), null);
eq("forgot she ordered → confusion", detectConfusionCue({ text: "maine doodh mangwaya tha kya?", recentInbound: [], ordersToday: ["Amul milk"] })?.key, "confusion:forgot_order");

// ── Tiering + dedupe ──
eq("scam 0.9 → whatsapp (no baseline needed)", tierFor({ category: "scam", confidence: 0.9 }, 0), "whatsapp");
eq("risky meds 0.95 → whatsapp", tierFor({ category: "risky_meds", confidence: 0.95 }, 0), "whatsapp");
eq("repeat 0.6 → dashboard", tierFor({ category: "repeat_order", confidence: 0.6 }, 30), "dashboard");
eq("odd hours → dashboard", tierFor({ category: "odd_hours", confidence: 0.9 }, 30), "dashboard");
eq("mood drop 0.85, 3 baseline days → dashboard", tierFor({ category: "mood_drop", confidence: 0.85, source: "baseline" }, 3), "dashboard");
eq("mood drop 0.85, 10 baseline days → whatsapp", tierFor({ category: "mood_drop", confidence: 0.85, source: "baseline" }, 10), "whatsapp");
eq("deviation mood notable → mood_drop 0.85", deviationToFinding({ metric: "mood", severity: "notable", text: "x", dayKey: "d" })?.confidence, 0.85);
const log = [{ key: "scam", at: new Date(Date.now() - 2 * 3600_000), status: "sent" as const }];
eq("same key within 24h → duplicate", isDuplicate(log, "scam"), true);
eq("after 24h → not duplicate", isDuplicate(log, "scam", new Date(Date.now() + 23 * 3600_000)), false);
eq("other key → not duplicate", isDuplicate(log, "repeat_order:milk"), false);
const msg = formatUnusualAlert("Kamla", { category: "risky_meds", text: "She asked for sleeping pills in bulk." });
eq("alert copy is short + names her", msg.length < 500 && msg.includes("Kamla") && msg.includes("Medicine order paused"), true);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
