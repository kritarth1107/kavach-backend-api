import mongoose, { Document, Schema } from "mongoose";

export interface ICommerceAutomationSessionDocument extends Document {
    userId: string;
    partner: string;
    status: string;
    encryptedBlob?: string;
    otpChallengeId?: string;
    lastError?: string;
    connectedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const schema = new Schema<ICommerceAutomationSessionDocument>(
    {
        userId: { type: String, required: true, index: true },
        partner: { type: String, required: true, index: true },
        status: {
            type: String,
            required: true,
            default: "disconnected",
            enum: [
                "disconnected",
                "pending_login",
                "awaiting_otp",
                "connected",
                "expired",
                "error",
            ],
        },
        encryptedBlob: { type: String },
        otpChallengeId: { type: String },
        lastError: { type: String },
        connectedAt: { type: Date },
    },
    { timestamps: true },
);

schema.index({ userId: 1, partner: 1 }, { unique: true });

const CommerceAutomationSession = mongoose.model<ICommerceAutomationSessionDocument>(
    "CommerceAutomationSession",
    schema,
);

export default CommerceAutomationSession;
