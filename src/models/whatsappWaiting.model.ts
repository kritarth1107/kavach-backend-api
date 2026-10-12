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
    text: string;
    createdAt: Date;
    deliveredAt?: Date;
}

const schema = new Schema<IWhatsAppWaiting>(
    {
        phone: { type: String, required: true, index: true },
        familyId: { type: String, required: true },
        toUserId: { type: String, index: true },
        purpose: { type: String, required: true },
        text: { type: String, required: true },
        createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 7 },
        deliveredAt: { type: Date },
    },
    { versionKey: false, collection: "whatsapp_waiting" },
);

export default mongoose.models.WhatsAppWaiting || mongoose.model<IWhatsAppWaiting>("WhatsAppWaiting", schema);
