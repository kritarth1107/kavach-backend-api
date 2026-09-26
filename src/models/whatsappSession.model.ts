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
    /** Mid-order ask waiting for cancel-and-switch confirm */
    pendingOrderSwitchText?: string;
    /** Pharmacy WA draft (Apollo / PharmEasy / 1mg) */
    pharmacyDraft?: Record<string, unknown>;
    /** Partner OTP relay while connecting elder-owned commerce session */
    pendingCommerceOtp?: { partner: string; challengeId?: string };
    /** Private browser / Gemini computer-use task draft */
    browserTaskDraft?: Record<string, unknown>;
    /** Ride booking draft (Uber web / OTP / confirm-before-book) */
    rideDraft?: Record<string, unknown>;
    /** Saheli asked "what should I call this place?" for a newly saved family place. */
    pendingPlaceName?: { addressId: string; familyId: string; at: Date };
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
        pendingOrderSwitchText: { type: String },
        pharmacyDraft: { type: Schema.Types.Mixed },
        pendingCommerceOtp: { type: Schema.Types.Mixed },
        browserTaskDraft: { type: Schema.Types.Mixed },
        rideDraft: { type: Schema.Types.Mixed },
        pendingPlaceName: { type: Schema.Types.Mixed },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
);

whatsappSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IWhatsappSessionDocument>(
    "WhatsappSession",
    whatsappSessionSchema,
);
