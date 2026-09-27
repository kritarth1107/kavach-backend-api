/**
 * Pure logic for Saheli's evolving elder profile: fact merge (reinforce / decay / never-relearn),
 * safety filter, care-first summary, wellbeing baseline + deviations, progress metrics.
 * No DB, no model calls — unit-tested in scripts/test-elder-profile.ts.
 */
import { randomUUID } from "crypto";
import { FACT_CATEGORIES, type CareAction, type Deviation, type FactCategory, type ProfileFact } from "../../models/elderProfile.model";
import type { IElderWellbeingDay } from "../../models/elderWellbeingDay.model";
import {
    asDecayClass,
    asEvidenceBy,
    CHECKIN_AT,
    CHECKIN_MIN_PEAK,
    CONTRADICTION_DROP,
    DECAY,
    EVIDENCE,
    FADE_BELOW,
    MAX_CONFIDENCE,
    PROVEN_AT,
    round2,
    STRENGTH,
    UNPROVEN_RULE,
    type DecayClass,
    type DecayRule,
    type EvidenceBy,
} from "./factPolicy";

export const CARE_FIRST_ORDER: FactCategory[] = [...FACT_CATEGORIES];
const DAY = 86_400_000;
export { DECAY_CLASSES } from "./factPolicy";

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
    /** factPolicy decay class (health_condition | allergy | safety | medication | routine | preference | transient_state | other). */
    decayClass?: string | null;
    /** Who the evidence came from: elder / caregiver said it (strong), orders (medium), inferred (weak). */
    by?: string | null;
};

/** Gemini's nightly label for ONE known fact vs the day. Silent days never count against a fact. */
export type FactJudgement = {
    id: string;
    verdict: "supports" | "contradicts" | "silent";
    /** Silent only: would it naturally have shown up today if still true? (opportunity for decay) */
    opportunity?: boolean;
    by?: string | null;
    evidence?: string | null;
    decayClass?: string | null;
};

export type NewQuestion = { factId: string; factText: string; decayClass?: DecayClass; trigger: "contradiction" | "checkin"; evidence?: string; confidenceAtAsk: number };

export function isActive(f: ProfileFact): boolean {
    return f.status !== "rejected" && f.status !== "faded";
}
const permanent = (f: ProfileFact) => f.status === "caregiver_confirmed" || f.status === "caregiver_edited";

/** Decay rule for a fact: its class, but a no-decay class only holds once it has real evidence. */
export function ruleFor(f: ProfileFact): DecayRule {
    const rule = f.decayClass ? DECAY[f.decayClass] : DECAY.other;
    if (rule.perOpportunity < 1) return rule;
    const proven = (f.peakConfidence ?? f.confidence) >= PROVEN_AT || (f.sources || []).some((s) => s.strength === "strong" && s.effect !== "contradicts");
    return proven ? rule : UNPROVEN_RULE;
}

/**
 * Merge one night's ops + per-fact judgements into the facts. Pure.
 * - ops: add / reinforce / revise, weighted by evidence source (factPolicy.EVIDENCE).
 * - judgements: supports (reinforce), contradicts (−0.35, or a caregiver question for health /
 *   medication / pinned facts — never a silent change), silent (+ opportunity → decay may accrue).
 * - decay: per class, only on opportunity days; check-in question at ~0.4 before important facts fade.
 * Without judgements (e.g. a stated preference captured mid-chat) nothing decays.
 */
export function applyReflection(
    facts: ProfileFact[],
    ops: ReflectionOp[],
    ctx: { now: Date; dayKey: string; sourceKind?: string; sourceBy?: EvidenceBy; judgements?: FactJudgement[]; activeDay?: boolean; openQuestionFactIds?: Set<string> },
) {
    const now = ctx.now;
    const out = facts.map((f) => ({ ...f, sources: [...(f.sources || [])] }));
    const touched = new Set<string>();
    const opportunity = new Set<string>();
    const asked = new Set(ctx.openQuestionFactIds || []);
    const questions: NewQuestion[] = [];
    let added = 0, reinforced = 0, revised = 0, blocked = 0, contradicted = 0, decayed = 0, classified = 0, readded = 0;
    const source = (by: EvidenceBy, effect: NonNullable<ProfileFact["sources"][number]["effect"]>, evidence?: string | null) => ({
        kind: ctx.sourceKind || "reflection",
        at: now,
        ref: ctx.dayKey,
        by,
        strength: STRENGTH[by],
        effect,
        ...(evidence ? { evidence: String(evidence).slice(0, 160) } : {}),
    });
    const ask = (f: ProfileFact, trigger: NewQuestion["trigger"], evidence?: string | null) => {
        if (asked.has(f.id)) return;
        asked.add(f.id);
        questions.push({ factId: f.id, factText: f.text, decayClass: f.decayClass, trigger, evidence: evidence ? String(evidence).slice(0, 200) : undefined, confidenceAtAsk: f.confidence });
    };
    const classify = (f: ProfileFact, dc: unknown) => {
        const c = asDecayClass(dc);
        if (c && !f.decayClass) {
            f.decayClass = c;
            classified++;
        }
    };
    const support = (f: ProfileFact, by: EvidenceBy, evidence?: string | null) => {
        if (!permanent(f)) {
            const base = f.status === "faded" ? 0.4 : f.confidence;
            f.confidence = round2(Math.min(MAX_CONFIDENCE, base + EVIDENCE[STRENGTH[by]].reinforce));
            f.peakConfidence = Math.max(f.peakConfidence ?? 0, f.confidence);
        }
        if (f.status === "faded") {
            f.status = "learned";
            f.fadedAt = undefined;
            readded++;
        }
        f.idleOpportunities = 0;
        f.lastConfirmed = now;
        f.sources = [...f.sources, source(by, "supports", evidence)].slice(-12);
        reinforced++;
    };
    const fade = (f: ProfileFact) => {
        f.status = "faded";
        f.fadedAt = now;
        f.fadeCount = (f.fadeCount || 0) + 1;
    };
    const protectedFact = (f: ProfileFact) => permanent(f) || (f.decayClass ? DECAY[f.decayClass].askOnContradiction : false);

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
        const by = raw.by ? asEvidenceBy(raw.by) : ctx.sourceBy || "inferred";
        const target =
            (raw.id && out.find((f) => f.id === raw.id && f.status !== "rejected")) ||
            out.find((f) => f.status !== "rejected" && f.category === category && similar(f.text, text)) ||
            out.find((f) => f.status !== "rejected" && similar(f.text, text));
        const conf = Math.max(0, Math.min(1, Number(raw.confidence ?? 0.6)));
        if (target) {
            touched.add(target.id);
            classify(target, raw.decayClass);
            if (raw.op === "revise" && !similar(target.text, text)) {
                if (protectedFact(target)) {
                    // Health / medication / pinned: never silently rewritten — ask the family.
                    target.sources = [...target.sources, source(by, "contradicts", raw.evidence || `now: ${text}`)].slice(-12);
                    ask(target, "contradiction", raw.evidence ? `${raw.evidence} (Saheli now thinks: ${text})` : `Saheli now thinks: ${text}`);
                    contradicted++;
                    continue;
                }
                target.text = text;
                target.key = normKey(text);
                target.confidence = round2(Math.max(0.5, Math.min(0.85, conf)));
                target.peakConfidence = Math.max(target.peakConfidence ?? 0, target.confidence);
                if (target.status === "faded") readded++;
                target.status = "learned";
                target.idleOpportunities = 0;
                target.lastConfirmed = now;
                target.sources = [...target.sources, source(by, "revised", raw.evidence)].slice(-12);
                revised++;
            } else support(target, by, raw.evidence);
            continue;
        }
        const [lo, hi] = EVIDENCE[STRENGTH[by]].start;
        const c = round2(Math.max(lo, Math.min(hi, conf)));
        const f: ProfileFact = {
            id: randomUUID(),
            key: normKey(text),
            category,
            text,
            confidence: c,
            peakConfidence: c,
            idleOpportunities: 0,
            sources: [source(by, "added", raw.evidence)],
            firstSeen: now,
            lastConfirmed: now,
            status: "learned",
            ...(asDecayClass(raw.decayClass) ? { decayClass: asDecayClass(raw.decayClass)! } : {}),
        };
        out.push(f);
        touched.add(f.id);
        added++;
    }

    for (const j of (ctx.judgements || []).slice(0, 120)) {
        const f = out.find((x) => x.id === j.id && x.status !== "rejected");
        if (!f) continue;
        classify(f, j.decayClass);
        if (touched.has(f.id)) continue;
        const by = asEvidenceBy(j.by);
        if (j.verdict === "supports" && f.status !== "faded") {
            touched.add(f.id);
            support(f, by, j.evidence);
        } else if (j.verdict === "contradicts" && f.status !== "faded") {
            touched.add(f.id);
            contradicted++;
            f.sources = [...f.sources, source(by, "contradicts", j.evidence)].slice(-12);
            if (protectedFact(f)) ask(f, "contradiction", j.evidence);
            else {
                f.confidence = round2(Math.max(0, f.confidence - CONTRADICTION_DROP));
                if (f.confidence < FADE_BELOW) fade(f);
            }
        } else if (j.verdict === "silent" && j.opportunity && ctx.activeDay) opportunity.add(f.id);
    }

    // Opportunity-aware decay (see factPolicy): no opportunity today → no decay for that fact.
    let faded = 0;
    for (const f of out) {
        if (touched.has(f.id) || f.status !== "learned" || !opportunity.has(f.id)) continue;
        if (asked.has(f.id) && !questions.some((q) => q.factId === f.id)) continue; // waiting on the family
        f.idleOpportunities = (f.idleOpportunities || 0) + 1;
        const rule = ruleFor(f);
        if (rule.perOpportunity >= 1 || f.idleOpportunities <= rule.graceOpportunities) continue;
        f.confidence = round2(f.confidence * rule.perOpportunity);
        decayed++;
        const important = f.decayClass ? DECAY[f.decayClass].checkInBeforeFade : false;
        if (important && rule === DECAY[f.decayClass!] && !f.checkInAskedAt && (f.peakConfidence ?? f.confidence) >= CHECKIN_MIN_PEAK && f.confidence <= CHECKIN_AT) {
            f.checkInAskedAt = now;
            ask(f, "checkin");
            continue;
        }
        if (f.confidence < FADE_BELOW) {
            fade(f);
            faded++;
        }
    }
    return { facts: out, added, reinforced, revised, faded, blocked, contradicted, decayed, classified, readded, questions };
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
type MDay = Day & Pick<IElderWellbeingDay, "cards" | "firstCardOrders" | "corrections" | "caregiverEdits" | "orders" | "factsDeleted" | "factsReadded">;
/** factsCount = active learned facts; fadedEver = facts that have faded at least once (re-add denominator). */
export function weeklyMetrics(daysAsc: MDay[], factsCount: number, fadedEver = 0) {
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
        // Learned facts the family deleted this week (vs facts on the card) — "Saheli learned wrong".
        factDeleteRate: pct(sum(xs, (d) => d.factsDeleted || 0), sum(xs, (d) => d.factsDeleted || 0) + factsCount),
        // Facts re-learned this week after they had faded — "decay was too eager".
        readdAfterFadeRate: fadedEver ? pct(sum(xs, (d) => d.factsReadded || 0), fadedEver) : null,
        factsDeleted: sum(xs, (d) => d.factsDeleted || 0),
        factsReadded: sum(xs, (d) => d.factsReadded || 0),
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
