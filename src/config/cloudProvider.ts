/**
 * Which cloud this copy of the backend talks to (founder decision 14 Oct 2026: the AWS copy is fully Google-free).
 *
 *   LLM_PROVIDER_BACKEND=vertex|bedrock  (default vertex)  every vertexGenerateText call and photo reading
 *   GOOGLE_SERVICES=on|off               (default: off when the LLM backend is bedrock, else on)  Vertex, Speech, TTS,
 *                                         Cloud Monitoring, Cloud Run / Scheduler / Cloud SQL admin reads
 *   VOICE_GOOGLE=on|off                  (default: follows GOOGLE_SERVICES)  Chirp / Gemini STT, Google / Gemini TTS
 *
 * With nothing set the behaviour is exactly the GCP production one.
 */
export type LlmBackend = "vertex" | "bedrock";

const OFF = new Set(["off", "0", "false", "no"]);
const ON = new Set(["on", "1", "true", "yes"]);

function flag(raw: string | undefined): boolean | null {
    const v = (raw || "").trim().toLowerCase();
    if (OFF.has(v)) return false;
    if (ON.has(v)) return true;
    return null;
}

export function llmBackend(env: NodeJS.ProcessEnv = process.env): LlmBackend {
    return (env.LLM_PROVIDER_BACKEND || "").trim().toLowerCase() === "bedrock" ? "bedrock" : "vertex";
}

/** Google Cloud APIs may be called. Off on the AWS copy: callers skip instead of asking for Google credentials. */
export function googleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return flag(env.GOOGLE_SERVICES) ?? llmBackend(env) !== "bedrock";
}

/** Google speech engines (Chirp STT, Gemini audio STT, Google and Gemini TTS) may be called. */
export function voiceGoogleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return flag(env.VOICE_GOOGLE) ?? googleEnabled(env);
}

/** The value admin pages and the live check show instead of a Google reading when Google is off. */
export const NOT_ON_GCP = "not on GCP (Google services off on this copy)";
