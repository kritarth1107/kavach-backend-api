import mongoose, { Schema } from "mongoose";

/**
 * One row per inbound WhatsApp message id (wamid). Unique index = cross-instance claim,
 * so Meta webhook retries (or parallel Cloud Run instances) never produce a second reply.
 * TTL keeps the collection small (Meta retries for up to ~7 days; 8d buffer).
 */
export interface IWhatsappInboundDedupe {
    messageId: string;
    from?: string;
    /**
     * The number it came from (digits): their messages over the last 8 days, which the 09:00 escalation check reads to
     * know when a streak of unanswered messages was broken (trust plan B2.5b).
     */
    phone?: string;
    /** Media it carried (Meta media id + type): a later reply quoting this message brings the media back to Saheli. */
    mediaId?: string;
    mediaType?: string;
    createdAt: Date;
}

const schema = new Schema<IWhatsappInboundDedupe>(
    {
        messageId: { type: String, required: true, unique: true },
        from: { type: String },
        phone: { type: String },
        mediaId: { type: String },
        mediaType: { type: String },
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 8 },
    },
    { versionKey: false, collection: "whatsapp_inbound_dedupe" },
);
schema.index({ phone: 1, createdAt: -1 });

export default mongoose.models.WhatsappInboundDedupe ||
    mongoose.model<IWhatsappInboundDedupe>("WhatsappInboundDedupe", schema);
