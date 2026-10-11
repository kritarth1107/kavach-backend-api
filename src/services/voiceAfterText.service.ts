/**
 * Saheli's voice note for a message whose text has already gone out. The text never waits for the voice: a voiced
 * reply used to be held until its audio was made (several seconds), so a quicker later reply overtook it (live
 * 2026-10-12: "Shall I place it now?" arrived after "Okay, placing the order now"). The audio is made now, in the
 * listener's language and dialect, and sent only if nothing newer reached that chat meanwhile: the text is already
 * there, and an earlier message heard after a newer one reads as a fresh question.
 */
import type { OutboundMessage } from "../channels/types";
import { chatMark, sendMetaWhatsAppAudio, sendMetaWhatsAppVoice, sendViaMetaWhatsApp, sentSince } from "../clients/metaWhatsApp.client";

export type VoiceAfterTextResult = "sent" | "stale" | "none" | "failed";

type Spoken = { audioBuffer?: Buffer; mimeType?: string };

export type VoiceAfterTextDeps = {
    speak: (text: string, listenerUserId?: string) => Promise<Spoken>;
    sendAudio: (to: string, audioBuffer: Buffer, mimeType: string) => Promise<void>;
    sentSince: (to: string, mark: number) => boolean;
};

async function speakFor(text: string, listenerUserId?: string): Promise<Spoken> {
    const { textToSpeech } = await import("../channels/voicePipeline");
    const { getSpeechProfile } = await import("./voicePreference.service");
    const { voiceHint } = await import("./language.service");
    const hint = listenerUserId ? voiceHint(await getSpeechProfile(listenerUserId)) : null;
    return textToSpeech(text, { languageHint: hint });
}

const DEFAULT_DEPS: VoiceAfterTextDeps = {
    speak: speakFor,
    sendAudio: (to, audioBuffer, mimeType) => sendMetaWhatsAppAudio({ to, audioBuffer, mimeType }),
    sentSince,
};

/** The chat's position right after a text went out: give it to sendVoiceAfterText. */
export const markAfterText = chatMark;

export async function sendVoiceAfterText(
    input: { to: string; text: string; listenerUserId?: string; mark: number },
    deps: VoiceAfterTextDeps = DEFAULT_DEPS,
): Promise<VoiceAfterTextResult> {
    try {
        const spoken = await deps.speak(input.text, input.listenerUserId);
        if (!spoken.audioBuffer) return "none";
        if (deps.sentSince(input.to, input.mark)) {
            console.log(`Voice note dropped for ${input.to.slice(0, 6)}…: a newer message went to the chat first`);
            return "stale";
        }
        await deps.sendAudio(input.to, spoken.audioBuffer, spoken.mimeType || "audio/mpeg");
        return "sent";
    } catch (err) {
        console.warn("Voice note after the text failed (the text was sent):", err instanceof Error ? err.message : err);
        return "failed";
    }
}

/**
 * Send one reply on WhatsApp: its text (and buttons) now, then its voice note when it is to be spoken (voiceLater),
 * without waiting for it. Audio that is the message itself (a song) goes with its text.
 */
export async function sendWhatsAppReply(msg: OutboundMessage): Promise<void> {
    if (msg.audioBuffer || msg.audioBase64) {
        await sendMetaWhatsAppVoice({
            to: msg.channelIdentifier,
            audioBuffer: msg.audioBuffer || Buffer.from(msg.audioBase64 || "", "base64"),
            mimeType: msg.audioMimeType || "audio/mpeg",
            caption: msg.content,
            payloads: msg.whatsappPayloads,
        });
        return;
    }
    await sendViaMetaWhatsApp(msg.channelIdentifier, msg.content, msg.whatsappPayloads);
    if (msg.voiceLater && msg.content?.trim()) {
        void sendVoiceAfterText({
            to: msg.channelIdentifier,
            text: msg.content,
            listenerUserId: msg.voiceLater.listenerUserId,
            mark: chatMark(msg.channelIdentifier),
        });
    }
}
