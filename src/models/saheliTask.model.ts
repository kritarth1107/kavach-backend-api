import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Saheli as a persistent delegate: every unfinished thing she is carrying for one person, durably
 * (survives restarts, deploys and the 24 h WhatsApp-session TTL).
 *  - open_task: an order / ride / search she was in the middle of (resumable later, "Kal hum Dolo
 *    order kar rahe the — poora kar doon?").
 *  - followup: a placed order / booked ride she promised to check on ("Did your Telma arrive?").
 *  - approval: something outside what the family allowed — waiting for a caregiver's yes/no.
 * Keyed by the WhatsApp phone of the person talking (elder OR caregiver doing self-care) plus the
 * family + care recipient the dashboard shows it under.
 */
export type TaskKind = "open_task" | "followup" | "approval";
export type TaskStatus =
    | "open" // open_task: unfinished; followup: scheduled; approval: waiting
    | "asked" // followup question sent, waiting for her answer
    | "done"
    | "cancelled"
    | "expired"
    | "unanswered"
    | "approved"
    | "denied";

export interface ISaheliTask {
    taskId: string;
    familyId: string;
    recipientUserId: string;
    ownerUserId: string;
    phone: string;
    actorRole: "elder" | "caregiver";
    kind: TaskKind;
    status: TaskStatus;
    title: string;
    item?: string;
    productQuery?: string;
    partner?: string;
    category?: "grocery" | "food" | "pharmacy" | "ride" | "other";
    isMedicine?: boolean;
    important?: boolean;
    why?: string;
    whyId?: string;
    whyTries?: number;
    language?: string;
    // open_task
    flow?: string;
    phase?: string;
    lastSaheliLine?: string;
    lastUserLine?: string;
    rideFrom?: string;
    rideTo?: string;
    lastActiveAt?: Date;
    resumeOfferedAt?: Date;
    resumeOfferCount?: number;
    nudgedAt?: Date;
    // followup
    stage?: "delivery" | "started" | "ride";
    placedAt?: Date;
    etaText?: string;
    totalLabel?: string;
    orderRef?: string;
    dueAt?: Date;
    askedAt?: Date;
    askCount?: number;
    wamid?: string;
    outcome?: string;
    outcomeNote?: string;
    resolvedAt?: Date;
    // approval
    approval?: {
        reason: "category_off" | "store_off" | "over_limit";
        detail: string;
        amountPaise?: number | null;
        requestedText?: string;
        decidedBy?: string;
        decidedByName?: string;
        decidedAt?: Date;
        notifiedAt?: Date;
    };
    history: Array<{ at: Date; event: string; note?: string }>;
    expiresAt: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface ISaheliTaskDocument extends ISaheliTask, Document {}

const schema = new Schema<ISaheliTaskDocument>(
    {
        taskId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true },
        ownerUserId: { type: String, required: true },
        phone: { type: String, required: true },
        actorRole: { type: String, enum: ["elder", "caregiver"], default: "elder" },
        kind: { type: String, enum: ["open_task", "followup", "approval"], required: true },
        status: { type: String, required: true },
        title: { type: String, required: true, maxlength: 200 },
        item: String,
        productQuery: String,
        partner: String,
        category: String,
        isMedicine: Boolean,
        important: Boolean,
        why: { type: String, maxlength: 400 },
        whyId: String,
        whyTries: { type: Number, default: 0 },
        language: String,
        flow: String,
        phase: String,
        lastSaheliLine: { type: String, maxlength: 600 },
        lastUserLine: { type: String, maxlength: 300 },
        rideFrom: String,
        rideTo: String,
        lastActiveAt: Date,
        resumeOfferedAt: Date,
        resumeOfferCount: { type: Number, default: 0 },
        nudgedAt: Date,
        stage: String,
        placedAt: Date,
        etaText: String,
        totalLabel: String,
        orderRef: String,
        dueAt: Date,
        askedAt: Date,
        askCount: { type: Number, default: 0 },
        wamid: String,
        outcome: String,
        outcomeNote: { type: String, maxlength: 400 },
        resolvedAt: Date,
        approval: { type: Schema.Types.Mixed },
        history: { type: Schema.Types.Mixed as never, default: [] },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: true },
);
schema.index({ phone: 1, kind: 1, status: 1 });
schema.index({ familyId: 1, recipientUserId: 1, updatedAt: -1 });
schema.index({ kind: 1, status: 1, dueAt: 1 });
// Closed records stay 60 days for the dashboard history, then go.
schema.index({ updatedAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

const SaheliTask: Model<ISaheliTaskDocument> =
    (mongoose.models.SaheliTask as Model<ISaheliTaskDocument>) || mongoose.model<ISaheliTaskDocument>("SaheliTask", schema);
export default SaheliTask;
