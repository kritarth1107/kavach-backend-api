import mongoose, { Schema } from "mongoose";

/**
 * How Saheli speaks to a person. One row per person (elder or caregiver, self care included).
 * mode — auto: voice when they send a voice note (the default) · always: every reply and reminder also as voice · never: text only.
 * language / dialect / script — the language she writes and speaks to them in (codes from language.service), their dialect
 * (Marwari, Maithili…), and "roman" only when they asked for Roman letters (default: the language's own script).
 */
export type VoiceMode = "auto" | "always" | "never";
export const VOICE_MODES: VoiceMode[] = ["auto", "always", "never"];

export interface IVoicePreference {
    userId: string;
    familyId: string;
    mode: VoiceMode;
    language?: string | null;
    dialect?: string | null;
    script?: "native" | "roman" | null;
    updatedBy: string;
    updatedAt?: Date;
    createdAt?: Date;
}

const voicePreferenceSchema = new Schema<IVoicePreference>(
    {
        userId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        mode: { type: String, enum: VOICE_MODES, required: true, default: "auto" },
        language: { type: String, default: null },
        dialect: { type: String, default: null },
        script: { type: String, enum: ["native", "roman", null], default: null },
        updatedBy: { type: String, required: true },
    },
    { timestamps: true },
);

export default mongoose.models.VoicePreference || mongoose.model<IVoicePreference>("VoicePreference", voicePreferenceSchema, "voice_preferences");
