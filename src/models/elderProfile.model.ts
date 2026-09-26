import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Saheli's evolving, care-first picture of ONE elder (family-scoped: familyId + recipientUserId).
 * Learned nightly from the day's timeline; caregivers can confirm / edit / reject. Prompt context
 * only — it can never change safety rules (COD, literal confirm, harmful refusals, red flags,
 * silence alert, address book).
 */
export const FACT_CATEGORIES = [
    "health", // conditions, concerns, symptoms mentioned
    "wellbeing", // pain, sleep, appetite, energy
    "mood", // mood, loneliness, what lifts / worries her
    "medicines", // adherence patterns, side effects she mentions
    "routine", // walks, meals, sleep/wake, prayer, TV
    "people", // family, friends, relationships, how she likes to be addressed
    "cognition", // memory/cognition cues (observations only)
    "comfort", // what comforts her, topics she enjoys
    "communication", // nudge timing/tone/language, what works / doesn't
    "preferences", // food, brands, apps (shopping last)
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export type FactStatus = "learned" | "caregiver_confirmed" | "caregiver_edited" | "rejected" | "faded";

export type ProfileFact = {
    id: string;
    key: string; // normalized text for dedupe / never-relearn
    category: FactCategory;
    text: string;
    confidence: number; // 0..1
    sources: Array<{ kind: string; at: Date; ref?: string }>;
    firstSeen: Date;
    lastConfirmed: Date;
    status: FactStatus;
    editedBy?: string;
};

export type CareAction = {
    id: string;
    dayKey: string; // the day it's for (IST)
    kind: "follow_up" | "reminder" | "company" | "caregiver_suggestion" | "offer";
    text: string; // what Saheli will do / suggest
    say?: string; // elder-facing line in her language (for nudges), never "I ordered/booked"
    why: string;
    audience: "elder" | "caregiver";
    status: "planned" | "used" | "dismissed";
};

export type Deviation = { id: string; at: Date; dayKey: string; metric: string; text: string; days: number; severity: "watch" | "notable"; dismissed?: boolean };

/** Unusual-activity alert log (dedupe/rate-limit per key for 24h; tier decides WhatsApp vs dashboard). */
export type UnusualAlert = {
    id: string;
    at: Date;
    key: string; // dedupe key, e.g. "repeat_order:paracetamol"
    category: "repeat_order" | "bulk_quantity" | "large_spend" | "risky_meds" | "odd_hours" | "order_change" | "confusion" | "mood_drop" | "meds_missed" | "scam" | "other";
    confidence: number;
    tier: "whatsapp" | "dashboard";
    text: string; // caregiver-facing
    evidence?: string;
    source: "code" | "gemini" | "baseline";
    status: "sent" | "queued" | "logged" | "suppressed";
    dismissed?: boolean;
};

export interface IElderProfile {
    familyId: string;
    recipientUserId: string;
    facts: ProfileFact[];
    careActions: CareAction[];
    deviations: Deviation[];
    alerts?: UnusualAlert[];
    tuning: { maxOptions?: number; preferredNudgeHour?: number; addressAs?: string; language?: string };
    retentionDays: number;
    lastReflectedDay?: string;
    lastReflection?: { at: Date; model: string; added: number; reinforced: number; faded: number; actions: number };
    createdAt?: Date;
    updatedAt?: Date;
}
export interface IElderProfileDocument extends IElderProfile, Document {}

const schema = new Schema<IElderProfileDocument>(
    {
        familyId: { type: String, required: true },
        recipientUserId: { type: String, required: true },
        facts: { type: Schema.Types.Mixed as never, default: [] },
        careActions: { type: Schema.Types.Mixed as never, default: [] },
        deviations: { type: Schema.Types.Mixed as never, default: [] },
        alerts: { type: Schema.Types.Mixed as never, default: [] },
        tuning: { type: Schema.Types.Mixed, default: {} },
        retentionDays: { type: Number, default: 365 },
        lastReflectedDay: { type: String },
        lastReflection: { type: Schema.Types.Mixed },
    },
    { timestamps: true },
);
schema.index({ familyId: 1, recipientUserId: 1 }, { unique: true });

const ElderProfile: Model<IElderProfileDocument> =
    (mongoose.models.ElderProfile as Model<IElderProfileDocument>) || mongoose.model<IElderProfileDocument>("ElderProfile", schema);
export default ElderProfile;
