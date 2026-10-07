/**
 * Voice replies per person: "auto" (voice when they send voice), "always", or "never". Set on WhatsApp (Saheli's
 * voice_replies tool, through saheliTools) and on the dashboard; the WhatsApp reply path and reminders read it.
 */
import { type VoiceMode, VOICE_MODES } from "../models/voicePreference.model";
import { normaliseSpeech, type SpeechProfile } from "./language.service";

const cache = new Map<string, { mode: VoiceMode; at: number }>();
const speechCache = new Map<string, { p: SpeechProfile; at: number }>();
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

/** The language, dialect and script Saheli uses with this person ({} when not known yet). */
export async function getSpeechProfile(userId: string): Promise<SpeechProfile> {
    const hit = speechCache.get(userId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.p;
    try {
        const { default: VP } = await import("../models/voicePreference.model");
        const row = (await VP.findOne({ userId }, { language: 1, dialect: 1, script: 1 }).lean()) as SpeechProfile | null;
        const p = normaliseSpeech({ language: row?.language, dialect: row?.dialect, script: row?.script });
        speechCache.set(userId, { p, at: Date.now() });
        return p;
    } catch {
        return {};
    }
}

/** Save how Saheli speaks to someone (from onboarding, the dashboard, or Saheli when they tell her on WhatsApp). */
export async function setSpeechProfile(input: { userId: string; familyId: string; by: string } & { language?: unknown; dialect?: unknown; script?: unknown }): Promise<SpeechProfile> {
    const p = normaliseSpeech(input);
    const set: Record<string, unknown> = { familyId: input.familyId, updatedBy: input.by };
    if (p.language) set.language = p.language;
    if (input.dialect !== undefined || p.dialect) set.dialect = p.dialect ?? null; // "no dialect" clears it
    if (p.script) set.script = p.script;
    const { default: VP } = await import("../models/voicePreference.model");
    // A new language without a dialect drops the old dialect (Marwari is a way of speaking Hindi, not Tamil).
    if (p.language && !("dialect" in set)) {
        const current = await VP.findOne({ userId: input.userId }).lean<{ language?: string; dialect?: string | null }>();
        if (current?.dialect && current.language !== p.language) set.dialect = null;
    }
    await VP.updateOne({ userId: input.userId }, { $set: set, $setOnInsert: { mode: "auto" } }, { upsert: true });
    speechCache.delete(input.userId);
    return getSpeechProfile(input.userId);
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
