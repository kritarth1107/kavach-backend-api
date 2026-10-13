/** Offline tests: the unusual-activity code backstops of the old order flow. `npm run test:elder-profile`
 *  (The evolving Mongo profile these sat beside is retired, trust plan A1: the brain remembers in the care record.) */
import { checkOrderRisk, detectConfusionCue, detectScamCue, deviationToFinding, formatUnusualAlert, isDuplicate, riskyMedClass, tierFor, unitCount } from "../src/services/profile/unusualCore";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

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
