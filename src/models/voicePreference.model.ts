import mongoose, { Schema } from "mongoose";

/**
 * Whether Saheli answers a person with voice notes. One row per person (elder or caregiver, self care included).
 * auto: voice when they send a voice note (the default) · always: every reply and reminder also as voice · never: text only.
 */
export type VoiceMode = "auto" | "always" | "never";
export const VOICE_MODES: VoiceMode[] = ["auto", "always", "never"];

export interface IVoicePreference {
    userId: string;
    familyId: string;
    mode: VoiceMode;
    updatedBy: string;
    updatedAt?: Date;
    createdAt?: Date;
}

const voicePreferenceSchema = new Schema<IVoicePreference>(
    {
        userId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        mode: { type: String, enum: VOICE_MODES, required: true, default: "auto" },
        updatedBy: { type: String, required: true },
    },
    { timestamps: true },
);

export default mongoose.models.VoicePreference || mongoose.model<IVoicePreference>("VoicePreference", voicePreferenceSchema, "voice_preferences");
