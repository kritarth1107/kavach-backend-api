/**
 * Voice pipeline — STT (Chirp 3 preferred, Gemini audio fallback) + TTS (ElevenLabs).
 * Skips live TTS when ELEVENLABS_API_KEY / ELEVEN_LABS_API_KEY is absent.
 */
import { GoogleAuth } from "google-auth-library";
import { preferPro, vertexLocationForModel } from "../clients/vertexGemini.client";

export type SttInput = {
    audioBase64?: string;
    audioBuffer?: Buffer;
    mimeType?: string;
    languageCode?: string;
    fallbackText?: string;
};

function elevenLabsApiKey(): string {
    return (
        process.env.ELEVENLABS_API_KEY?.trim() ||
        process.env.ELEVEN_LABS_API_KEY?.trim() ||
        ""
    );
}

function gcpProjectId(): string {
    return (
        process.env.GCP_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        "kavach-care"
    );
}

function speechLocation(): string {
    return process.env.SPEECH_LOCATION?.trim() || process.env.GCP_SPEECH_LOCATION?.trim() || "us";
}

function vertexSttModel(): string {
    return preferPro(process.env.VERTEX_STT_MODEL);
}

function vertexLocation(): string {
    return vertexLocationForModel(vertexSttModel());
}

async function getAccessToken(): Promise<string | null> {
    try {
        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        return token.token || null;
    } catch (err) {
        console.warn(
            "GCP access token unavailable for STT:",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

function audioPayload(input: SttInput): { base64: string; mimeType: string } | null {
    if (input.audioBuffer && input.audioBuffer.length) {
        return {
            base64: input.audioBuffer.toString("base64"),
            mimeType: input.mimeType || "audio/ogg",
        };
    }
    if (input.audioBase64?.trim()) {
        return {
            base64: input.audioBase64.trim(),
            mimeType: input.mimeType || "audio/ogg",
        };
    }
    return null;
}

export type SttResult = {
    text: string;
    engine: "chirp_3" | "gemini" | "fallback" | "none";
    /** 0..1 when the engine reports it (Chirp); undefined when it does not. */
    confidence?: number;
    /** BCP-47 code the engine heard, e.g. "hi-IN". */
    language?: string;
    /** The engine said it could not make out the words. */
    unclear?: boolean;
};

const UNCLEAR_MARK = "[unclear]";

async function chirp3SpeechToText(input: {
    base64: string;
    languageCode?: string;
}): Promise<SttResult | null> {
    const token = await getAccessToken();
    if (!token) return null;

    const project = gcpProjectId();
    const location = speechLocation();
    const url = `https://${location}-speech.googleapis.com/v2/projects/${project}/locations/${location}/recognizers/_:recognize`;

    const languageCodes = [
        input.languageCode || "en-IN",
        "hi-IN",
        "ta-IN",
        "kn-IN",
        "en-US",
    ];

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-goog-user-project": project,
        },
        body: JSON.stringify({
            config: {
                autoDecodingConfig: {},
                languageCodes,
                model: "chirp_3",
                features: { enableAutomaticPunctuation: true },
            },
            content: input.base64,
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`Chirp3 STT failed (${res.status}): ${body.slice(0, 240)}`);
        return null;
    }

    const json = (await res.json()) as {
        results?: Array<{ alternatives?: Array<{ transcript?: string; confidence?: number }>; languageCode?: string }>;
    };
    const results = (json.results || []).filter((r) => r.alternatives?.[0]?.transcript?.trim());
    const transcript = results.map((r) => r.alternatives![0].transcript!.trim()).join(" ").trim();
    if (!transcript) return null;
    // Chirp reports confidence for some languages only (0 means "not reported")
    const confs = results.map((r) => r.alternatives![0].confidence ?? 0).filter((c) => c > 0);
    return {
        text: transcript,
        engine: "chirp_3",
        confidence: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : undefined,
        language: results.find((r) => r.languageCode)?.languageCode,
    };
}

async function geminiAudioSpeechToText(input: {
    base64: string;
    mimeType: string;
}): Promise<SttResult | null> {
    const token = await getAccessToken();
    if (!token) return null;

    const project = gcpProjectId();
    const location = vertexLocation();
    const model = vertexSttModel();
    const host =
        location === "global"
            ? "https://aiplatform.googleapis.com"
            : `https://${location}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-goog-user-project": project,
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            text:
                                "Transcribe this voice message exactly. Return only the transcript text, no commentary. Preserve the spoken " +
                                "language and script the speaker would use (English, Hindi, Hinglish in Latin letters, Tamil, Bengali, Marathi, " +
                                `Telugu, Kannada, Gujarati, Punjabi, Odia, Malayalam, Urdu). If you cannot make out the words, return exactly ${UNCLEAR_MARK}`,
                        },
                        {
                            inlineData: {
                                mimeType: input.mimeType,
                                data: input.base64,
                            },
                        },
                    ],
                },
            ],
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`Gemini audio STT failed (${res.status}): ${body.slice(0, 240)}`);
        return null;
    }

    const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!text) return null;
    const unclear = text.toLowerCase().includes(UNCLEAR_MARK);
    return { text: unclear ? "" : text, engine: "gemini", unclear };
}

/** Transcript plus what the engine knows about how sure it is (Saheli asks again instead of guessing when it is not). */
export async function speechToTextDetailed(input: SttInput): Promise<SttResult> {
    if (input.fallbackText?.trim() && !input.audioBase64 && !input.audioBuffer) {
        return { text: input.fallbackText.trim(), engine: "fallback" };
    }

    const audio = audioPayload(input);
    if (!audio) {
        return { text: input.fallbackText?.trim() || "", engine: input.fallbackText?.trim() ? "fallback" : "none" };
    }

    try {
        const chirp = await chirp3SpeechToText({
            base64: audio.base64,
            languageCode: input.languageCode,
        });
        if (chirp) {
            console.log("STT: Chirp3 transcript ok, chars=", chirp.text.length, "confidence=", chirp.confidence ?? "n/a");
            return chirp;
        }
    } catch (err) {
        console.warn("STT Chirp3 error:", err instanceof Error ? err.message : err);
    }

    let unclear = false;
    try {
        const gemini = await geminiAudioSpeechToText(audio);
        if (gemini?.text) {
            console.log("STT: Gemini audio transcript ok, chars=", gemini.text.length);
            return gemini;
        }
        unclear = Boolean(gemini?.unclear);
    } catch (err) {
        console.warn("STT Gemini error:", err instanceof Error ? err.message : err);
    }

    if (input.fallbackText?.trim()) return { text: input.fallbackText.trim(), engine: "fallback" };
    return { text: "", engine: "none", unclear };
}

export async function speechToText(input: SttInput): Promise<string> {
    return (await speechToTextDetailed(input)).text;
}

/** Below this, Saheli treats a transcript as unsure: she checks what she heard before changing the care record. */
export const VOICE_SURE = 0.6;

/**
 * Text as it should be spoken: no emoji, markdown, links or list bullets (a voice note reads them out or stumbles).
 * The full text still goes as a message next to the voice note.
 */
export function speakable(text: string): string {
    return String(text ?? "")
        .replace(/https?:\/\/\S+/g, "")
        .replace(/[*_~`#>]+/g, "")
        .replace(/^\s*[-•·]\s+/gm, "")
        .replace(/^\s*\d+[.)]\s+/gm, "")
        .replace(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/gu, "")
        .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
        .replace(/\s*\n+\s*/g, ". ")
        .replace(/\s{2,}/g, " ")
        .replace(/(\.\s*){2,}/g, ". ")
        .replace(/^[.\s]+/, "")
        .trim();
}

/** Saheli default voice: "Anika – Natural Conversations" (Indian female, Hindi/Hinglish). */
export const DEFAULT_ELEVENLABS_VOICE_ID = "A5W9pR9OjIbu80J0WuDW";
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

export function getTtsVoiceConfig() {
    return {
        voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
        modelId: process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_ELEVENLABS_MODEL_ID,
        voiceSettings: {
            stability: envNumber("ELEVENLABS_STABILITY", 0.45),
            similarity_boost: envNumber("ELEVENLABS_SIMILARITY", 0.75),
            style: envNumber("ELEVENLABS_STYLE", 0.2),
            use_speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST?.trim() !== "false",
        },
    };
}

let lastTts:
    | { at: string; voiceId: string; modelId: string; ok: boolean; bytes?: number; status?: number }
    | null = null;

/** Non-secret TTS runtime snapshot (for /meta/debug). */
export function getTtsDebugSnapshot() {
    const cfg = getTtsVoiceConfig();
    return { configured: Boolean(elevenLabsApiKey()), ...cfg, lastTts };
}

export async function textToSpeech(
    text: string,
): Promise<{ audioBase64?: string; audioBuffer?: Buffer; mimeType?: string; text: string }> {
    const trimmed = text.trim();
    if (!trimmed) return { text };
    const spoken = speakable(trimmed);
    if (!spoken) return { text: trimmed };

    const apiKey = elevenLabsApiKey();
    if (!apiKey) {
        console.log("TTS: ELEVENLABS_API_KEY missing — text-only reply");
        return { text: trimmed };
    }

    const { voiceId, modelId, voiceSettings } = getTtsVoiceConfig();
    const started = Date.now();

    try {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: {
                "xi-api-key": apiKey,
                "Content-Type": "application/json",
                Accept: "audio/mpeg",
            },
            body: JSON.stringify({
                text: spoken.slice(0, 2500),
                model_id: modelId,
                voice_settings: voiceSettings,
            }),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            lastTts = { at: new Date().toISOString(), voiceId, modelId, ok: false, status: res.status };
            console.warn(
                `ElevenLabs TTS failed (${res.status}) voice=${voiceId} model=${modelId}: ${body.slice(0, 200)}`,
            );
            return { text: trimmed };
        }
        const ab = await res.arrayBuffer();
        const buffer = Buffer.from(ab);
        lastTts = { at: new Date().toISOString(), voiceId, modelId, ok: true, bytes: buffer.length };
        console.log(
            `TTS: ElevenLabs ok voice=${voiceId} model=${modelId} bytes=${buffer.length} ms=${Date.now() - started}`,
        );
        return {
            text: trimmed,
            audioBuffer: buffer,
            audioBase64: buffer.toString("base64"),
            mimeType: "audio/mpeg",
        };
    } catch (err) {
        console.warn("ElevenLabs TTS error:", err instanceof Error ? err.message : err);
        return { text: trimmed };
    }
}

export function isElevenLabsConfigured(): boolean {
    return Boolean(elevenLabsApiKey());
}
