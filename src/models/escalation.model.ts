import mongoose, { Schema } from "mongoose";

/**
 * One row per silence streak that reached 3 unanswered proactive messages (trust plan B2: "after 3 nudges with no reply,
 * the caregiver hears, as agreed"). The streak is read from the delivery ledger (reminders, dose reminders and follow-ups,
 * nudges, check-ins), so every family counts, brain v2 or not. The 09:00 check reads these rows against the ledger.
 *   pending   the third went out; waiting the 60-minute grace (or for the caregivers' quiet hours to end)
 *   sent      at least one caregiver (or a self-care person's emergency contact) was told
 *   deferred  past the grace, every caregiver is in their quiet hours: goes when the first wakes
 *   replied   they wrote (or tapped Done) before the alert: nothing sent
 *   none      no one to tell (self-care with no emergency contact, no caregiver with WhatsApp)
 */
export type EscalationState = "pending" | "sent" | "deferred" | "replied" | "none";

export interface IEscalation {
    /** The first unanswered message of the streak (its ledger row id): one alert per streak. */
    streakKey: string;
    familyId: string;
    personUserId: string;
    firstAt: Date;
    thirdAt: Date;
    /** thirdAt + the grace (60 minutes): when the alert is due. */
    dueAt: Date;
    count: number;
    /** How many of the unanswered messages WhatsApp says they read ("seen but not answered"). */
    seen: number;
    /** One of them was a dose reminder for a medicine marked critical: never held for quiet hours. */
    critical: boolean;
    selfCare: boolean;
    state: EscalationState;
    reason?: string;
    sentAt?: Date;
    deferredAt?: Date;
    repliedAt?: Date;
    notified: string[];
    /** Told some caregivers; the rest were in their quiet hours and hear when they wake. */
    partial?: boolean;
    /** The emergency contact was told (self-care), by template. */
    contactNotifiedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

const schema = new Schema<IEscalation>(
    {
        streakKey: { type: String, required: true, unique: true },
        familyId: { type: String, required: true },
        personUserId: { type: String, required: true },
        firstAt: { type: Date, required: true },
        thirdAt: { type: Date, required: true },
        dueAt: { type: Date, required: true },
        count: { type: Number, default: 3 },
        seen: { type: Number, default: 0 },
        critical: { type: Boolean, default: false },
        selfCare: { type: Boolean, default: false },
        state: { type: String, required: true, enum: ["pending", "sent", "deferred", "replied", "none"] },
        reason: { type: String },
        sentAt: { type: Date },
        deferredAt: { type: Date },
        repliedAt: { type: Date },
        notified: { type: [String], default: [] },
        partial: { type: Boolean },
        contactNotifiedAt: { type: Date },
        createdAt: { type: Date, default: Date.now, expires: 180 * 24 * 60 * 60 },
    },
    { versionKey: false, collection: "escalations", timestamps: { createdAt: false, updatedAt: true } },
);
schema.index({ state: 1, dueAt: 1 });
schema.index({ personUserId: 1, thirdAt: -1 });
schema.index({ thirdAt: 1 });

export default (mongoose.models.Escalation as mongoose.Model<IEscalation>) || mongoose.model<IEscalation>("Escalation", schema);

/** The 09:00 check's result for one IST day (B2.5b): escalations on time x/y, with every case. */
export interface IEscalationCheck {
    dateKey: string;
    checkedAt: Date;
    onTime: number;
    total: number;
    cases: Array<{ family: string; person: string; personUserId: string; thirdAt: Date; dueAt: Date; outcome: string; reason?: string;
        alertAt?: Date; onTime: boolean }>;
    emailedAt?: Date;
}

const checkSchema = new Schema<IEscalationCheck>(
    {
        dateKey: { type: String, required: true, unique: true },
        checkedAt: { type: Date, required: true },
        onTime: { type: Number, required: true },
        total: { type: Number, required: true },
        cases: { type: Schema.Types.Mixed, default: [] },
        emailedAt: { type: Date },
    },
    { versionKey: false, collection: "escalation_checks" },
);

export const EscalationCheck = (mongoose.models.EscalationCheck as mongoose.Model<IEscalationCheck>) ||
    mongoose.model<IEscalationCheck>("EscalationCheck", checkSchema);
