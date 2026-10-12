import mongoose, { Schema } from "mongoose";

/**
 * WhatsApp's 24-hour window, per number: a business may write freely only within 24 hours of the person's last message;
 * after that only an approved template reaches them. One row per number (digits only), for everyone who writes to
 * Saheli: care recipients, caregivers, family members, new numbers.
 */
export interface IWhatsAppWindow {
    phone: string;
    lastInboundAt: Date;
    /** Meta said a free message could not reach them (error 131047): the window is closed whatever lastInboundAt says. */
    closedAt?: Date;
}

const schema = new Schema<IWhatsAppWindow>(
    {
        phone: { type: String, required: true, unique: true },
        lastInboundAt: { type: Date, required: true },
        closedAt: { type: Date },
    },
    { versionKey: false, collection: "whatsapp_windows" },
);

export default mongoose.models.WhatsAppWindow || mongoose.model<IWhatsAppWindow>("WhatsAppWindow", schema);
