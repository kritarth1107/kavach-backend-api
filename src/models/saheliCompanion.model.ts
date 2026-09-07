import mongoose, { Document, Schema } from "mongoose";

export type OutreachSlot = "morning" | "afternoon" | "evening";

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
    lastOutreachAt?: Date;
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
        lastOutreachAt: { type: Date },
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
