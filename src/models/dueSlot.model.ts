import mongoose, { Schema } from "mongoose";

/**
 * The due list (trust plan B1.4): every dose and reminder time due each day, one row per slot, built at midnight IST
 * from the care schedules and the reminders Saheli set (and rebuilt within a minute when either changes). Each slot then
 * becomes one of:
 *   scheduled → sent → delivered → read   (WhatsApp's own receipts, through the delivery ledger)
 *   held      (on purpose, with the reason: already marked taken, quiet hours, paused, an order in progress, skipped…)
 *   failed    (with the reason: Meta refused it, no number, closed chat and no template…)
 *   missed    (its time passed and nothing was attempted)
 *   removed   (the schedule or reminder was deleted or changed before its time)
 * The dose alert (B1.5) and the 23:30 report (B1.6) read it.
 */
export type DueSlotState = "scheduled" | "sent" | "delivered" | "read" | "held" | "failed" | "missed" | "removed";

export interface IDueSlot {
    /** dose:<scheduleId>:<day> or reminder:<reminderId>:<HH:MM>:<day> (the delivery ledger's refId for its send). */
    slotKey: string;
    dateKey: string;
    familyId: string;
    recipientUserId: string;
    kind: "dose" | "reminder";
    /** The care schedule id, or the reminder id. */
    refId: string;
    title: string;
    time: string;
    dueAt: Date;
    /** A medicine (every dose; a reminder linked to a medicine). */
    medicine: boolean;
    /** A medicine marked critical: its escalation is never held for quiet hours. */
    critical?: boolean;
    state: DueSlotState;
    reason?: string;
    attempts?: number;
    wamid?: string;
    sentAt?: Date;
    deliveredAt?: Date;
    readAt?: Date;
    failedAt?: Date;
    /** A test number's send (simulated, never reaches Meta): left out of alerts and reports. */
    test?: boolean;
    /** The team was alerted about this slot (once per slot). */
    alertedAt?: Date;
    alertReason?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

const schema = new Schema<IDueSlot>(
    {
        slotKey: { type: String, required: true, unique: true },
        dateKey: { type: String, required: true },
        familyId: { type: String, required: true },
        recipientUserId: { type: String, required: true },
        kind: { type: String, required: true, enum: ["dose", "reminder"] },
        refId: { type: String, required: true },
        title: { type: String, default: "" },
        time: { type: String, default: "" },
        dueAt: { type: Date, required: true },
        medicine: { type: Boolean, default: false },
        critical: { type: Boolean },
        state: { type: String, required: true, enum: ["scheduled", "sent", "delivered", "read", "held", "failed", "missed", "removed"] },
        reason: { type: String },
        attempts: { type: Number },
        wamid: { type: String },
        sentAt: { type: Date },
        deliveredAt: { type: Date },
        readAt: { type: Date },
        failedAt: { type: Date },
        test: { type: Boolean },
        alertedAt: { type: Date },
        alertReason: { type: String },
        // kept 120 days (the reports and the admin page read the recent part)
        createdAt: { type: Date, default: Date.now, expires: 120 * 24 * 60 * 60 },
    },
    { versionKey: false, collection: "due_slots", timestamps: { createdAt: false, updatedAt: true } },
);

schema.index({ dateKey: 1, familyId: 1 });
schema.index({ dateKey: 1, state: 1 });

export default (mongoose.models.DueSlot as mongoose.Model<IDueSlot>) || mongoose.model<IDueSlot>("DueSlot", schema);
