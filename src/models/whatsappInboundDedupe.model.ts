import mongoose, { Schema } from "mongoose";

/**
 * One row per inbound WhatsApp message id (wamid). Unique index = cross-instance claim,
 * so Meta webhook retries (or parallel Cloud Run instances) never produce a second reply.
 * TTL keeps the collection small (Meta retries for up to ~7 days; 8d buffer).
 */
export interface IWhatsappInboundDedupe {
    messageId: string;
    from?: string;
    createdAt: Date;
}

const schema = new Schema<IWhatsappInboundDedupe>(
    {
        messageId: { type: String, required: true, unique: true },
        from: { type: String },
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 8 },
    },
    { versionKey: false, collection: "whatsapp_inbound_dedupe" },
);

export default mongoose.models.WhatsappInboundDedupe ||
    mongoose.model<IWhatsappInboundDedupe>("WhatsappInboundDedupe", schema);
