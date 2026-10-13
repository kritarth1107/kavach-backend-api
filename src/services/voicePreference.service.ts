/**
 * Voice replies per person: "auto" (voice when they send voice), "always", or "never", and the language, dialect and
 * script Saheli uses with them. The engine's care record is the truth (trust plan A1: the language:preferred fact, read
 * through clients/enginePerson.client.ts, cached 60 s); the Mongo VoicePreference row is only a copy, written by the sync
 * from the engine (the set_voice_preference host tool), and read when the engine has nothing or cannot be reached.
 */
import { type VoiceMode, VOICE_MODES } from "../models/voicePreference.model";
import { normaliseSpeech, type SpeechProfile } from "./language.service";

const cache = new Map<string, { mode: VoiceMode; at: number }>();
const speechCache = new Map<string, { p: SpeechProfile; at: number }>();
const CACHE_MS = 60_000;

export function isVoiceMode(v: unknown): v is VoiceMode {
    return typeof v === "string" && (VOICE_MODES as string[]).includes(v);
}

export async function getVoiceMode(userId: string, familyId?: string): Promise<VoiceMode> {
    const fam = familyId || (await familyOf(userId));
    if (fam) {
        const { getEnginePerson } = await import("../clients/enginePerson.client");
        const p = await getEnginePerson(fam, userId).catch(() => null);
        if (p?.voice) return p.voice;
    }
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

/** The family a person belongs to (the copy row knows it; else their active family). */
async function familyOf(userId: string): Promise<string | null> {
    try {
        const { default: VP } = await import("../models/voicePreference.model");
        const row = (await VP.findOne({ userId }, { familyId: 1 }).lean()) as { familyId?: string } | null;
        if (row?.familyId) return row.familyId;
        const { default: Family } = await import("../models/family.model");
        const fam = await Family.findOne({ status: "ACTIVE", members: { $elemMatch: { userId, status: { $nin: ["REMOVED", "REJECTED"] } } } }).lean<{ familyId: string }>();
        return fam?.familyId ?? null;
    } catch {
        return null;
    }
}

/** The sync copy of the voice setting: written when the engine saves it (the set_voice_preference host tool). */
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

/** The language, dialect and script Saheli uses with this person ({} when not known yet): the care record first. */
export async function getSpeechProfile(userId: string, familyId?: string): Promise<SpeechProfile> {
    const fam = familyId || (await familyOf(userId));
    if (fam) {
        const { getEnginePerson } = await import("../clients/enginePerson.client");
        const e = await getEnginePerson(fam, userId).catch(() => null);
        const p = normaliseSpeech({ language: e?.language, dialect: e?.dialect, script: e?.script });
        if (p.language) return p;
    }
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

/** Drop this person's cached copy (the engine changed their setting). */
export function forgetVoiceCache(userId: string): void {
    cache.delete(userId);
    speechCache.delete(userId);
}

/** The sync copy of how Saheli speaks to someone: written when the engine saves it (the set_voice_preference host tool). */
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
