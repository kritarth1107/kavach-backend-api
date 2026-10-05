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
    /** What we know of how this person speaks: "hi", "hinglish", "tamil", "bn-IN", … (first in the list the engines try). */
    languageHint?: string | null;
    fallbackText?: string;
    /** Only these engines, in this order (tests and the voice test set); default sttOrder(). */
    engines?: Array<"chirp" | "scribe" | "gemini">;
};

/** Every language Saheli speaks, as BCP-47 codes the speech engines understand. */
const LANG_CODES: Record<string, string> = {
    en: "en-IN", english: "en-IN", hi: "hi-IN", hindi: "hi-IN", hinglish: "hi-IN", ta: "ta-IN", tamil: "ta-IN",
    bn: "bn-IN", bengali: "bn-IN", bangla: "bn-IN", mr: "mr-IN", marathi: "mr-IN", te: "te-IN", telugu: "te-IN",
    kn: "kn-IN", kannada: "kn-IN", gu: "gu-IN", gujarati: "gu-IN", pa: "pa-Guru-IN", punjabi: "pa-Guru-IN",
    or: "or-IN", odia: "or-IN", oriya: "or-IN", ml: "ml-IN", malayalam: "ml-IN", ur: "ur-IN", urdu: "ur-IN",
    as: "as-IN", assamese: "as-IN",
};

/** BCP-47 code for a hint ("hinglish", "Tamil", "ta", "ta-IN", "tam"), or undefined. */
export function languageCodeFor(hint?: string | null): string | undefined {
    const h = String(hint ?? "").trim().toLowerCase();
    if (!h) return undefined;
    if (LANG_CODES[h]) return LANG_CODES[h];
    const base = h.split(/[-_]/)[0];
    if (LANG_CODES[base]) return LANG_CODES[base];
    const iso3: Record<string, string> = { hin: "hi", eng: "en", tam: "ta", ben: "bn", mar: "mr", tel: "te", kan: "kn", guj: "gu",
        pan: "pa", ori: "or", ory: "or", mal: "ml", urd: "ur", asm: "as" };
    return iso3[base] ? LANG_CODES[iso3[base]] : undefined;
}

/** Up to 3 codes for Chirp: the person's own language first, then Hindi and Indian English (the most common mix). */
export function sttLanguageCodes(hint?: string | null, explicit?: string): string[] {
    const first = explicit || languageCodeFor(hint);
    return [...new Set([first, "hi-IN", "en-IN"].filter((c): c is string => !!c))].slice(0, 3);
}

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
    engine: "chirp_3" | "scribe" | "gemini" | "fallback" | "none";
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
    languageHint?: string | null;
}): Promise<SttResult | null> {
    const token = await getAccessToken();
    if (!token) return null;

    const project = gcpProjectId();
    const location = speechLocation();
    const url = `https://${location}-speech.googleapis.com/v2/projects/${project}/locations/${location}/recognizers/_:recognize`;

    const languageCodes = sttLanguageCodes(input.languageHint, input.languageCode);

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

function elevenLabsSttModel(): string {
    return process.env.ELEVENLABS_STT_MODEL?.trim() || "scribe_v1";
}

/** Parse an ElevenLabs speech-to-text answer (exported for tests). */
export function parseScribe(json: {
    text?: string;
    language_code?: string;
    language_probability?: number;
    words?: Array<{ text?: string; type?: string; logprob?: number }>;
}): SttResult | null {
    const text = String(json.text ?? "")
        .replace(/\([^)]{1,40}\)/g, " ") // audio-event tags such as (background noise)
        .replace(/\s{2,}/g, " ")
        .trim();
    if (!text) return null;
    const probs = (json.words || [])
        .filter((w) => w.type !== "spacing" && w.type !== "audio_event" && typeof w.logprob === "number")
        .map((w) => Math.exp(w.logprob as number));
    return {
        text,
        engine: "scribe",
        confidence: probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : undefined,
        language: languageCodeFor(json.language_code) || json.language_code,
    };
}

/** ElevenLabs speech-to-text: works when Google is unavailable, and detects the language itself. */
async function scribeSpeechToText(input: { base64: string; mimeType: string; languageHint?: string | null }): Promise<SttResult | null> {
    const apiKey = elevenLabsApiKey();
    if (!apiKey) return null;
    const form = new FormData();
    form.append("model_id", elevenLabsSttModel());
    form.append("tag_audio_events", "false");
    const code = languageCodeFor(input.languageHint);
    // Hinglish is mixed: let the engine detect rather than force Hindi
    if (code && String(input.languageHint).toLowerCase() !== "hinglish") form.append("language_code", code.split("-")[0]);
    const ext = input.mimeType.includes("mpeg") ? "mp3" : input.mimeType.includes("wav") ? "wav" : "ogg";
    form.append("file", new Blob([Buffer.from(input.base64, "base64")], { type: input.mimeType }), `voice.${ext}`);
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": apiKey }, body: form });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`ElevenLabs STT failed (${res.status}): ${body.slice(0, 240)}`);
        return null;
    }
    return parseScribe((await res.json()) as Parameters<typeof parseScribe>[0]);
}

/** Order the speech engines are tried in (STT_ORDER=chirp,scribe,gemini). */
export function sttOrder(env: NodeJS.ProcessEnv = process.env): Array<"chirp" | "scribe" | "gemini"> {
    const valid = new Set(["chirp", "scribe", "gemini"]);
    const order = (env.STT_ORDER || "chirp,scribe,gemini").split(",").map((s) => s.trim().toLowerCase()).filter((s) => valid.has(s));
    return (order.length ? [...new Set(order)] : ["chirp", "scribe", "gemini"]) as Array<"chirp" | "scribe" | "gemini">;
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

    let unclear = false;
    for (const engine of input.engines ?? sttOrder()) {
        try {
            const got =
                engine === "chirp"
                    ? await chirp3SpeechToText({ base64: audio.base64, languageCode: input.languageCode, languageHint: input.languageHint })
                    : engine === "scribe"
                      ? await scribeSpeechToText({ ...audio, languageHint: input.languageHint })
                      : await geminiAudioSpeechToText(audio);
            if (got?.text) {
                console.log(`STT: ${got.engine} ok, chars=${got.text.length} confidence=${got.confidence ?? "n/a"} lang=${got.language ?? "?"}`);
                return got;
            }
            unclear = unclear || Boolean(got?.unclear);
        } catch (err) {
            console.warn(`STT ${engine} error:`, err instanceof Error ? err.message : err);
        }
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
