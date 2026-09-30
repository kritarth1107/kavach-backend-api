/**
 * Minimal Vertex AI Gemini text client (ADC via google-auth-library — Cloud Run SA).
 * Used by the order-interrupt classifier, health red-flag classifier and daily snapshot.
 * Never throws: returns null on any failure / timeout so callers fall back to rules.
 */
import { execFile } from "node:child_process";
import { GoogleAuth } from "google-auth-library";

let auth: GoogleAuth | null = null;

/** ADC refresh on this machine returns invalid_grant. The gcloud user login still works. */
function gcloudAccessToken(): Promise<string | null> {
    return new Promise((resolve) => {
        execFile("gcloud", ["auth", "print-access-token"], { timeout: 15000 }, (err, stdout) => {
            if (err) return resolve(null);
            const token = String(stdout || "").trim();
            resolve(token || null);
        });
    });
}

async function accessToken(): Promise<string | null> {
    try {
        auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const client = await auth.getClient();
        const token = (await client.getAccessToken()).token;
        if (token) return token;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastVertexError = `auth ${msg.replace(/\s+/g, " ").slice(0, 180)}`;
        auth = null;
    }
    return gcloudAccessToken();
}

function projectId(): string {
    return (
        process.env.GCP_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "kavach-care"
    );
}

/** Gemini 3.1 Pro is global-only. A regional location returns 404. */
export const GEMINI_PRO_MODEL = "gemini-3.1-pro-preview";

/** Flash and Gemini 2.5 are refused. An empty or forbidden name becomes 3.1 Pro. */
export function preferPro(raw?: string | null): string {
    const m = (raw || "").trim();
    if (!m || /flash|2\.5/i.test(m)) return GEMINI_PRO_MODEL;
    return m;
}

/** Pro-class Gemini 3.x serves from global only. */
export function vertexLocationForModel(model: string): string {
    const m = model.toLowerCase();
    if (m.includes("-pro")) return "global";
    const extra = (process.env.VERTEX_GLOBAL_MODELS || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (/gemini-3\.6|-lite|-latest|-preview/.test(m) || extra.includes(m)) return "global";
    return process.env.GCP_REGION?.trim() || "asia-south1";
}

export function vertexProModel(): string {
    return preferPro(process.env.VERTEX_SNAPSHOT_MODEL);
}

/** Kept so older call sites compile. It is 3.1 Pro, not Flash. */
export function vertexFlashModel(): string {
    return vertexProModel();
}

/** A full reply stays on Pro. A 429 retry must not drop to Flash or a 2.5 model. */
function nextCapacityRoute(model: string, _location: string, _attempt: number): { model: string; location: string } {
    const pro = vertexProModel();
    const stay = /pro/i.test(model) && !/2\.5|flash/i.test(model) ? model : pro;
    return { model: stay, location: "global" };
}

/** Last Vertex failure (status + short body) for secret-gated debug. */
export let lastVertexError = "";
export function resetVertexError(): void {
    lastVertexError = "";
}
const thinkingRejected = new Set<string>();

export async function vertexGenerateText(input: {
    model: string;
    prompt: string;
    system?: string;
    json?: boolean;
    /** OpenAPI-subset schema for structured output (implies json). */
    responseSchema?: Record<string, unknown>;
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    /** Gemini 3 thinking level ("minimal" | "low" | …) — lower = faster; dropped automatically if the model rejects it. */
    thinkingLevel?: string;
    /** Internal: location override for the capacity retry. */
    location?: string;
    /** Internal: retry depth. */
    attempt?: number;
}): Promise<string | null> {
    if (process.env.NODE_ENV === "test" || process.env.VERTEX_DISABLED === "1") return null;
    const forced = preferPro(input.model);
    if (forced !== input.model) return vertexGenerateText({ ...input, model: forced });
    const started = Date.now();
    const budget = input.timeoutMs ?? 8000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 8000);
    try {
        const token = await accessToken();
        if (!token) return null;
        const location = input.location || vertexLocationForModel(input.model);
        const host =
            location === "global"
                ? "https://aiplatform.googleapis.com"
                : `https://${location}-aiplatform.googleapis.com`;
        const url = `${host}/v1/projects/${projectId()}/locations/${location}/publishers/google/models/${input.model}:generateContent`;
        const res = await fetch(url, {
            method: "POST",
            signal: ctrl.signal,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({
                ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
                contents: [{ role: "user", parts: [{ text: input.prompt }] }],
                generationConfig: {
                    temperature: input.temperature ?? 0.1,
                    maxOutputTokens: input.maxOutputTokens ?? 512,
                    ...(input.json || input.responseSchema ? { responseMimeType: "application/json" } : {}),
                    ...(input.responseSchema ? { responseSchema: input.responseSchema } : {}),
                    ...(input.thinkingLevel && !thinkingRejected.has(input.model)
                        ? { thinkingConfig: { thinkingLevel: input.thinkingLevel } }
                        : {}),
                },
            }),
        });
        if (!res.ok) {
            const errBody = await res.text().catch(() => "");
            lastVertexError = `HTTP ${res.status} ${errBody.replace(/\s+/g, " ").slice(0, 200)}`;
            if (res.status === 400 && input.thinkingLevel && /thinking/i.test(errBody) && !thinkingRejected.has(input.model)) {
                thinkingRejected.add(input.model);
                clearTimeout(timer);
                return vertexGenerateText({ ...input, thinkingLevel: undefined });
            }
            console.warn(`vertex ${input.model}@${location} ${lastVertexError}`);
            // 429 / 500 / 503: one retry, still on 3.1 Pro at global, after a jittered pause.
            // A short fixed pause makes every waiter hit the pool again together.
            if ([429, 500, 503].includes(res.status) && (input.attempt ?? 0) < 2) {
                const left = budget - (Date.now() - started);
                const wait = 1000 + Math.floor(Math.random() * 3000);
                if (left > wait + 1500) {
                    clearTimeout(timer);
                    await new Promise((r) => setTimeout(r, wait));
                    const retry = nextCapacityRoute(input.model, location, input.attempt ?? 0);
                    return vertexGenerateText({ ...input, model: retry.model, location: retry.location, timeoutMs: left - wait, attempt: (input.attempt ?? 0) + 1 });
                }
            }
            return null;
        }
        const body = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
        };
        const finish = body.candidates?.[0]?.finishReason;
        if (finish && finish !== "STOP") lastVertexError = `finish ${finish}`;
        const text = (body.candidates?.[0]?.content?.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => p.text ?? "")
            .join("")
            .trim();
        return text || null;
    } catch (err) {
        lastVertexError = `failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
        console.warn(`vertex ${input.model} failed:`, err instanceof Error ? err.message : err);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function parseJsonLoose<T>(text: string | null): T | null {
    if (!text) return null;
    try {
        return JSON.parse(text) as T;
    } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try {
            return JSON.parse(m[0]) as T;
        } catch {
            return null;
        }
    }
}
