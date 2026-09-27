import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * "Why" memory: the reason / context behind an order or important request, in her words' gist
 * ("ran out of BP medicine, doctor said continue"). Attached to the usual + follow-ups, and
 * updated when new information connects to it (doctor stopped it, price jump, out of stock).
 */
export type WhyUpdate = {
    at: Date;
    kind: "stopped" | "dose_changed" | "continue" | "price_up" | "out_of_stock" | "delivery_issue" | "not_started" | "started" | "note";
    note: string;
    source?: string;
};

export interface ISaheliWhy {
    whyId: string;
    familyId: string;
    recipientUserId: string;
    ownerUserId?: string;
    subject: string;
    key: string;
    category?: string;
    reason: string;
    source: "order" | "request" | "chat";
    importance: "high" | "normal";
    status: "active" | "stopped" | "paused";
    lastPricePaise?: number | null;
    partner?: string;
    updates: WhyUpdate[];
    lastUsedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
}
export interface ISaheliWhyDocument extends ISaheliWhy, Document {}

const schema = new Schema<ISaheliWhyDocument>(
    {
        whyId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true },
        ownerUserId: String,
        subject: { type: String, required: true, maxlength: 140 },
        key: { type: String, required: true },
        category: String,
        reason: { type: String, required: true, maxlength: 400 },
        source: { type: String, default: "order" },
        importance: { type: String, default: "normal" },
        status: { type: String, default: "active" },
        lastPricePaise: Number,
        partner: String,
        updates: { type: Schema.Types.Mixed as never, default: [] },
        lastUsedAt: Date,
    },
    { timestamps: true },
);
schema.index({ familyId: 1, recipientUserId: 1, key: 1 });

const SaheliWhy: Model<ISaheliWhyDocument> =
    (mongoose.models.SaheliWhy as Model<ISaheliWhyDocument>) || mongoose.model<ISaheliWhyDocument>("SaheliWhy", schema);
export default SaheliWhy;
