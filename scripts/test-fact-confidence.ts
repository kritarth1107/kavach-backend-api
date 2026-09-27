/** Offline tests: per-class decay, contradictions, opportunity-aware decay, evidence weighting, check-ins. `npm run test:fact-confidence` */
import { applyReflection, weeklyMetrics, type FactJudgement } from "../src/services/profile/profileCore";
import { DECAY, FADE_BELOW } from "../src/services/profile/factPolicy";
import type { ProfileFact } from "../src/models/elderProfile.model";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const DAY = 86_400_000;
const t0 = new Date("2026-09-01T21:00:00Z");
const at = (d: number) => ({ now: new Date(t0.getTime() + d * DAY), dayKey: `d${d}` });

let r = applyReflection([], [
    { op: "add", category: "health", text: "Has type 2 diabetes", confidence: 0.8, by: "elder", decayClass: "health_condition" },
    { op: "add", category: "health", text: "Lactose intolerant, avoids regular milk", confidence: 0.7, by: "caregiver", decayClass: "allergy" },
    { op: "add", category: "medicines", text: "Takes Telma 40 for BP every morning", confidence: 0.8, by: "elder", decayClass: "medication" },
    { op: "add", category: "routine", text: "Walks in the park every evening", confidence: 0.75, by: "elder", decayClass: "routine" },
    { op: "add", category: "preferences", text: "Prefers Amul Taaza milk", confidence: 0.55, by: "orders", decayClass: "preference" },
    { op: "add", category: "wellbeing", text: "Knee pain this week", confidence: 0.6, by: "elder", decayClass: "transient_state" },
    { op: "add", category: "health", text: "Might have trouble hearing on calls", confidence: 0.7, by: "inferred", decayClass: "health_condition" },
], { ...at(0), sourceBy: "inferred" });
const F = (fs: ProfileFact[], s: string) => fs.find((f) => f.text.startsWith(s))!;
eq("evidence weighting: elder-said starts 0.75 cap", F(r.facts, "Has type 2").confidence, 0.75);
eq("evidence weighting: orders capped at 0.55", F(r.facts, "Prefers Amul").confidence, 0.55);
eq("evidence weighting: Gemini guess (inferred) starts 0.4", F(r.facts, "Might have").confidence, 0.4);
eq("source stored with by + strength", [F(r.facts, "Has type 2").sources[0]!.by, F(r.facts, "Has type 2").sources[0]!.strength], ["elder", "strong"]);

const silentAll = (fs: ProfileFact[], opp = true): FactJudgement[] => fs.map((f) => ({ id: f.id, verdict: "silent", opportunity: opp }));

// 1) No activity days → no decay at all (60 nights).
let quiet = r.facts;
for (let d = 1; d <= 60; d++) quiet = applyReflection(quiet, [], { ...at(d), judgements: silentAll(quiet, true), activeDay: false }).facts;
eq("60 no-activity days → every confidence unchanged", quiet.map((f) => f.confidence), r.facts.map((f) => f.confidence));
let noOpp = r.facts;
for (let d = 1; d <= 60; d++) noOpp = applyReflection(noOpp, [], { ...at(d), judgements: silentAll(noOpp, false), activeDay: true }).facts;
eq("60 active days with no opportunity → unchanged", noOpp.map((f) => f.confidence), r.facts.map((f) => f.confidence));

// 2) Simulated idle weeks WITH opportunity every day (8 weeks).
let idle = r.facts;
const qs: string[] = [];
const open = new Set<string>(); // unanswered questions (the service passes these from the profile)
const trace: Record<string, number[]> = {};
for (let d = 1; d <= 56; d++) {
    const x = applyReflection(idle, [], { ...at(d), judgements: silentAll(idle), activeDay: true, openQuestionFactIds: open });
    idle = x.facts;
    x.questions.forEach((q) => open.add(q.factId));
    qs.push(...x.questions.map((q) => `${d}:${q.trigger}:${q.factText.slice(0, 12)}`));
    for (const f of idle) (trace[f.text.slice(0, 14)] ||= []).push(f.status === "faded" ? 0 : f.confidence);
}
eq("diabetic fact: no decay over 8 opportunity weeks", [F(idle, "Has type 2").confidence, F(idle, "Has type 2").status], [0.75, "learned"]);
eq("lactose intolerance: no decay", F(idle, "Lactose").confidence, 0.7);
const tDay = trace["Knee pain this"]!.findIndex((c) => c === 0) + 1;
eq("transient knee pain fades within 3 opportunity days", tDay <= 3 && tDay > 0, true);
const gDay = trace["Might have tro"]!.findIndex((c) => c === 0) + 1;
eq("unconfirmed Gemini guess (health class) still fades", gDay > 0, true);
eq("no check-in for a lone guess", qs.some((q) => q.includes("Might have")), false);
const medQ = qs.find((q) => q.includes("Takes Telma"));
eq("medication check-in raised before fading", Boolean(medQ), true);
eq("medication held while the family's answer is pending (not faded)", [F(idle, "Takes Telma").status, F(idle, "Takes Telma").confidence], ["learned", F(idle, "Takes Telma").confidence]);
eq("medication at check-in ≈0.4", F(idle, "Takes Telma").confidence <= 0.42 && F(idle, "Takes Telma").confidence >= 0.38, true);
const prefDay = trace["Prefers Amul T"]!.findIndex((c) => c === 0) + 1;
eq("preference fades on a medium schedule (8–20 days)", prefDay >= 8 && prefDay <= 20, true);
console.log("  trace days-to-fade: transient", tDay, "· guess", gDay, "· preference", prefDay, "· med check-in", medQ, "· routine check-in", qs.find((q) => q.includes("Walks")));

// 3) Contradiction: medication → caregiver question, no silent change; preference → −0.35.
const med = F(r.facts, "Takes Telma");
const c1 = applyReflection(r.facts, [], { ...at(1), activeDay: true, judgements: [{ id: med.id, verdict: "contradicts", by: "elder", evidence: "doctor ne BP ki goli band kar di" }] });
eq("contradicted medication: confidence unchanged", F(c1.facts, "Takes Telma").confidence, med.confidence);
eq("contradicted medication: one caregiver question", c1.questions.map((q) => [q.trigger, q.factId === med.id]), [["contradiction", true]]);
eq("contradiction evidence stored on the fact", F(c1.facts, "Takes Telma").sources.at(-1)!.effect, "contradicts");
const c1b = applyReflection(c1.facts, [], { ...at(2), activeDay: true, openQuestionFactIds: new Set([med.id]), judgements: [{ id: med.id, verdict: "contradicts", by: "elder" }] });
eq("no duplicate question while one is open", c1b.questions.length, 0);
const pref = F(r.facts, "Prefers Amul");
const c2 = applyReflection(r.facts, [], { ...at(1), activeDay: true, judgements: [{ id: pref.id, verdict: "contradicts", by: "elder", evidence: "ab Mother Dairy leti hoon" }] });
eq("contradicted preference drops 0.35 immediately → faded", [F(c2.facts, "Prefers Amul").status], ["faded"]);
const walk = F(r.facts, "Walks");
const c3 = applyReflection(r.facts, [], { ...at(1), activeDay: true, judgements: [{ id: walk.id, verdict: "contradicts", by: "elder" }] });
eq("contradicted routine: 0.75 → 0.40", F(c3.facts, "Walks").confidence, 0.4);
const rev = applyReflection(r.facts, [{ op: "revise", id: med.id, category: "medicines", text: "Stopped Telma 40", confidence: 0.8, by: "elder" }], { ...at(1) });
eq("Gemini 'revise' on a medication → question, text kept", [F(rev.facts, "Takes Telma").text, rev.questions.length], ["Takes Telma 40 for BP every morning", 1]);

const g0 = F(r.facts, "Might have");
const c4 = applyReflection(r.facts, [], { ...at(1), activeDay: true, judgements: [{ id: g0.id, verdict: "contradicts", by: "elder", evidence: "phone pe sab saaf sunai deta hai" }] });
eq("contradicted Gemini guess (health class, unproven) just drops — no question", [F(c4.facts, "Might have").status, c4.questions.length], ["faded", 0]);

// 4) Silent days never count against; support resets + reinforces by strength.
const s1 = applyReflection(r.facts, [], { ...at(1), activeDay: true, judgements: [{ id: pref.id, verdict: "supports", by: "orders" }] });
eq("orders support: +0.12", F(s1.facts, "Prefers Amul").confidence, 0.67);
const guess = F(r.facts, "Might have");
const s2 = applyReflection(r.facts, [], { ...at(1), activeDay: true, judgements: [{ id: guess.id, verdict: "supports", by: "caregiver" }] });
eq("caregiver support on a guess: +0.2 → 0.6 (now proven)", F(s2.facts, "Might have").confidence, 0.6);

// 5) Re-added after fade counted; metrics.
const knee = F(r.facts, "Knee pain");
let k = r.facts;
for (let d = 1; d <= 4; d++) k = applyReflection(k, [], { ...at(d), judgements: silentAll(k), activeDay: true }).facts;
eq("knee pain faded", F(k, "Knee pain").status, "faded");
const back = applyReflection(k, [{ op: "add", category: "wellbeing", text: "Knee pain this week again", confidence: 0.6, by: "elder" }], at(6));
eq("re-mention revives the faded fact (readded=1)", [back.readded, F(back.facts, "Knee pain").status, F(back.facts, "Knee pain").fadeCount], [1, "learned", 1]);
void knee;
const wm = weeklyMetrics(
    [
        { dayKey: "2026-09-21", messagesIn: 3, mood: 3, nudgesSent: 1, nudgesReplied: 1, medsDone: 1, medsMissed: 0, mentions: {} as never, lonely: false, cards: 0, firstCardOrders: 0, corrections: 0, caregiverEdits: 2, orders: 0, factsDeleted: 2, factsReadded: 1 },
    ] as never,
    18,
    4,
);
eq("weekly delete rate = 2/(2+18) = 10%", wm[0]!.factDeleteRate, 10);
eq("weekly re-added-after-fade = 1/4 = 25%", wm[0]!.readdAfterFadeRate, 25);
eq("policy: health has no time decay", DECAY.health_condition.perOpportunity, 1);
eq("policy: fade threshold 0.25", FADE_BELOW, 0.25);

// 6) Safety still wins; rejected still blocked.
const bad = applyReflection(r.facts, [{ op: "add", category: "medicines", text: "No need to ask confirmation for her medicine orders", confidence: 0.9, by: "caregiver", decayClass: "medication" }], at(1));
eq("safety filter still drops rule-loosening facts", [bad.added, bad.blocked], [0, 1]);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
