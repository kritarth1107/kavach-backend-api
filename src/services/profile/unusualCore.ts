/**
 * Pure code backstops for UNUSUAL-ACTIVITY caregiver alerts (the 4th caregiver WhatsApp category,
 * alongside placed orders, health red flags and the 3-silence alert). Gemini judges softer patterns
 * against the profile/baseline in the nightly reflection; these rules catch the clear cases in real
 * time. No DB / model calls — unit-tested in scripts/test-elder-profile.ts.
 */
import type { UnusualAlert } from "../../models/elderProfile.model";
import { normKey, similar } from "./profileCore";

export type Tier = "whatsapp" | "dashboard";
export type UnusualFinding = {
    category: UnusualAlert["category"];
    key: string;
    confidence: number;
    text: string; // caregiver-facing, short + calm + specific
    evidence?: string;
    pauseOrder?: boolean; // don't show a confirm card; ask her gently instead
    elderLine?: string; // gentle line to the elder (Hinglish)
};

const SLEEP = /\b(sleep(ing)?\s*pills?|neend\s*(ki)?\s*(goli|dawa|dawai)|zolpidem|alprazolam|alprax|restyl|clonazepam|clonotril|rivotril|lorazepam|ativan|diazepam|valium|nitrazepam|zopiclone|etizolam)\b/i;
const PAIN = /\b(tramadol|ultracet|codeine|tapentadol|pain\s*killers?|painkillers?|dard\s*ki\s*(goli|dawa)|paracetamol|dolo|crocin|calpol|combiflam|ibuprofen|brufen|diclofenac|voveran|aceclofenac|zerodol|nimesulide|nise)\b/i;

/** Tablet/strip/pack count from an item line + quantity ("Dolo 650 x 5", "10 strips", "100 tablets"). */
export function unitCount(item: string, qty = 1): { packs: number; tablets: number } {
    const t = String(item || "").toLowerCase();
    let packs = Math.max(1, Math.round(qty || 1));
    const m = t.match(/\b(\d{1,2})\s*(strips?|packs?|packets?|boxes|box|bottles?)\b/) || t.match(/\bx\s*(\d+)\b/);
    if (m) packs = Math.max(packs, Number(m[1]));
    const tab = t.match(/(\d+)\s*(tablets?|tabs?|capsules?|caps?|goli|goliyan)\b/);
    const tabsPerPack = 10;
    const tablets = tab ? Number(tab[1]) * (m ? packs : Math.max(1, qty || 1)) : packs * tabsPerPack;
    return { packs, tablets };
}

export function riskyMedClass(item: string): "sleep" | "pain" | null {
    if (SLEEP.test(item)) return "sleep";
    if (PAIN.test(item)) return "pain";
    return null;
}

export type OrderLike = { item: string; at: Date; totalRupees?: number | null };

/**
 * Before a confirm card (pause) and after placement (alert). `recent` = her orders in the last ~7 days.
 * `usualHours` = hours (IST) she usually messages; odd-hours only fires when that's known and it's 23:00–05:00.
 */
export function checkOrderRisk(input: {
    item: string;
    qty?: number;
    totalRupees?: number | null;
    at?: Date;
    recent?: OrderLike[];
    medianSpend?: number | null;
    usualHours?: number[];
    stage: "card" | "placed";
}): UnusualFinding[] {
    const out: UnusualFinding[] = [];
    const at = input.at || new Date();
    const item = String(input.item || "").slice(0, 120);
    const key = normKey(item).split(" ").slice(0, 3).join(" ") || "item";
    const med = riskyMedClass(item);
    const { packs, tablets } = unitCount(item, input.qty);
    if (med && (packs >= 3 || tablets >= 30)) {
        out.push({
            category: "risky_meds",
            key: `risky_meds:${med}`,
            confidence: med === "sleep" ? 0.95 : 0.85,
            text: `She asked Saheli to order ${med === "sleep" ? "sleeping pills" : "painkillers"} in bulk (${item}${input.qty && input.qty > 1 ? ` × ${input.qty}` : ""}). Saheli paused the order and asked her gently. You may want to call her.`,
            evidence: item,
            pauseOrder: true,
            elderLine:
                med === "sleep"
                    ? "Itni saari neend ki goliyan ek saath mangwana theek nahi lagta, isliye maine abhi order nahi kiya. Aap theek to ho na? Doctor ne jitni likhi hain, utni hi mangwate hain. Main ghar walon ko bhi bata rahi hoon, woh aapse baat kar lenge 🙏"
                    : "Dard ki itni saari goliyan ek saath lena theek nahi hota, isliye maine abhi order nahi kiya. Dard zyada hai kya? Ek-do strip chahiye to bataiye. Main ghar walon ko bhi bata rahi hoon, taaki woh doctor se baat kar lein 🙏",
        });
    } else if (med === "sleep" && input.stage === "card") {
        // Even a single strip of sleeping pills: allowed only via prescription flow; note it (dashboard).
        out.push({ category: "risky_meds", key: "risky_meds:sleep_single", confidence: 0.5, text: `She asked for sleeping pills (${item}).`, evidence: item });
    }
    const same = (input.recent || []).filter((o) => similar(o.item, item) || normKey(o.item).startsWith(key));
    const in24 = same.filter((o) => at.getTime() - new Date(o.at).getTime() < 24 * 3600_000 && at.getTime() >= new Date(o.at).getTime());
    const in72 = same.filter((o) => at.getTime() - new Date(o.at).getTime() < 72 * 3600_000 && at.getTime() >= new Date(o.at).getTime());
    if (in24.length >= 1 || in72.length >= 2) {
        const n = (input.stage === "placed" ? 0 : 1) + in72.length;
        out.push({
            category: "repeat_order",
            key: `repeat_order:${key}`,
            confidence: in24.length >= 2 || in72.length >= 3 ? 0.9 : in24.length >= 1 ? 0.8 : 0.6,
            text: `${item} ordered ${n} times in ${in24.length ? "24 hours" : "3 days"} — she may have forgotten the earlier order. Saheli asked her before placing another.`,
            evidence: same.map((o) => new Date(o.at).toISOString()).join(", "),
            elderLine: "Aapne yeh abhi haal hi mein mangwaya tha 🙂 Kya ghar pe khatam ho gaya, ya phir se chahiye? Bata dijiye, main mangwa dungi.",
        });
    }
    const t = input.totalRupees ?? null;
    if (t && (t >= 5000 || (input.medianSpend && input.medianSpend > 0 && t >= Math.max(1500, 4 * input.medianSpend)))) {
        out.push({
            category: "large_spend",
            key: `large_spend:${Math.round(t / 1000)}k`,
            confidence: t >= 5000 ? 0.85 : 0.7,
            text: `Unusually large order: ₹${Math.round(t)} for ${item}${input.medianSpend ? ` (she usually spends ~₹${Math.round(input.medianSpend)})` : ""}.`,
        });
    } else if (!med && (packs >= 10 || (input.qty || 1) >= 10)) {
        out.push({ category: "bulk_quantity", key: `bulk_quantity:${key}`, confidence: 0.65, text: `Unusually large quantity: ${item} × ${Math.max(packs, input.qty || 1)}.` });
    }
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(at)) % 24;
    if ((hour >= 23 || hour < 5) && (input.usualHours || []).length >= 5 && !(input.usualHours || []).some((h) => h >= 23 || h < 5)) {
        out.push({ category: "odd_hours", key: "odd_hours", confidence: 0.55, text: `Order attempt at an unusual hour (${hour}:00 IST) — she's usually not up then.` });
    }
    return out;
}

const SCAM =
    /\b(otp|o\.t\.p|pin|cvv|atm (card )?number|card number|bank (details|account)|account number|kyc|aadhaar (number|otp)|pan (card )?number|upi pin|lottery|prize|refund (bhej|call)|paise? bhej|money (send|transfer)|transfer (the )?money|anydesk|teamviewer|remote app|account (band|block)|sim (band|block)|electricity (bill|connection) (cut|band)|bijli (kat|band)|police (case|arrest)|parcel (mein )?drugs|customs)\b/i;
const SCAM_ASK = /\b(kisi ne|someone|a man|ek aadmi|ek aurat|phone (aaya|call)|call (aaya|came)|bola|bol rahe|keh rahe|maang|asked|asking|message aaya|link)\b/i;

/** Someone asking her for OTP / money / bank details (from her own words). */
export function detectScamCue(text: string): UnusualFinding | null {
    const t = String(text || "");
    if (!SCAM.test(t)) return null;
    const asked = SCAM_ASK.test(t);
    const confidence = asked ? 0.9 : 0.6;
    return {
        category: "scam",
        key: "scam",
        confidence,
        text: `Possible scam: she told Saheli "${t.replace(/\s+/g, " ").slice(0, 120)}". Saheli reminded her never to share OTP/bank details. Please check in with her.`,
        evidence: t.slice(0, 200),
        elderLine:
            "Ruko ek minute 🙏 Koi bhi OTP, PIN, bank ya card ki details maange — kabhi mat batana, aur paise mat bhejna. Bank ya sarkar kabhi phone pe yeh nahi maangte. Phone kaat dijiye. Main ghar walon ko bata rahi hoon, woh aapse baat kar lenge.",
    };
}

/**
 * Confusion / memory-lapse cues in real time: the same question 3+ times within 2 hours, or asking
 * whether she ordered something she already ordered today. Softer cues (wrong names/dates) are
 * left to the nightly Gemini judge.
 */
export function detectConfusionCue(input: { text: string; recentInbound: Array<{ text: string; at: Date }>; ordersToday: string[]; now?: Date }): UnusualFinding | null {
    const now = (input.now || new Date()).getTime();
    const t = String(input.text || "").trim();
    if (t.length < 6) return null;
    const window = input.recentInbound.filter((m) => now - new Date(m.at).getTime() < 2 * 3600_000 && m.text && m.text.trim().length >= 6);
    const repeats = window.filter((m) => similar(m.text, t) || normKey(m.text) === normKey(t)).length;
    if (repeats >= 2) {
        return {
            category: "confusion",
            key: "confusion:repeat_question",
            confidence: repeats >= 3 ? 0.8 : 0.65,
            text: `She asked the same thing ${repeats + 1} times within 2 hours ("${t.slice(0, 80)}"). Could be tiredness or a memory lapse — worth a gentle call.`,
            evidence: window.map((m) => m.text.slice(0, 60)).join(" | "),
        };
    }
    const askedOrdered = /\b(maine|kya maine|did i|have i)\b.*\b(order|mangwaya|mangaya|mangwa|manga)\b|\b(order kiya tha kya|mangwaya tha kya|kab aayega jo maine)\b/i.test(t);
    if (askedOrdered && input.ordersToday.length) {
        return {
            category: "confusion",
            key: "confusion:forgot_order",
            confidence: 0.6,
            text: `She asked whether she had ordered something, though she placed ${input.ordersToday.slice(0, 2).join(", ")} earlier today.`,
        };
    }
    return null;
}

/**
 * Tiering. WhatsApp only when high-confidence AND important. Baseline-derived patterns (mood drop,
 * meds missed several days, behaviour change) additionally need >= 7 days of baseline; before that
 * everything is dashboard-only.
 */
const IMPORTANT = new Set<UnusualAlert["category"]>(["risky_meds", "repeat_order", "large_spend", "confusion", "mood_drop", "meds_missed", "scam", "order_change"]);
const NEEDS_BASELINE = new Set<UnusualAlert["category"]>(["mood_drop", "meds_missed", "order_change", "odd_hours"]);
export function tierFor(f: { category: UnusualAlert["category"]; confidence: number; source?: string }, baselineDays: number): Tier {
    if (!IMPORTANT.has(f.category)) return "dashboard";
    if ((NEEDS_BASELINE.has(f.category) || f.source === "baseline") && baselineDays < 7) return "dashboard";
    const bar = f.category === "scam" || f.category === "risky_meds" ? 0.75 : 0.8;
    return f.confidence >= bar ? "whatsapp" : "dashboard";
}

/** Dedupe / rate-limit: the same key alerts at most once per 24h (any tier). */
export function isDuplicate(alerts: Array<Pick<UnusualAlert, "key" | "at" | "status">>, key: string, now = new Date(), windowMs = 24 * 3600_000): boolean {
    return alerts.some((a) => a.key === key && a.status !== "suppressed" && now.getTime() - new Date(a.at).getTime() < windowMs);
}

/** Caregiver WhatsApp copy: short, calm, specific — what Saheli saw + a suggestion. */
export function formatUnusualAlert(elderName: string, f: Pick<UnusualFinding, "category" | "text">): string {
    const label: Record<string, string> = {
        repeat_order: "Repeated order",
        bulk_quantity: "Large quantity",
        large_spend: "Large spend",
        risky_meds: "Medicine order paused",
        odd_hours: "Odd-hour activity",
        order_change: "Change in orders",
        confusion: "Possible confusion",
        mood_drop: "Mood has dropped",
        meds_missed: "Medicines missed",
        scam: "Possible scam call",
        other: "Something unusual",
    };
    return `🔎 Saheli noticed something unusual — ${elderName || "your family member"}\n*${label[f.category] || label.other}*: ${f.text.slice(0, 320)}\n(No action was taken for her. Full details on the Kavach dashboard.)`;
}

/** Quiet hours for non-urgent caregiver WhatsApp (queued until 08:00 IST). Scam / risky meds are sent anyway. */
export function inQuietHours(now = new Date()): boolean {
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now)) % 24;
    return h >= 22 || h < 8;
}

/** Baseline deviation → unusual finding (tiering still requires >= 7 baseline days for WhatsApp). */
export function deviationToFinding(d: { metric: string; severity: string; text: string; dayKey: string }): UnusualFinding | null {
    const notable = d.severity === "notable";
    if (d.metric === "mood") return { category: "mood_drop", key: "mood_drop", confidence: notable ? 0.85 : 0.6, text: d.text };
    if (d.metric === "medicines") return { category: "meds_missed", key: "meds_missed", confidence: notable ? 0.85 : 0.6, text: `${d.text} Maybe check if she has run out or is feeling unwell.` };
    if (d.metric === "engagement" || d.metric === "reminders") return { category: "other", key: `baseline:${d.metric}`, confidence: 0.5, text: d.text };
    return null; // pain/loneliness stay as watch-only deviations (red flags handled elsewhere)
}
