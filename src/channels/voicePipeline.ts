/**
 * Voice pipeline — STT/TTS abstraction.
 * Uses mock passthrough when Azure Speech keys are absent.
 */
export async function speechToText(input: {
    audioBase64?: string;
    fallbackText?: string;
}): Promise<string> {
    if (input.fallbackText?.trim()) return input.fallbackText.trim();
    if (input.audioBase64) {
        return "[voice note received — transcription pending Azure Speech configuration]";
    }
    return "";
}

export async function textToSpeech(text: string): Promise<{ audioBase64?: string; text: string }> {
    return { text, audioBase64: undefined };
}
