import mongoose, { Document, Schema } from "mongoose";
import type { OutreachSlot } from "./saheliCompanion.model";

export interface ISaheliOutreachLog {
    logId: string;
    familyId: string;
    recipientUserId: string;
    slot: OutreachSlot;
    slotDate: string;
    outreachKind: string;
    topicBucket?: string;
    topicHint?: string;
    channel: string;
    delivered: boolean;
    createdAt?: Date;
}

export interface ISaheliOutreachLogDocument extends ISaheliOutreachLog, Document {}

const saheliOutreachLogSchema = new Schema<ISaheliOutreachLogDocument>(
    {
        logId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        slot: {
            type: String,
            enum: ["morning", "afternoon", "evening", "random", "memory"],
            required: true,
        },
        slotDate: { type: String, required: true, index: true },
        outreachKind: { type: String, default: "casual" },
        topicBucket: { type: String },
        topicHint: { type: String },
        channel: { type: String, default: "dashboard" },
        delivered: { type: Boolean, default: true },
    },
    { timestamps: true },
);

saheliOutreachLogSchema.index(
    { familyId: 1, recipientUserId: 1, slotDate: 1, slot: 1 },
    { unique: true },
);

export default mongoose.model<ISaheliOutreachLogDocument>(
    "SaheliOutreachLog",
    saheliOutreachLogSchema,
);
