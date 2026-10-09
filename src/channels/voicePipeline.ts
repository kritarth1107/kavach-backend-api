/**
 * Voice pipeline — STT (Chirp 3 preferred, Gemini audio fallback) + TTS.
 * TTS (2026-10-09, founder: "non-English voices sound like reading a script, no emotion, accent unclear"):
 * 1. prepareSpeech turns the WhatsApp text into what Saheli would *say* (short spoken sentences, a natural filler, pauses)
 *    and picks a mood (concerned, reassuring, cheerful, gentle, neutral). Facts and numbers stay exactly as written.
 * 2. ElevenLabs v4 first (emotion tags, every Indian language incl. Bengali, Odia, Assamese, Urdu; ~4 s), Gemini 2.5 Pro
 *    TTS next (style prompt per mood; no bn-IN), Google Chirp 3 HD last (no emotion control; it was the flat voice).
 * Chosen after an A/B of 6 engines × 5 languages (agent workspace voice/ab): a Gemini audio judge rated Chirp 4/5 for
 * naturalness and emotion and ElevenLabs v4 / Gemini 2.5 Pro 5/5; ElevenLabs was ~2.5× faster than Gemini Pro TTS.
 * TTS_ORDER (eleven,gemini,google) and TTS_ORDER_BY_LANG ('{"bn":"eleven,google"}') change the order.
 */
import { spawn } from "node:child_process";
import { GoogleAuth } from "google-auth-library";
import { preferPro, vertexLocationForModel } from "../clients/vertexGemini.client";
import { dialectBase, speechLabel } from "../services/language.service";

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
/**
 * Words a voice says wrong, and how to spell them so it says them right. Built-ins plus TTS_SAY_AS='{"Ecosprin":"Eko-sprin"}',
 * filled in after listening to real reminders (medicine brand names are the usual ones).
 */
const SAY_AS: Record<string, string> = { OTP: "O T P", COD: "cash on delivery", BP: "B P", ECG: "E C G", SOS: "S O S" };

function sayAs(text: string): string {
    let extra: Record<string, string> = {};
    try {
        extra = JSON.parse(process.env.TTS_SAY_AS || "{}");
    } catch {
        extra = {};
    }
    let out = text;
    for (const [word, spoken] of Object.entries({ ...SAY_AS, ...extra })) {
        if (!word || typeof spoken !== "string") continue;
        out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), spoken);
    }
    return out;
}

export function speakable(text: string): string {
    return sayAs(String(text ?? ""))
        .replace(/https?:\/\/\S+/g, "")
        // BP 130/80 → "130 by 80", as it is said in India (only numbers that look like a BP, never a date)
        .replace(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/g, (m, a, b) => (+a >= 70 && +a <= 260 && +b >= 40 && +b < +a ? `${a} by ${b}` : m))
        .replace(/\b0(\d):(\d\d)\b/g, "$1:$2") // 08:00 → 8:00
        .replace(/\b(\d+(?:\.\d+)?)\s*mg\b/gi, "$1 milligram")
        .replace(/\b(\d+(?:\.\d+)?)\s*mcg\b/gi, "$1 microgram")
        .replace(/\b(\d+(?:\.\d+)?)\s*ml\b/gi, "$1 ml")
        .replace(/₹\s*(\d[\d,]*)/g, "$1 rupaye")
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
/** v4 speaks every Indian language Saheli needs and follows emotion tags ([warmly], [gently]); v2 spoke only hi/ta. */
export const DEFAULT_ELEVENLABS_MODEL_ID = "eleven_v4";

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

/** The language a reply is written in, from its script (Latin = English or Hinglish, which the default voice speaks). */
export function speechLanguage(text: string): string {
    const counts: Array<[string, RegExp]> = [
        ["ta", /[\u0B80-\u0BFF]/g], ["bn", /[\u0980-\u09FF]/g], ["gu", /[\u0A80-\u0AFF]/g], ["pa", /[\u0A00-\u0A7F]/g],
        ["or", /[\u0B00-\u0B7F]/g], ["te", /[\u0C00-\u0C7F]/g], ["kn", /[\u0C80-\u0CFF]/g], ["ml", /[\u0D00-\u0D7F]/g],
        ["ur", /[\u0600-\u06FF]/g], ["hi", /[\u0900-\u097F]/g],
    ];
    let best = "latin";
    let most = 0;
    for (const [lang, rx] of counts) {
        const n = (text.match(rx) || []).length;
        if (n > most) [best, most] = [lang, n];
    }
    return most >= 3 ? best : "latin";
}


function jsonEnv(name: string): Record<string, string> {
    try {
        const v = JSON.parse(process.env[name] || "{}");
        return v && typeof v === "object" ? v : {};
    } catch {
        return {};
    }
}

/**
 * Voice for one reply: a per-language voice if one is set (ELEVENLABS_VOICE_IDS='{"ta":"…","bn":"…"}'), a model that
 * speaks that language, and a slightly slower pace for elders (ELEVENLABS_SPEED, 0.7–1.2).
 */
export function getTtsVoiceConfig(lang = "latin") {
    const voices = jsonEnv("ELEVENLABS_VOICE_IDS");
    const models = jsonEnv("ELEVENLABS_MODEL_IDS");
    const baseModel = process.env.ELEVENLABS_MODEL_ID?.trim() || DEFAULT_ELEVENLABS_MODEL_ID;
    return {
        voiceId: voices[lang] || process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_ELEVENLABS_VOICE_ID,
        modelId: models[lang] || baseModel,
        voiceSettings: {
            stability: envNumber("ELEVENLABS_STABILITY", 0.4),
            similarity_boost: envNumber("ELEVENLABS_SIMILARITY", 0.75),
            style: envNumber("ELEVENLABS_STYLE", 0.35),
            use_speaker_boost: process.env.ELEVENLABS_SPEAKER_BOOST?.trim() !== "false",
            speed: Math.min(1.2, Math.max(0.7, envNumber("ELEVENLABS_SPEED", 0.92))),
        },
    };
}

/** Locales Google's Chirp 3 HD voices speak. */
const GOOGLE_TTS_LOCALES = new Set(["hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN", "ta-IN", "te-IN", "en-IN"]);

/** Dialects and languages written in Devanagari that are spoken with a Devanagari locale (Marwari → Hindi voice, Konkani → Marathi). */
const DEVANAGARI_LOCALE: Record<string, string> = {
    mr: "mr-IN", marathi: "mr-IN", kok: "mr-IN", konkani: "mr-IN",
};

/**
 * The voice locale for a reply: from its script, refined by what we know of the listener's language (Devanagari can be
 * Hindi, Marathi or a dialect; Roman letters can be English or Hinglish).
 */
export function ttsLocale(text: string, languageHint?: string | null): string {
    const script = speechLanguage(text);
    const hint = String(languageHint ?? "").trim().toLowerCase();
    const hinted = languageCodeFor(hint);
    if (script === "hi") return DEVANAGARI_LOCALE[hint] || (hinted === "mr-IN" ? "mr-IN" : "hi-IN");
    if (script === "latin") {
        // Hinglish in Roman letters reads well with the Hindi voice; English (also from a Tamil or Bengali speaker)
        // with the Indian English voice.
        const hindi = hinted === "hi-IN" || baseLanguageOf(hint) === "hi" || ["hindi", "hinglish"].includes(hint);
        return hindi || looksHinglish(text) ? "hi-IN" : "en-IN";
    }
    if (script === "pa") return "pa-IN";
    return languageCodeFor(script) || "hi-IN";
}

const HINGLISH_WORDS = /\b(hai|hain|nahi|nahin|aap|aapka|aapki|kya|kaise|kab|haan|ji|dawai|dawa|goli|subah|shaam|raat|khana|le lijiye|kar|karo|kijiye|theek|accha|achha|bahut|abhi|kal|aaj)\b/gi;
function looksHinglish(text: string): boolean {
    return (text.match(HINGLISH_WORDS) || []).length >= 2;
}

type Provider = "eleven" | "gemini" | "google";
const PROVIDERS: Provider[] = ["eleven", "gemini", "google"];

/** Which engines speak, in order: TTS_ORDER_BY_LANG for this locale's language, else TTS_ORDER, else eleven,gemini,google. */
export function ttsOrder(locale?: string): Provider[] {
    const byLang = jsonEnv("TTS_ORDER_BY_LANG");
    const lang = (locale || "").split("-")[0];
    const raw = (byLang[lang] || process.env.TTS_ORDER || PROVIDERS.join(",")).split(",").map((x) => x.trim().toLowerCase());
    const out = raw.filter((x): x is Provider => (PROVIDERS as string[]).includes(x));
    return out.length ? [...new Set(out)] : PROVIDERS;
}

/** Saheli's Google voice (Chirp 3 HD name, same in every language) and pace. */
export function googleVoiceFor(locale: string) {
    const voice = process.env.TTS_GOOGLE_VOICE?.trim() || "Kore";
    return {
        name: `${locale}-Chirp3-HD-${voice}`,
        voice,
        speakingRate: Math.min(1.2, Math.max(0.75, envNumber("TTS_SPEAKING_RATE", 0.95))),
    };
}

let lastTts:
    | { at: string; provider: Provider; voiceId: string; modelId: string; locale?: string; mood?: string; ok: boolean; bytes?: number; status?: number }
    | null = null;

/** Non-secret TTS runtime snapshot (for /meta/debug). */
export function getTtsDebugSnapshot() {
    const cfg = getTtsVoiceConfig();
    return { order: ttsOrder(), google: googleVoiceFor("hi-IN"), gemini: geminiVoice(), elevenConfigured: Boolean(elevenLabsApiKey()), ...cfg, lastTts };
}

type Spoken = { audioBase64?: string; audioBuffer?: Buffer; mimeType?: string; text: string; voiceNote?: boolean };

/** At most `max` UTF-8 bytes, cut at the last sentence end (।, ., ?, !) that fits, else at a whole character. */
export function withinBytes(text: string, max: number): string {
    if (Buffer.byteLength(text, "utf8") <= max) return text;
    let out = "";
    for (const ch of text) {
        if (Buffer.byteLength(out + ch, "utf8") > max) break;
        out += ch;
    }
    const end = Math.max(...["।", ".", "?", "!"].map((c) => out.lastIndexOf(c)));
    return end > out.length / 2 ? out.slice(0, end + 1) : out;
}

async function googleTts(spoken: string, locale: string): Promise<Spoken | null> {
    if (!GOOGLE_TTS_LOCALES.has(locale)) return null;
    const token = await getAccessToken();
    if (!token) return null;
    const v = googleVoiceFor(locale);
    const started = Date.now();
    try {
        const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": gcpProjectId() },
            body: JSON.stringify({
                input: { text: withinBytes(plainSpeech(spoken), 4800) }, // the API takes at most 5000 bytes; Indic letters are 3 each
                voice: { languageCode: locale, name: v.name },
                // OGG/Opus at 48 kHz is exactly what WhatsApp plays as a voice note: no conversion needed.
                audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 48000, speakingRate: v.speakingRate },
            }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            lastTts = { at: new Date().toISOString(), provider: "google", voiceId: v.name, modelId: "chirp3-hd", locale, ok: false, status: res.status };
            console.warn(`Google TTS failed (${res.status}) voice=${v.name}: ${body.slice(0, 200)}`);
            return null;
        }
        const json = (await res.json()) as { audioContent?: string };
        if (!json.audioContent) return null;
        const note = await toVoiceNote(Buffer.from(json.audioContent, "base64"), "audio/ogg");
        lastTts = { at: new Date().toISOString(), provider: "google", voiceId: v.name, modelId: "chirp3-hd", locale, ok: true, bytes: note.buffer.length };
        console.log(`TTS: Google ok voice=${v.name} bytes=${note.buffer.length} voiceNote=${note.voice} ms=${Date.now() - started}`);
        return { text: spoken, audioBuffer: note.buffer, audioBase64: note.buffer.toString("base64"), mimeType: note.mimeType, voiceNote: note.voice };
    } catch (err) {
        console.warn("Google TTS error:", err instanceof Error ? err.message : err);
        return null;
    }
}

async function elevenTts(spoken: string, locale: string, mood: Mood = "neutral"): Promise<Spoken | null> {
    const apiKey = elevenLabsApiKey();
    if (!apiKey) return null;
    const lang = speechLanguage(spoken);
    // v3/v4 read emotion from an audio tag and pauses from ellipses (no SSML breaks).
    const tagged = `${ELEVEN_TAG[mood]} ${spoken.replace(/\[(short|medium|long) pause\]/g, (_, n) => (n === "short" ? "…" : "… …"))}`;
    const { voiceId, modelId, voiceSettings } = getTtsVoiceConfig(lang === "hi" && locale === "mr-IN" ? "mr" : lang);
    // Telling ElevenLabs the language stops it guessing (it read Bengali as Gujarati without this).
    const languageCode = locale === "en-IN" ? "en" : locale.split("-")[0];
    const started = Date.now();
    try {
        const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
            body: JSON.stringify({ text: tagged.replace(/₹\s*(\d[\d,]*)/g, "$1 rupaye").slice(0, 2500), model_id: modelId, language_code: languageCode, voice_settings: voiceSettings }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            lastTts = { at: new Date().toISOString(), provider: "eleven", voiceId, modelId, locale, ok: false, status: res.status };
            console.warn(`ElevenLabs TTS failed (${res.status}) voice=${voiceId} model=${modelId}: ${body.slice(0, 200)}`);
            return null;
        }
        // WhatsApp shows only OGG/Opus as a voice note; ElevenLabs gives mp3, so convert
        const note = await toVoiceNote(Buffer.from(await res.arrayBuffer()), "audio/mpeg");
        lastTts = { at: new Date().toISOString(), provider: "eleven", voiceId, modelId, locale, ok: true, bytes: note.buffer.length };
        console.log(`TTS: ElevenLabs ok voice=${voiceId} model=${modelId} bytes=${note.buffer.length} voiceNote=${note.voice} ms=${Date.now() - started}`);
        return { text: spoken, audioBuffer: note.buffer, audioBase64: note.buffer.toString("base64"), mimeType: note.mimeType, voiceNote: note.voice };
    } catch (err) {
        console.warn("ElevenLabs TTS error:", err instanceof Error ? err.message : err);
        return null;
    }
}

/**
 * Speak a reply. `languageHint` is the listener's language or dialect ("mr", "marwari", "hinglish"…): it picks the
 * right accent for Devanagari and Roman text. The text is first turned into what Saheli would say (prepareSpeech), then
 * spoken by the first engine that answers (ttsOrder); text only if none does.
 */
export async function textToSpeech(text: string, opts: { languageHint?: string | null } = {}): Promise<Spoken> {
    const trimmed = text.trim();
    if (!trimmed) return { text };
    const plain = speakable(trimmed);
    if (!plain) return { text: trimmed };
    const locale = ttsLocale(plain, baseLanguageOf(opts.languageHint));
    const { script, mood } = await prepareSpeech(plain, { languageHint: opts.languageHint, locale });
    const spoken = speakable(script) || plain;
    for (const provider of ttsOrder(locale)) {
        const out = provider === "eleven" ? await elevenTts(spoken, locale, mood)
            : provider === "gemini" ? await geminiTts(spoken, locale, mood, languageName(opts.languageHint, locale))
            : await googleTts(spoken, locale);
        if (out) return { ...out, text: trimmed };
    }
    if (!elevenLabsApiKey()) console.log("TTS: no voice available — text-only reply");
    return { text: trimmed };
}

export type Mood = "concerned" | "reassuring" | "cheerful" | "gentle" | "neutral";
const MOODS: Mood[] = ["concerned", "reassuring", "cheerful", "gentle", "neutral"];
const ELEVEN_TAG: Record<Mood, string> = { concerned: "[gently]", reassuring: "[warmly]", cheerful: "[cheerfully]", gentle: "[softly]", neutral: "[warmly]" };
const MOOD_STYLE: Record<Mood, string> = {
    concerned: "soft, slow and gently concerned, calm and reassuring, like comforting a worried parent",
    reassuring: "warm, calm and reassuring, unhurried, with a gentle smile in the voice",
    cheerful: "bright, warm and happy, proud of them, with a smile in the voice",
    gentle: "gentle and affectionate, relaxed and caring",
    neutral: "warm and friendly, relaxed",
};

/** Pause tags out (for engines that would read them). */
export function plainSpeech(text: string): string {
    return text.replace(/\s*\[(short|medium|long) pause\]\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

/** The listener's language for prompts: "Marwari (मारवाड़ी)", "Tamil (தமிழ்)", or from the voice locale. */
function languageName(hint: string | null | undefined, locale: string): string {
    const byLocale: Record<string, string> = { "hi-IN": "Hindi", "mr-IN": "Marathi", "ta-IN": "Tamil", "te-IN": "Telugu", "bn-IN": "Bengali (Kolkata)",
        "gu-IN": "Gujarati", "kn-IN": "Kannada", "ml-IN": "Malayalam", "pa-IN": "Punjabi", "or-IN": "Odia", "en-IN": "Indian English" };
    if (hint) {
        const label = speechLabel({ dialect: hint, language: hint } as Parameters<typeof speechLabel>[0]);
        if (label && label !== "not set") return label;
    }
    return byLocale[locale] || "Hindi";
}

/** A guess at the mood without a model: worry words → concerned. */
export function moodFromText(text: string): Mood {
    if (/घबरा|चिंता|दर्द|तकलीफ|चक्कर|डॉक्टर|अस्पताल|worr|pain|dizz|doctor|hospital|சரியில்ல|வலி|চিন্তা|ব্যথা|काळजी करू/i.test(text)) return "concerned";
    return "neutral";
}

/**
 * What Saheli would say in a voice note, not read out: short spoken sentences, at most one natural filler, pauses where a
 * person breathes, and the mood. Every number stays as written (checked); on any doubt or after 7 s, the text as is.
 */
export async function prepareSpeech(text: string, opts: { languageHint?: string | null; locale: string }): Promise<{ script: string; mood: Mood; prepared: boolean }> {
    const fallback = { script: text, mood: moodFromText(text), prepared: false };
    if (process.env.TTS_PREPARE === "off" || text.length > 1500) return fallback;
    try {
        // The engine writes it with fast models raced (2–4 s, at most 6 s); this client is Pro-only and took 5–7 s.
        const { aiEngineJson } = await import("../clients/aiEngine.client");
        const out = await aiEngineJson<{ script?: string; mood?: string; prepared?: boolean }>(
            "POST", "/v2/voice/prepare", { text, language: languageName(opts.languageHint, opts.locale) }, 7_500);
        const script = String(out?.script ?? "").trim();
        if (!out?.prepared || !script || !samePoints(text, script)) return fallback;
        return { script, mood: (MOODS as string[]).includes(String(out.mood)) ? (out.mood as Mood) : fallback.mood, prepared: true };
    } catch {
        return fallback;
    }
}

/** The spoken script keeps every number of the text and is not much longer or shorter (no invented facts). */
export function samePoints(text: string, script: string): boolean {
    const nums = (s: string) => (s.match(/\d+(?:[.:]\d+)?/g) ?? []).sort().join(",");
    const len = plainSpeech(script).length;
    return nums(asciiDigits(text)) === nums(asciiDigits(plainSpeech(script))) && len >= text.length * 0.6 && len <= text.length * 1.8 + 40;
}

function asciiDigits(s: string): string {
    return s.replace(/[\u0966-\u096F\u09E6-\u09EF\u0A66-\u0A6F\u0AE6-\u0AEF\u0B66-\u0B6F\u0BE6-\u0BEF\u0C66-\u0C6F\u0CE6-\u0CEF\u0D66-\u0D6F]/g,
        (d) => String((d.charCodeAt(0) - 6) & 0xf)); // every Indic digit block starts at …6
}

/** Locales Gemini TTS speaks (no bn-IN: it has only Bangladeshi Bengali). */
const GEMINI_TTS_LOCALES = new Set(["hi-IN", "mr-IN", "ta-IN", "te-IN", "en-IN", "gu-IN", "kn-IN", "ml-IN", "pa-IN", "or-IN"]);

export function geminiVoice() {
    return { name: process.env.TTS_GEMINI_VOICE?.trim() || "Sulafat", model: process.env.TTS_GEMINI_MODEL?.trim() || "gemini-2.5-pro-tts" };
}

async function geminiTts(spoken: string, locale: string, mood: Mood, language: string): Promise<Spoken | null> {
    if (!GEMINI_TTS_LOCALES.has(locale)) return null;
    const token = await getAccessToken();
    if (!token) return null;
    const v = geminiVoice();
    const started = Date.now();
    const prompt = `You are Saheli, a caring young Indian woman sending a WhatsApp voice note to a family member, often an elderly parent. `
        + `Speak natural ${language} with a native accent, ${MOOD_STYLE[mood]}. Talk the way people really talk, with small natural pauses `
        + `between thoughts; never sound like reading a script. Slightly slower than usual, every word clear.`;
    try {
        const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": gcpProjectId() },
            body: JSON.stringify({
                input: { text: withinBytes(spoken, 3600), prompt },
                voice: { languageCode: locale, name: v.name, modelName: v.model },
                audioConfig: { audioEncoding: "OGG_OPUS", sampleRateHertz: 48000 },
            }),
            signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            lastTts = { at: new Date().toISOString(), provider: "gemini", voiceId: v.name, modelId: v.model, locale, mood, ok: false, status: res.status };
            console.warn(`Gemini TTS failed (${res.status}) voice=${v.name}: ${body.slice(0, 200)}`);
            return null;
        }
        const json = (await res.json()) as { audioContent?: string };
        if (!json.audioContent) return null;
        const note = await toVoiceNote(Buffer.from(json.audioContent, "base64"), "audio/ogg");
        lastTts = { at: new Date().toISOString(), provider: "gemini", voiceId: v.name, modelId: v.model, locale, mood, ok: true, bytes: note.buffer.length };
        console.log(`TTS: Gemini ok voice=${v.name} mood=${mood} bytes=${note.buffer.length} ms=${Date.now() - started}`);
        return { text: spoken, audioBuffer: note.buffer, audioBase64: note.buffer.toString("base64"), mimeType: note.mimeType, voiceNote: note.voice };
    } catch (err) {
        console.warn("Gemini TTS error:", err instanceof Error ? err.message : err);
        return null;
    }
}

/** A dialect's base language for the voice (Marwari → hi, Tulu → kn), or the hint itself. */
export function baseLanguageOf(hint?: string | null): string | null {
    const h = String(hint ?? "").trim().toLowerCase();
    if (!h) return null;
    return dialectBase(h) ?? h;
}

/** An OGG file with an Opus stream: the only audio WhatsApp shows as a voice note (waveform, play button). */
export function isOggOpus(buf: Buffer | undefined): boolean {
    if (!buf || buf.length < 36) return false;
    return buf.subarray(0, 4).toString("latin1") === "OggS" && buf.subarray(0, 128).toString("latin1").includes("OpusHead");
}

/** mp3 (or anything ffmpeg reads) → mono 48 kHz Opus in OGG, the voice-note format. Rejects if ffmpeg is missing or fails. */
export function convertToOpus(input: Buffer, timeoutMs = 20_000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const ff = spawn(process.env.FFMPEG_PATH?.trim() || "ffmpeg",
            ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1", "-ar", "48000", "-c:a", "libopus",
             "-b:a", "32k", "-application", "voip", "-f", "ogg", "pipe:1"],
            { stdio: ["pipe", "pipe", "pipe"] });
        const out: Buffer[] = [];
        let err = "";
        const timer = setTimeout(() => {
            ff.kill("SIGKILL");
            reject(new Error("ffmpeg timed out"));
        }, timeoutMs);
        ff.stdout.on("data", (d: Buffer) => out.push(d));
        ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
        ff.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        ff.on("close", (code) => {
            clearTimeout(timer);
            const buf = Buffer.concat(out);
            if (code === 0 && isOggOpus(buf)) resolve(buf);
            else reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 200)}`));
        });
        ff.stdin.on("error", () => undefined); // ffmpeg may close stdin early on bad input; "close" reports it
        ff.stdin.end(input);
    });
}

/**
 * Make audio a WhatsApp voice note. Already OGG/Opus → as is; otherwise convert. If conversion is not possible the
 * original goes out as an audio file (voice: false), never nothing.
 */
export async function toVoiceNote(buf: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string; voice: boolean }> {
    if (isOggOpus(buf)) return { buffer: buf, mimeType: "audio/ogg", voice: true };
    try {
        return { buffer: await convertToOpus(buf), mimeType: "audio/ogg", voice: true };
    } catch (err) {
        console.warn("Voice note conversion failed, sending an audio file instead:", err instanceof Error ? err.message : err);
        return { buffer: buf, mimeType, voice: false };
    }
}

export function isElevenLabsConfigured(): boolean {
    return Boolean(elevenLabsApiKey());
}
