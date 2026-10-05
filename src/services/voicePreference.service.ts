/**
 * Voice replies per person: "auto" (voice when they send voice), "always", or "never". Set on WhatsApp (Saheli's
 * voice_replies tool, through saheliTools) and on the dashboard; the WhatsApp reply path and reminders read it.
 */
import { type VoiceMode, VOICE_MODES } from "../models/voicePreference.model";

const cache = new Map<string, { mode: VoiceMode; at: number }>();
const CACHE_MS = 60_000;

export function isVoiceMode(v: unknown): v is VoiceMode {
    return typeof v === "string" && (VOICE_MODES as string[]).includes(v);
}

export async function getVoiceMode(userId: string): Promise<VoiceMode> {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.mode;
    try {
        const { default: VP } = await import("../models/voicePreference.model");
        const row = (await VP.findOne({ userId }, { mode: 1 }).lean()) as { mode?: string } | null;
        const mode = isVoiceMode(row?.mode) ? row!.mode as VoiceMode : "auto";
        cache.set(userId, { mode, at: Date.now() });
        return mode;
    } catch {
        return "auto"; // never let a lookup failure change how she replies
    }
}

export async function setVoiceMode(input: { userId: string; familyId: string; mode: VoiceMode; by: string }): Promise<VoiceMode> {
    const { default: VP } = await import("../models/voicePreference.model");
    await VP.updateOne(
        { userId: input.userId },
        { $set: { mode: input.mode, familyId: input.familyId, updatedBy: input.by } },
        { upsert: true },
    );
    cache.set(input.userId, { mode: input.mode, at: Date.now() });
    return input.mode;
}

/** Should this reply go as a voice note too? */
export function wantsVoice(mode: VoiceMode, inboundWasVoice: boolean): boolean {
    return mode === "always" || (mode === "auto" && inboundWasVoice);
}

export const VOICE_MODE_LABEL: Record<VoiceMode, string> = {
    auto: "voice notes when they send one",
    always: "always voice notes (plus text)",
    never: "text only",
};
