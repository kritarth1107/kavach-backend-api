/**
 * Pure logic for Saheli's evolving elder profile: fact merge (reinforce / decay / never-relearn),
 * safety filter, care-first summary, wellbeing baseline + deviations, progress metrics.
 * No DB, no model calls — unit-tested in scripts/test-elder-profile.ts.
 */
import { randomUUID } from "crypto";
import { FACT_CATEGORIES, type CareAction, type Deviation, type FactCategory, type ProfileFact } from "../../models/elderProfile.model";
import type { IElderWellbeingDay } from "../../models/elderWellbeingDay.model";

export const CARE_FIRST_ORDER: FactCategory[] = [...FACT_CATEGORIES];
const DAY = 86_400_000;

export function normKey(text: string): string {
    return String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\u0900-\u097f\s]/g, " ")
        .replace(/\b(she|her|he|his|the|a|an|is|was|has|had|to|of|and|in|on|at|for|with|usually|often|likes?|loves?)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 140);
}

export function similar(a: string, b: string): boolean {
    const A = new Set(normKey(a).split(" ").filter((w) => w.length > 2));
    const B = new Set(normKey(b).split(" ").filter((w) => w.length > 2));
    if (!A.size || !B.size) return false;
    const inter = [...A].filter((w) => B.has(w)).length;
    return inter / Math.min(A.size, B.size) >= 0.75 || inter / new Set([...A, ...B]).size >= 0.6;
}

/**
 * Safety rules are never learnable: a "fact" that would loosen COD / literal confirm / harmful-item
 * refusal / red flags / the silence alert / the address book, or carries an address, is dropped.
 */
export function isUnsafeFact(text: string): boolean {
    const t = String(text || "").toLowerCase();
    return (
        /\b(skip|no need|without|don'?t (ask|need)|stop asking)\b.*\b(confirm|confirmation|otp|check|health check|asking)\b/.test(t) ||
        /\b(pay|payment)\b.*\b(online|upi|card|prepaid|wallet)\b|\b(upi|credit card|debit card)\b/.test(t) ||
        /\b(auto[- ]?(order|book|place)|order (it )?without asking|book without asking)\b/.test(t) ||
        /\b(don'?t|never|no need to) (tell|alert|notify|inform|message) (family|caregiver|son|daughter|anyone)\b/.test(t) ||
        /\b(ignore|disable|turn off)\b.*\b(alert|red flag|emergency|silence|reminder)s?\b/.test(t) ||
        /\b(cigarettes?|bidis?|beedis?|gutkha|gutka|tobacco|alcohol|whisky|beer|vapes?)\b.*\b(allowed|ok|fine|order|buy|get)\b/.test(t) ||
        /\b(flat|house no|pincode|pin code|\d{6})\b/.test(t) ||
        /\b(ignore|override|bypass) (previous|safety|rules|instructions)\b/.test(t)
    );
}

export type ReflectionOp = {
    op: "add" | "reinforce" | "revise";
    id?: string | null;
    category: string;
    text: string;
    confidence?: number;
    evidence?: string;
};

export function isActive(f: ProfileFact): boolean {
    return f.status !== "rejected" && f.status !== "faded";
}
const permanent = (f: ProfileFact) => f.status === "caregiver_confirmed" || f.status === "caregiver_edited";

/** Merge one night's ops into the facts. Returns counts for the log. */
export function applyReflection(
    facts: ProfileFact[],
    ops: ReflectionOp[],
    ctx: { now: Date; dayKey: string; sourceKind?: string },
): { facts: ProfileFact[]; added: number; reinforced: number; revised: number; faded: number; blocked: number } {
    const now = ctx.now;
    const out = facts.map((f) => ({ ...f, sources: [...(f.sources || [])] }));
    const touched = new Set<string>();
    let added = 0, reinforced = 0, revised = 0, blocked = 0;
    const src = { kind: ctx.sourceKind || "reflection", at: now, ref: ctx.dayKey };
    for (const raw of ops.slice(0, 40)) {
        const text = String(raw.text || "").trim().slice(0, 240);
        const category = (FACT_CATEGORIES as readonly string[]).includes(raw.category) ? (raw.category as FactCategory) : null;
        if (!text || !category) continue;
        if (isUnsafeFact(text)) {
            blocked++;
            continue;
        }
        // Rejected by a caregiver → never re-learned (same id or similar text).
        if (out.some((f) => f.status === "rejected" && (f.id === raw.id || similar(f.text, text)))) {
            blocked++;
            continue;
        }
        const target =
            (raw.id && out.find((f) => f.id === raw.id && f.status !== "rejected")) ||
            out.find((f) => f.status !== "rejected" && f.category === category && similar(f.text, text)) ||
            out.find((f) => f.status !== "rejected" && similar(f.text, text));
        const conf = Math.max(0, Math.min(1, Number(raw.confidence ?? 0.6)));
        if (target) {
            touched.add(target.id);
            if (raw.op === "revise" && !permanent(target) && !similar(target.text, text)) {
                target.text = text;
                target.key = normKey(text);
                target.confidence = Math.max(0.5, Math.min(0.85, conf));
                target.status = "learned";
                revised++;
            } else {
                if (!permanent(target)) target.confidence = Math.min(0.95, (target.status === "faded" ? 0.4 : target.confidence) + 0.15);
                if (target.status === "faded") target.status = "learned";
                reinforced++;
            }
            target.lastConfirmed = now;
            target.sources = [...target.sources, src].slice(-8);
            continue;
        }
        const f: ProfileFact = {
            id: randomUUID(),
            key: normKey(text),
            category,
            text,
            confidence: Math.max(0.3, Math.min(0.7, conf)),
            sources: [src],
            firstSeen: now,
            lastConfirmed: now,
            status: "learned",
        };
        out.push(f);
        touched.add(f.id);
        added++;
    }
    // Decay: learned facts not seen for a week lose confidence nightly; very low → faded (hidden).
    let faded = 0;
    for (const f of out) {
        if (touched.has(f.id) || f.status !== "learned") continue;
        const idle = (now.getTime() - new Date(f.lastConfirmed).getTime()) / DAY;
        if (idle < 7) continue;
        f.confidence = Math.round(f.confidence * 0.9 * 100) / 100;
        if (f.confidence < 0.25) {
            f.status = "faded";
            faded++;
        }
    }
    return { facts: out, added, reinforced, revised, faded, blocked };
}

/** Care-first compact summary for prompts. `short` for the router (≈350 chars). */
export function renderProfileSummary(
    p: { facts: ProfileFact[]; careActions?: CareAction[]; tuning?: { addressAs?: string; language?: string } },
    opts: { short?: boolean; dayKey?: string } = {},
): string {
    const max = opts.short ? 350 : 1400;
    const active = p.facts.filter((f) => isActive(f) && (permanent(f) || f.confidence >= 0.4));
    if (!active.length && !p.careActions?.length) return "";
    const lines: string[] = [];
    if (p.tuning?.addressAs) lines.push(`Address her as: ${p.tuning.addressAs}`);
    for (const cat of CARE_FIRST_ORDER) {
        const fs = active
            .filter((f) => f.category === cat)
            .sort((a, b) => Number(permanent(b)) - Number(permanent(a)) || b.confidence - a.confidence)
            .slice(0, opts.short ? 2 : 4);
        if (fs.length) lines.push(`${cat}: ${fs.map((f) => f.text).join("; ")}`);
    }
    const today = (p.careActions || []).filter((a) => a.status === "planned" && a.audience === "elder" && (!opts.dayKey || a.dayKey === opts.dayKey));
    if (today.length && !opts.short) lines.push(`Today's care intentions (weave in gently, one at a time, never pushy): ${today.map((a) => a.text).join("; ")}`);
    let s = lines.join("\n");
    if (s.length > max) s = s.slice(0, max - 1) + "…";
    return s;
}

// ── Baseline + deviations (watch-only) ─────────────────────────────────────────────
type Day = Pick<IElderWellbeingDay, "dayKey" | "messagesIn" | "mood" | "nudgesSent" | "nudgesReplied" | "medsDone" | "medsMissed" | "mentions" | "lonely">;
const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const rate = (d: Day) => (d.nudgesSent ? d.nudgesReplied / d.nudgesSent : null);
const adherence = (d: Day) => (d.medsDone + d.medsMissed ? d.medsDone / (d.medsDone + d.medsMissed) : null);
const nn = <T,>(xs: Array<T | null>) => xs.filter((x): x is T => x != null);

export function computeBaseline(days: Day[]) {
    return {
        days: days.length,
        messages: median(days.map((d) => d.messagesIn)),
        mood: nn(days.map((d) => d.mood)).length ? median(nn(days.map((d) => d.mood))) : null,
        replyRate: nn(days.map(rate)).length ? median(nn(days.map(rate))) : null,
        adherence: nn(days.map(adherence)).length ? median(nn(days.map(adherence))) : null,
        painRate: days.filter((d) => d.mentions?.pain).length / Math.max(1, days.length),
        lonelyRate: days.filter((d) => d.lonely).length / Math.max(1, days.length),
    };
}

/** Last `window` days vs the prior ≤28 days (needs ≥5 baseline days). Wellbeing-first. */
export function detectDeviations(daysAsc: Day[], window = 3): Array<Omit<Deviation, "id" | "at">> {
    if (daysAsc.length < window + 5) return [];
    const recent = daysAsc.slice(-window);
    const base = computeBaseline(daysAsc.slice(-(window + 28), -window));
    const dayKey = recent[recent.length - 1]!.dayKey;
    const out: Array<Omit<Deviation, "id" | "at">> = [];
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    if (base.messages >= 3 && recent.every((d) => d.messagesIn <= base.messages * 0.5)) {
        out.push({ dayKey, metric: "engagement", days: window, severity: "watch", text: `Quieter than usual for ${window} days (about ${avg(recent.map((d) => d.messagesIn)).toFixed(0)} messages/day vs her usual ${base.messages.toFixed(0)}).` });
    }
    const moods = nn(recent.map((d) => d.mood));
    if (base.mood != null && moods.length === window && avg(moods) <= base.mood - 1) {
        out.push({ dayKey, metric: "mood", days: window, severity: avg(moods) <= 2 ? "notable" : "watch", text: `Mood lower than her usual for ${window} days (${avg(moods).toFixed(1)}/5 vs ${base.mood.toFixed(1)}/5).` });
    }
    const adh = nn(recent.map(adherence));
    if (base.adherence != null && adh.length >= 2 && avg(adh) <= base.adherence - 0.3) {
        out.push({ dayKey, metric: "medicines", days: window, severity: "notable", text: `Medicines taken less than usual (${Math.round(avg(adh) * 100)}% vs her usual ${Math.round(base.adherence * 100)}%).` });
    }
    if (!out.some((d) => d.metric === "medicines") && recent.every((d) => (d.medsMissed || 0) > 0 && (d.medsDone || 0) === 0)) {
        out.push({ dayKey, metric: "medicines", days: window, severity: "notable", text: `No medicines marked taken for ${window} days in a row.` });
    }
    const rr = nn(recent.map(rate));
    if (base.replyRate != null && rr.length >= 2 && avg(rr) <= base.replyRate - 0.4) {
        out.push({ dayKey, metric: "reminders", days: window, severity: "watch", text: `Replying to reminders less than usual (${Math.round(avg(rr) * 100)}% vs ${Math.round(base.replyRate * 100)}%).` });
    }
    if (base.painRate < 0.3 && recent.every((d) => d.mentions?.pain)) {
        out.push({ dayKey, metric: "pain", days: window, severity: "notable", text: `Mentioned pain ${window} days in a row (unusual for her).` });
    }
    if (base.lonelyRate < 0.3 && recent.filter((d) => d.lonely).length >= 2) {
        out.push({ dayKey, metric: "loneliness", days: window, severity: "watch", text: `Sounded lonely on ${recent.filter((d) => d.lonely).length} of the last ${window} days.` });
    }
    return out;
}

// ── Progress metrics (weekly) ─────────────────────────────────────────────────────
type MDay = Day & Pick<IElderWellbeingDay, "cards" | "firstCardOrders" | "corrections" | "caregiverEdits" | "orders">;
export function weeklyMetrics(daysAsc: MDay[], factsCount: number) {
    const weeks = new Map<string, MDay[]>();
    for (const d of daysAsc) {
        const dt = new Date(`${d.dayKey}T00:00:00+05:30`);
        const monday = new Date(dt.getTime() - ((dt.getUTCDay() + 6) % 7) * DAY);
        const k = monday.toISOString().slice(0, 10);
        weeks.set(k, [...(weeks.get(k) || []), d]);
    }
    const sum = (xs: MDay[], f: (d: MDay) => number) => xs.reduce((a, d) => a + (f(d) || 0), 0);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : null);
    return [...weeks.entries()].map(([week, xs]) => ({
        week,
        nudgeReplyRate: pct(sum(xs, (d) => d.nudgesReplied), sum(xs, (d) => d.nudgesSent)),
        firstCardSuccess: pct(sum(xs, (d) => d.firstCardOrders), sum(xs, (d) => d.orders)),
        correctionRate: pct(sum(xs, (d) => d.corrections), sum(xs, (d) => d.cards)),
        caregiverEditRate: pct(sum(xs, (d) => d.caregiverEdits), Math.max(1, factsCount)),
        adherence: pct(sum(xs, (d) => d.medsDone), sum(xs, (d) => d.medsDone + d.medsMissed)),
        avgMood: nn(xs.map((d) => d.mood)).length ? Math.round((nn(xs.map((d) => d.mood)).reduce((a, b) => a + b, 0) / nn(xs.map((d) => d.mood)).length) * 10) / 10 : null,
    }));
}

/** Stated preferences in chat ("main sirf Amul leti hoon", "I only drink green tea"). */
export function detectStatedPreference(text: string): { text: string; brand?: string; item?: string; category: FactCategory } | null {
    const t = String(text || "").trim();
    if (t.length > 200) return null;
    let m = t.match(/\b(?:main|mai|hum|ham)\s+(?:sirf|hamesha|bas|only)\s+([a-z][\w'&.-]*(?:\s+[a-z][\w'&.-]*){0,2}?)\s+(?:ka|ki|ke\s+)?\s*([a-z]+\s+)?(?:leti|leta|lete|peeti|peeta|khati|khata|mangati|mangata|use karti|use karta)\s*(?:hoon|hu|hain|hai)?\b/i);
    if (m) {
        const brand = m[1]!.trim();
        const item = m[2]?.trim();
        return { text: `Prefers ${brand}${item ? ` ${item}` : ""} (said: "${t.slice(0, 80)}")`, brand, item, category: "preferences" };
    }
    m = t.match(/\bi\s+(?:only|always)\s+(?:buy|drink|eat|take|use|get)\s+([a-z][\w'&.-]*(?:\s+[a-z][\w'&.-]*){0,3})/i);
    if (m) return { text: `Prefers ${m[1]!.trim()} (said: "${t.slice(0, 80)}")`, brand: m[1]!.split(/\s+/)[0], category: "preferences" };
    m = t.match(/\bmujhe\s+(.{3,40}?)\s+(?:bahut\s+)?(?:pasand|achha lagta|achchha lagta|acha lagta)\s*(?:hai|he)?\b/i);
    if (m && !/\b(nahi|nahin|na)\b/i.test(t)) return { text: `Enjoys ${m[1]!.trim()} (said: "${t.slice(0, 80)}")`, category: /gaan[ae]|bhajan|song|serial|tv|kahani|baat|music/i.test(m[1]!) ? "comfort" : "preferences" };
    m = t.match(/\bmujhe\s+(.{3,40}?)\s+(?:pasand nahi|nahi pasand|achha nahi lagta)\b/i);
    if (m) return { text: `Dislikes ${m[1]!.trim()} (said: "${t.slice(0, 80)}")`, category: "preferences" };
    return null;
}

export function newActionId(): string {
    return randomUUID();
}
