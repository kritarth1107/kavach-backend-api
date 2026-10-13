import mongoose, { Document, Schema } from "mongoose";

export type SaheliNudgeKind =
    | "pre_reminder"
    | "missed_followup"
    | "completion_praise"
    | "appointment_prep"
    | "daily_schedule"
    | "dose_due"
    /** The second follow-up after a missed dose ("persistent" intensity, 55–95 min): its own slot, so it can send. */
    | "missed_followup_2";

/** What WhatsApp said about the message (its own receipts, trust plan B1.3): "delivered" means it reached the phone. */
export type NudgeDeliveryStatus = "sent" | "delivered" | "read" | "failed";

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
    /** Number of send attempts made for this slot (legacy rows: treat missing as 1). */
    attempts?: number;
    lastAttemptAt?: Date;
    /** No further attempts for this slot (e.g. no valid recipient / placeholder number). */
    terminal?: boolean;
    reason?: string;
    /** The WhatsApp message id of the send (the delivery ledger's row). */
    wamid?: string;
    /**
     * WhatsApp's own receipt: sent (Meta accepted it), delivered (on the phone), read, failed. `delivered` above stays
     * "Meta accepted it" for the slot bookkeeping (it stops a resend); this is what the dashboard and reports show.
     */
    deliveryStatus?: NudgeDeliveryStatus;
    deliveredAt?: Date;
    readAt?: Date;
    failedAt?: Date;
    errorCode?: number;
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
        attempts: { type: Number, default: 0 },
        lastAttemptAt: { type: Date },
        terminal: { type: Boolean, default: false },
        reason: { type: String },
        wamid: { type: String },
        deliveryStatus: { type: String, enum: ["sent", "delivered", "read", "failed"] },
        deliveredAt: { type: Date },
        readAt: { type: Date },
        failedAt: { type: Date },
        errorCode: { type: Number },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

saheliNudgeLogSchema.index(
    { familyId: 1, recipientUserId: 1, scheduleId: 1, dateKey: 1, nudgeKind: 1 },
    { unique: true, partialFilterExpression: { scheduleId: { $type: "string" } } },
);

export default mongoose.model<ISaheliNudgeLogDocument>("SaheliNudgeLog", saheliNudgeLogSchema);
