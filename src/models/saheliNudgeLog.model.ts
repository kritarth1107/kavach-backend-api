import mongoose, { Document, Schema } from "mongoose";

export type SaheliNudgeKind =
    | "pre_reminder"
    | "missed_followup"
    | "completion_praise"
    | "appointment_prep"
    | "daily_schedule";

export interface ISaheliNudgeLog {
    nudgeId: string;
    familyId: string;
    recipientUserId: string;
    scheduleId?: string;
    dateKey: string;
    nudgeKind: SaheliNudgeKind;
    delivered: boolean;
    channel: string;
    messagePreview?: string;
    createdAt: Date;
}

export interface ISaheliNudgeLogDocument extends ISaheliNudgeLog, Document {}

const saheliNudgeLogSchema = new Schema<ISaheliNudgeLogDocument>(
    {
        nudgeId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        scheduleId: { type: String, index: true },
        dateKey: { type: String, required: true, index: true },
        nudgeKind: { type: String, required: true },
        delivered: { type: Boolean, default: false },
        channel: { type: String, default: "whatsapp" },
        messagePreview: { type: String },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

saheliNudgeLogSchema.index(
    { familyId: 1, recipientUserId: 1, scheduleId: 1, dateKey: 1, nudgeKind: 1 },
    { unique: true, partialFilterExpression: { scheduleId: { $type: "string" } } },
);

export default mongoose.model<ISaheliNudgeLogDocument>("SaheliNudgeLog", saheliNudgeLogSchema);
