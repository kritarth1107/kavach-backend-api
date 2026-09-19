import mongoose, { Document, Schema } from "mongoose";

export type WhatsappOrderPhase =
    | "select_address"
    | "browse"
    | "review_cart"
    | "pending_approval"
    | "completed";

export interface IWhatsappSession {
    phone: string;
    familyId?: string;
    userId?: string;
    pendingRecipientUserId?: string;
    awaitingRecipientPick?: boolean;
    recipientOptions?: Array<{ userId: string; name: string }>;
    guestTurns?: number;
    saheliSessionId?: string;
    orderSessionId?: string;
    orderPhase?: WhatsappOrderPhase;
    pendingOrderId?: string;
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
        saheliSessionId: { type: String },
        orderSessionId: { type: String },
        orderPhase: { type: String },
        pendingOrderId: { type: String },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
);

whatsappSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IWhatsappSessionDocument>(
    "WhatsappSession",
    whatsappSessionSchema,
);
