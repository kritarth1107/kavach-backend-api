/**
 * Saheli sings: a short song (a bhajan, lullaby, folk song, a birthday song) as a WhatsApp voice note to a family member,
 * usually the person who asked. Singing takes 5–40 s, so the engine waits at most WAIT_MS; a slower song still goes out.
 */
import { isMetaWhatsAppEnabled, sendMetaWhatsAppVoice } from "../clients/metaWhatsApp.client";
import { isSmokeFixturePhone } from "./smokeFixtures.service";

export const WAIT_MS = 28_000; // the engine's tool call gives up at 35 s

export type SongResult = { delivered: boolean; sending?: boolean; reason?: string };

export async function sendSongNote(input: {
    familyId: string;
    recipientUserId: string;
    toUserId: string;
    actorUserId?: string;
    lyrics: string;
    style?: string;
    title?: string;
}): Promise<SongResult> {
    const lyrics = String(input.lyrics ?? "").trim();
    if (!lyrics) return { delivered: false, reason: "no lyrics" };
    const { flagsLoadedAt, isSaheliPaused, refreshFlags } = await import("./featureFlags.service");
    if (!flagsLoadedAt()) await refreshFlags().catch(() => undefined);
    if (isSaheliPaused(input.familyId)) return { delivered: false, reason: "paused" };
    const { familyMemberPhone } = await import("./careMemorySync.service");
    const found = await familyMemberPhone(input.familyId, input.toUserId);
    if ("reason" in found) return { delivered: false, reason: found.reason };
    const { isPlaceholderWhatsAppNumber } = await import("./whatsappRecipientGuard.service");
    if (await isPlaceholderWhatsAppNumber(found.phone)) return { delivered: false, reason: "invalid_recipient" };

    const job = singAndSend({ ...input, lyrics, phone: found.phone }).catch((err): SongResult => {
        console.warn("Song voice note failed:", err instanceof Error ? err.message : err);
        return { delivered: false, reason: /24|window|re-engage|131047/i.test(String(err)) ? "outside the 24-hour WhatsApp window" : "send failed" };
    });
    const late = new Promise<SongResult>((resolve) => setTimeout(() => resolve({ delivered: false, sending: true }), WAIT_MS).unref?.());
    return Promise.race([job, late]);
}

async function singAndSend(input: { familyId: string; recipientUserId: string; toUserId: string; actorUserId?: string; lyrics: string; style?: string; title?: string; phone: string }): Promise<SongResult> {
    const { singToVoiceNote } = await import("../channels/voicePipeline");
    const { getSpeechProfile } = await import("./voicePreference.service");
    const { voiceHint } = await import("./language.service");
    const sung = await singToVoiceNote(input.lyrics, { languageHint: voiceHint(await getSpeechProfile(input.toUserId)), style: input.style });
    if (!sung.audioBuffer) return { delivered: false, reason: "no singing voice available right now" };
    if (isSmokeFixturePhone(input.phone) || !isMetaWhatsAppEnabled()) {
        const { recordSaheliOutbound } = await import("./whatsappMockPeek.service");
        recordSaheliOutbound(input.phone, `[song voice note] ${input.title || ""}\n${input.lyrics}`.trim(), "simulated:song");
    } else {
        await sendMetaWhatsAppVoice({ to: input.phone, audioBuffer: sung.audioBuffer, mimeType: sung.mimeType || "audio/ogg" });
    }
    const { logActivity } = await import("./activityLog.service");
    void logActivity({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        kind: "message_out",
        title: `Saheli sang${input.title ? `: ${input.title}` : " a song"}`,
        detail: input.lyrics,
        data: { song: true, toUserId: input.toUserId, style: input.style || null },
    });
    return { delivered: true };
}
