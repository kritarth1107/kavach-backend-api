import mongoose, { Schema } from "mongoose";

/**
 * A message that could not go out because the person's WhatsApp window was closed. They got a short template instead
 * (an alert, an order update); the message waits here and Saheli gives it on their next message. Kept a week.
 */
export interface IWhatsAppWaiting {
    phone: string;
    familyId: string;
    toUserId?: string;
    purpose: string;
    /** The delivery kind it was sent as (nudge, checkin, alert, reminder…): a nudge or check-in is about its moment. */
    kind?: string;
    text: string;
    createdAt: Date;
    deliveredAt?: Date;
    /** It waited past its moment and was dropped instead of given (a breakfast nudge in the afternoon). */
    expired?: boolean;
}

const schema = new Schema<IWhatsAppWaiting>(
    {
        phone: { type: String, required: true, index: true },
        familyId: { type: String, required: true },
        toUserId: { type: String, index: true },
        purpose: { type: String, required: true },
        kind: { type: String },
        text: { type: String, required: true },
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
        deliveredAt: { type: Date },
        expired: { type: Boolean },
    },
    { versionKey: false, collection: "whatsapp_waiting" },
);

export default mongoose.models.WhatsAppWaiting || mongoose.model<IWhatsAppWaiting>("WhatsAppWaiting", schema);
