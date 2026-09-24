import mongoose, { Document, Schema } from "mongoose";

export type SaheliReminderStatus = "active" | "completed" | "cancelled";
export type SaheliReminderKind = "multi_time" | "hourly_window";

export interface ISaheliReminder {
    reminderId: string;
    familyId: string;
    recipientUserId: string;
    companionId?: string;
    text: string;
    /** HH:MM 24h slots for multi_time daily reminders (Asia/Kolkata). */
    times: string[];
    kind: SaheliReminderKind;
    timezone: string;
    /** Minutes since midnight for hourly window start. */
    windowStartMinutes?: number;
    /** Minutes since midnight for hourly window end; null = slot-fill needed. */
    windowEndMinutes?: number | null;
    /** Semantic stop phrase e.g. "I filled it" / "done". */
    stopConditionPhrase?: string;
    status: SaheliReminderStatus;
    createdBy: string;
    lastFiredAt?: Date;
    lastFiredSlotKey?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ISaheliReminderDocument extends ISaheliReminder, Document {}

const saheliReminderSchema = new Schema<ISaheliReminderDocument>(
    {
        reminderId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        companionId: { type: String },
        text: { type: String, required: true, trim: true, maxlength: 400 },
        times: { type: [String], default: [] },
        kind: {
            type: String,
            enum: ["multi_time", "hourly_window"],
            default: "multi_time",
        },
        timezone: { type: String, default: "Asia/Kolkata" },
        windowStartMinutes: { type: Number },
        windowEndMinutes: { type: Number, default: null },
        stopConditionPhrase: { type: String, trim: true, maxlength: 200 },
        status: {
            type: String,
            enum: ["active", "completed", "cancelled"],
            default: "active",
            index: true,
        },
        createdBy: { type: String, required: true },
        lastFiredAt: { type: Date },
        lastFiredSlotKey: { type: String },
    },
    { timestamps: true },
);

saheliReminderSchema.index({ familyId: 1, recipientUserId: 1, status: 1 });
saheliReminderSchema.index({ status: 1, kind: 1 });

export default mongoose.model<ISaheliReminderDocument>("SaheliReminder", saheliReminderSchema);
