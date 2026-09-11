import mongoose, { Document, Schema } from "mongoose";

export interface IWhatsappSession {
    phone: string;
    familyId?: string;
    userId?: string;
    pendingRecipientUserId?: string;
    awaitingRecipientPick?: boolean;
    recipientOptions?: Array<{ userId: string; name: string }>;
    guestTurns?: number;
    expiresAt: Date;
}

export interface IWhatsappSessionDocument extends IWhatsappSession, Document {}

const whatsappSessionSchema = new Schema<IWhatsappSessionDocument>(
    {
        phone: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, index: true },
        userId: { type: String },
        pendingRecipientUserId: { type: String },
        awaitingRecipientPick: { type: Boolean, default: false },
        recipientOptions: [
            {
                userId: { type: String, required: true },
                name: { type: String, required: true },
            },
        ],
        guestTurns: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
);

whatsappSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IWhatsappSessionDocument>(
    "WhatsappSession",
    whatsappSessionSchema,
);
