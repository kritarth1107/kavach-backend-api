import mongoose, { Document, Schema } from "mongoose";

export type OutreachSlot = "morning" | "afternoon" | "evening";

export type NudgeIntensity = "gentle" | "standard" | "persistent";

export interface ISaheliCompanion {
    familyId: string;
    recipientUserId: string;
    enabled: boolean;
    childName: string;
    relationshipLabel: string;
    personaNotes?: string;
    outreachSlots: OutreachSlot[];
    outreachTopics: string[];
    shareWithFamily: boolean;
    preferredChannel: "dashboard" | "whatsapp" | "phone";
    timezone: string;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    nudgeIntensity?: NudgeIntensity;
    preferredLanguage?: "english" | "hinglish" | "hindi" | "tamil";
    birthday?: string;
    importantDates?: Array<{ label: string; date: string }>;
    lastOutreachAt?: Date;
    lastWhatsAppInboundAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ISaheliCompanionDocument extends ISaheliCompanion, Document {}

const DEFAULT_SLOTS: OutreachSlot[] = ["morning", "afternoon", "evening"];
const DEFAULT_TOPICS = ["day_life", "family", "hobbies", "food", "mood", "memories"];

const saheliCompanionSchema = new Schema<ISaheliCompanionDocument>(
    {
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        enabled: { type: Boolean, default: true },
        childName: { type: String, default: "Saheli", trim: true, maxlength: 40 },
        relationshipLabel: {
            type: String,
            default: "your child",
            trim: true,
            maxlength: 80,
        },
        personaNotes: { type: String, trim: true, maxlength: 500 },
        outreachSlots: {
            type: [String],
            enum: ["morning", "afternoon", "evening"],
            default: DEFAULT_SLOTS,
        },
        outreachTopics: {
            type: [String],
            default: DEFAULT_TOPICS,
        },
        shareWithFamily: { type: Boolean, default: true },
        preferredChannel: {
            type: String,
            enum: ["dashboard", "whatsapp", "phone"],
            default: "whatsapp",
        },
        timezone: { type: String, default: "Asia/Kolkata" },
        quietHoursStart: { type: String },
        quietHoursEnd: { type: String },
        nudgeIntensity: {
            type: String,
            enum: ["gentle", "standard", "persistent"],
            default: "standard",
        },
        preferredLanguage: {
            type: String,
            enum: ["english", "hinglish", "hindi", "tamil"],
            default: "english",
        },
        birthday: { type: String },
        importantDates: [
            {
                label: { type: String, required: true },
                date: { type: String, required: true },
            },
        ],
        lastOutreachAt: { type: Date },
        lastWhatsAppInboundAt: { type: Date },
    },
    { timestamps: true },
);

saheliCompanionSchema.index({ familyId: 1, recipientUserId: 1 }, { unique: true });

export default mongoose.model<ISaheliCompanionDocument>(
    "SaheliCompanion",
    saheliCompanionSchema,
);

export const OUTREACH_SLOT_HOURS: Record<OutreachSlot, number> = {
    morning: 10,
    afternoon: 16,
    evening: 19,
};
