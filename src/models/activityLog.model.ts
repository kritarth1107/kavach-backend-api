import mongoose, { Document, Schema } from "mongoose";

/**
 * Everything a care recipient does with Saheli (messages, voice notes, order steps,
 * rides, reminders, moods/health mentions, browser diagnostics). Read by the caregiver
 * dashboard activity feed + daily snapshot — NOT pushed to caregiver WhatsApp.
 */
export type ActivityKind =
    | "message_in"
    | "message_out"
    | "voice_note"
    | "order_step"
    | "order_confirm_card"
    | "order_placed"
    | "order_failed"
    | "order_cancelled"
    | "order_interrupt"
    | "ride"
    | "reminder"
    | "mood"
    | "health"
    | "caregiver_alert"
    | "diag";

export const ACTIVITY_KINDS: ActivityKind[] = [
    "message_in",
    "message_out",
    "voice_note",
    "order_step",
    "order_confirm_card",
    "order_placed",
    "order_failed",
    "order_cancelled",
    "order_interrupt",
    "ride",
    "reminder",
    "mood",
    "health",
    "caregiver_alert",
    "diag",
];

export interface IActivityLog {
    familyId: string;
    recipientUserId: string;
    actorUserId?: string;
    kind: ActivityKind;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
    severity: "info" | "warn" | "error";
    /** IST calendar day YYYY-MM-DD (snapshot bucket). */
    dayKey: string;
    createdAt?: Date;
}

export interface IActivityLogDocument extends IActivityLog, Document {}

const activityLogSchema = new Schema<IActivityLogDocument>(
    {
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true },
        actorUserId: { type: String },
        kind: { type: String, enum: ACTIVITY_KINDS, required: true },
        title: { type: String, required: true, maxlength: 200 },
        detail: { type: String, maxlength: 4000 },
        data: { type: Schema.Types.Mixed },
        severity: { type: String, enum: ["info", "warn", "error"], default: "info" },
        dayKey: { type: String, required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

activityLogSchema.index({ recipientUserId: 1, createdAt: -1 });
activityLogSchema.index({ recipientUserId: 1, dayKey: 1, createdAt: 1 });
// Keep ~120 days of activity.
activityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 120 * 24 * 3600 });

const ActivityLog =
    (mongoose.models.ActivityLog as mongoose.Model<IActivityLogDocument>) ||
    mongoose.model<IActivityLogDocument>("ActivityLog", activityLogSchema);

export default ActivityLog;
