import mongoose, { Schema } from "mongoose";

/**
 * The delivery ledger (trust plan B1.1, founder 2026-10-13: "every reminder records whether it was sent, delivered and
 * read, using WhatsApp's own receipts"). One row per WhatsApp message we send (a long text that WhatsApp splits is one
 * row per part), written by the Meta client the moment Meta accepts it, with the wamid Meta gave it. WhatsApp's status
 * receipts (sent, delivered, read, failed) then update the row by wamid. A message that never reached Meta (their chat
 * was closed and no template fits, or the call failed) is a row too, with status "failed" and no wamid.
 */
export const DELIVERY_KINDS = [
    "dose_reminder", // a care-schedule medicine at its time
    "dose_followup", // the follow-ups after a dose (missed_followup, missed_followup_2, a late catch-up)
    "reminder", // a reminder Saheli set (custom reminders), and the care schedule's other reminders
    "nudge", // a regular nudge (the engine's ladder) or the old outreach check-ins' follow-ups
    "checkin", // a check-in Saheli starts (engine check-ins, the old outreach)
    "alert", // a caregiver alert (nudge_silence, health, dose…)
    "brief", // the nightly brief / the day's schedule message
    "reply", // Saheli's answer to a message they just sent
    "message", // anything else Saheli starts (a relay, news from a task, an order update)
    "waiting", // a message that waited while their chat was closed, given on their next message
    "otp", // a sign-in code
] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

/** The kinds that are Saheli reaching out on her own and expect an answer: the escalation streak counts these (B2.1). */
export const PROACTIVE_KINDS: DeliveryKind[] = ["dose_reminder", "dose_followup", "reminder", "nudge", "checkin"];

export type DeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface IMessageDelivery {
    wamid?: string;
    /** The number it went to (digits only). */
    phone: string;
    familyId?: string;
    /** Who reads it. */
    toUserId?: string;
    /** Who it is about (the elder, for a caregiver's alert). */
    aboutUserId?: string;
    kind: DeliveryKind;
    /** What it is for: the due-list slot (dose:<schedule>:<day> / reminder:<id>:<HH:MM>:<day>), a nudge id, a turn ref… */
    refId?: string;
    /** The reminder ledger row (SaheliNudgeLog.nudgeId) this send belongs to. */
    nudgeId?: string;
    dueAt?: Date;
    /** Meta accepted it (HTTP 200 with a wamid). */
    sentAt?: Date;
    /** WhatsApp's own receipts. */
    deliveredAt?: Date;
    readAt?: Date;
    failedAt?: Date;
    errorCode?: number;
    errorTitle?: string;
    status: DeliveryStatus;
    viaTemplate?: boolean;
    template?: string;
    attempt?: number;
    /** A dose of a medicine marked critical (its escalation is never held for quiet hours). */
    critical?: boolean;
    /** Which part of a message WhatsApp split (0 = the first). */
    part?: number;
    createdAt?: Date;
    updatedAt?: Date;
}

const schema = new Schema<IMessageDelivery>(
    {
        wamid: { type: String },
        phone: { type: String, required: true },
        familyId: { type: String },
        toUserId: { type: String },
        aboutUserId: { type: String },
        kind: { type: String, required: true, enum: DELIVERY_KINDS as unknown as string[] },
        refId: { type: String },
        nudgeId: { type: String },
        dueAt: { type: Date },
        sentAt: { type: Date },
        deliveredAt: { type: Date },
        readAt: { type: Date },
        failedAt: { type: Date },
        errorCode: { type: Number },
        errorTitle: { type: String },
        status: { type: String, required: true, enum: ["sent", "delivered", "read", "failed"] },
        viaTemplate: { type: Boolean },
        template: { type: String },
        attempt: { type: Number },
        critical: { type: Boolean },
        part: { type: Number },
        // kept 180 days: the daily report, the 09:00 escalation check and the dashboard read the recent part
        createdAt: { type: Date, default: Date.now, expires: 180 * 24 * 60 * 60 },
    },
    { versionKey: false, collection: "message_deliveries", timestamps: { createdAt: false, updatedAt: true } },
);

schema.index({ wamid: 1 }, { unique: true, partialFilterExpression: { wamid: { $type: "string" } } });
schema.index({ toUserId: 1, sentAt: -1 });
schema.index({ familyId: 1, createdAt: -1 });
schema.index({ refId: 1 });
schema.index({ nudgeId: 1 });

export default (mongoose.models.MessageDelivery as mongoose.Model<IMessageDelivery>) ||
    mongoose.model<IMessageDelivery>("MessageDelivery", schema);
