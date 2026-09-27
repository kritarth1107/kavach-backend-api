/**
 * ONE place for how learned facts gain and lose confidence (per decay class + evidence source).
 * Used by profileCore.applyReflection (pure) and the nightly reflection. Tune numbers here only.
 *
 *   decay class       time decay                      contradicted by the day
 *   health_condition  none (only caregiver/evidence)  caregiver question, no silent change
 *   allergy           none                            caregiver question
 *   safety            none                            caregiver question
 *   medication        slow (~30 opportunity days)     caregiver question
 *   routine           slow (~30 opportunity days)     −0.35
 *   preference        medium (~2 weeks of chances)    −0.35
 *   transient_state   fast (a few days)               −0.35
 *   other             medium                          −0.35
 *
 * Decay only accrues on an "opportunity" day: the day had activity AND Gemini judged that the
 * fact would naturally have shown up if it were still true (grocery orders happened but her usual
 * milk wasn't in them; she chatted about her day but not her evening walk). No activity = no decay.
 */
export const DECAY_CLASSES = ["health_condition", "allergy", "safety", "medication", "routine", "preference", "transient_state", "other"] as const;
export type DecayClass = (typeof DECAY_CLASSES)[number];

export type DecayRule = {
    /** Multiplier applied per opportunity day once past the grace period (1 = no time decay). */
    perOpportunity: number;
    /** Opportunity days without support before decay starts. */
    graceOpportunities: number;
    /** A contradiction never silently changes these: a caregiver question is raised instead. */
    askOnContradiction: boolean;
    /** Ask the caregiver once when the fact drops to CHECKIN_AT (instead of letting it quietly fade). */
    checkInBeforeFade: boolean;
};

export const DECAY: Record<DecayClass, DecayRule> = {
    health_condition: { perOpportunity: 1, graceOpportunities: 0, askOnContradiction: true, checkInBeforeFade: true },
    allergy: { perOpportunity: 1, graceOpportunities: 0, askOnContradiction: true, checkInBeforeFade: true },
    safety: { perOpportunity: 1, graceOpportunities: 0, askOnContradiction: true, checkInBeforeFade: true },
    // 0.8 → 0.25 after 7 grace + 23 decaying opportunity days ≈ 30; check-in (0.4) around day 21.
    medication: { perOpportunity: 0.95, graceOpportunities: 7, askOnContradiction: true, checkInBeforeFade: true },
    routine: { perOpportunity: 0.95, graceOpportunities: 7, askOnContradiction: false, checkInBeforeFade: true },
    // 0.7 → 0.25 after 3 grace + 10 decaying opportunity days.
    preference: { perOpportunity: 0.9, graceOpportunities: 3, askOnContradiction: false, checkInBeforeFade: false },
    // 0.6 → 0.42 → 0.29 → 0.21 (faded) in 3 days.
    transient_state: { perOpportunity: 0.7, graceOpportunities: 0, askOnContradiction: false, checkInBeforeFade: false },
    other: { perOpportunity: 0.9, graceOpportunities: 3, askOnContradiction: false, checkInBeforeFade: false },
};

/** A no-time-decay class only holds once it has real evidence; a lone Gemini guess decays like this. */
export const UNPROVEN_RULE: DecayRule = DECAY.preference;
export const PROVEN_AT = 0.6;

export const FADE_BELOW = 0.25;
export const CHECKIN_AT = 0.42; // "~0.4": ask the caregiver once before an important fact fades
export const CHECKIN_MIN_PEAK = 0.5; // only facts that were once believed (never a lone guess)
export const CONTRADICTION_DROP = 0.35;
export const QUESTION_EXPIRY_DAYS = 14;
export const MAX_CONFIDENCE = 0.95;

/** Evidence weighting: who the evidence came from. */
export const EVIDENCE_BY = ["elder", "caregiver", "orders", "inferred"] as const;
export type EvidenceBy = (typeof EVIDENCE_BY)[number];
export type EvidenceStrength = "strong" | "medium" | "weak";
export const STRENGTH: Record<EvidenceBy, EvidenceStrength> = { elder: "strong", caregiver: "strong", orders: "medium", inferred: "weak" };
export const EVIDENCE: Record<EvidenceStrength, { start: [number, number]; reinforce: number }> = {
    strong: { start: [0.55, 0.75], reinforce: 0.2 },
    medium: { start: [0.4, 0.55], reinforce: 0.12 },
    weak: { start: [0.3, 0.4], reinforce: 0.08 },
};

export function asDecayClass(x: unknown): DecayClass | null {
    return (DECAY_CLASSES as readonly string[]).includes(String(x)) ? (x as DecayClass) : null;
}
export function asEvidenceBy(x: unknown): EvidenceBy {
    return (EVIDENCE_BY as readonly string[]).includes(String(x)) ? (x as EvidenceBy) : "inferred";
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
