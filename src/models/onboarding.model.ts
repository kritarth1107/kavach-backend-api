import mongoose, { Schema } from "mongoose";

/**
 * A new caregiver's onboarding: their answers so far (saved after every question, so a refresh or another device
 * picks up where they left off) and the WhatsApp numbers they verified. Removed 30 days after it is finished.
 */
export interface IOnboardingDraft {
    userId: string;
    familyId: string;
    answers: Record<string, unknown>;
    step: string;
    completedAt?: Date | null;
    result?: Record<string, unknown> | null;
    updatedAt?: Date;
    createdAt?: Date;
}

const draftSchema = new Schema<IOnboardingDraft>(
    {
        userId: { type: String, required: true, index: true },
        familyId: { type: String, required: true },
        answers: { type: Schema.Types.Mixed, default: {} },
        step: { type: String, default: "welcome" },
        completedAt: { type: Date, default: null },
        result: { type: Schema.Types.Mixed, default: null },
    },
    { timestamps: true, minimize: false },
);

export const OnboardingDraft = mongoose.models.OnboardingDraft || mongoose.model<IOnboardingDraft>("OnboardingDraft", draftSchema, "onboarding_drafts");

/**
 * Proving a WhatsApp number belongs to the person: they send "KAVACH 123456" from it to Saheli's number. No message
 * template is needed (none is approved yet), and it opens WhatsApp's 24-hour window so Saheli can greet them at once.
 */
export interface IPhoneVerification {
    code: string; // sha256 of the 6-digit code
    userId: string;
    familyId: string;
    target: string; // "self" | "person:0" | "person:1"
    phoneKey: string; // last 10 digits of the number typed in
    phone: string; // as typed, E.164
    method: "message" | "otp"; // they send "KAVACH 123456" to Saheli, or we send the code (approved "otp" template)
    tries: number;
    expiresAt: Date;
    verifiedAt?: Date | null;
    createdAt?: Date;
}

const verificationSchema = new Schema<IPhoneVerification>(
    {
        code: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        familyId: { type: String, required: true },
        target: { type: String, required: true },
        phoneKey: { type: String, required: true, index: true },
        phone: { type: String, required: true },
        method: { type: String, enum: ["message", "otp"], default: "message" },
        tries: { type: Number, default: 0 },
        expiresAt: { type: Date, required: true },
        verifiedAt: { type: Date, default: null },
    },
    { timestamps: true },
);

export const PhoneVerification =
    mongoose.models.PhoneVerification || mongoose.model<IPhoneVerification>("PhoneVerification", verificationSchema, "onboarding_phone_verifications");
