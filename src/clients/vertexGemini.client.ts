/**
 * Minimal Vertex AI Gemini text client (ADC via google-auth-library — Cloud Run SA).
 * Used by the order-interrupt classifier, health red-flag classifier and daily snapshot.
 * Never throws: returns null on any failure / timeout so callers fall back to rules.
 */
import { GoogleAuth } from "google-auth-library";

let auth: GoogleAuth | null = null;

function projectId(): string {
    return (
        process.env.GCP_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "kavach-care"
    );
}

/** Pro-class Gemini 3.x serves from global; Flash works regionally (matches ai-engine). */
export function vertexLocationForModel(model: string): string {
    const m = model.toLowerCase();
    if (m.includes("-pro")) return process.env.VERTEX_LOCATION?.trim() || "global";
    return process.env.GCP_REGION?.trim() || "asia-south1";
}

export function vertexFlashModel(): string {
    return process.env.VERTEX_CLASSIFIER_MODEL?.trim() || process.env.VERTEX_BROWSER_MODEL?.trim() || "gemini-3.5-flash";
}

export function vertexProModel(): string {
    return process.env.VERTEX_SNAPSHOT_MODEL?.trim() || "gemini-3.5-pro";
}

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
}): Promise<string | null> {
    if (process.env.NODE_ENV === "test" || process.env.VERTEX_DISABLED === "1") return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 8000);
    try {
        auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const client = await auth.getClient();
        const token = (await client.getAccessToken()).token;
        if (!token) return null;
        const location = vertexLocationForModel(input.model);
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
                },
            }),
        });
        if (!res.ok) {
            console.warn(`vertex ${input.model} HTTP ${res.status}`);
            return null;
        }
        const body = (await res.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
        };
        const text = (body.candidates?.[0]?.content?.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => p.text ?? "")
            .join("")
            .trim();
        return text || null;
    } catch (err) {
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
