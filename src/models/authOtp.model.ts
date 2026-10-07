import mongoose, { Schema } from "mongoose";

/**
 * One sign-in code (email or WhatsApp): wrong tries and use are kept in the database, so every server instance sees
 * them (a code can't be guessed 5 times per instance, or used twice). Removed when it expires.
 */
export interface IAuthOtpCode {
    jti: string;
    channel: "email" | "phone";
    tries: number;
    usedAt?: Date | null;
    expiresAt: Date;
}

const codeSchema = new Schema<IAuthOtpCode>(
    {
        jti: { type: String, required: true, unique: true },
        channel: { type: String, enum: ["email", "phone"], required: true },
        tries: { type: Number, default: 0 },
        usedAt: { type: Date, default: null },
        expiresAt: { type: Date, required: true },
    },
    { versionKey: false },
);
codeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const AuthOtpCode = mongoose.models.AuthOtpCode || mongoose.model<IAuthOtpCode>("AuthOtpCode", codeSchema, "auth_otp_codes");

/** Each WhatsApp sign-in code sent, for the per-number and hourly limits. Kept 2 days. */
const sendSchema = new Schema({ phoneKey: { type: String, required: true, index: true }, at: { type: Date, required: true } }, { versionKey: false });
sendSchema.index({ at: 1 }, { expireAfterSeconds: 2 * 24 * 3600 });

export const AuthOtpSend = mongoose.models.AuthOtpSend || mongoose.model("AuthOtpSend", sendSchema, "auth_otp_sends");
