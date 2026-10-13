import { GoogleAuth } from "google-auth-library";
import { googleEnabled } from "../config/cloudProvider";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

export function isAiEngineOfflineError(err: unknown): boolean {
    return err instanceof AppError && (err.statusCode === 503 || err.statusCode === 502);
}

function aiHeaders(): Record<string, string> {
    return {
        "Content-Type": "application/json",
        "X-Kavach-Secret": config.aiEngine.apiSecret,
    };
}

function aiEngineAudience(): string {
    return config.aiEngine.baseUrl.replace(/\/$/, "");
}

async function aiRequestHeaders(): Promise<Record<string, string>> {
    const headers = aiHeaders();
    const audience = aiEngineAudience();
    if (!audience.includes(".run.app") || !googleEnabled()) return headers;
    try {
        const auth = new GoogleAuth();
        const client = await auth.getIdTokenClient(audience);
        const authHeaders = await client.getRequestHeaders(audience);
        const merged = { ...headers };
        authHeaders.forEach((value, key) => {
            merged[key] = value;
        });
        return merged;
    } catch (err) {
        console.warn("AI engine Cloud Run identity token unavailable:", err);
        return headers;
    }
}

async function parseAiJson<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!text.trim()) {
        throw new AppError("AI engine returned an empty response", 502);
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new AppError("AI engine returned invalid JSON", 502);
    }
}

async function aiFetch(
    path: string,
    init?: RequestInit,
    timeoutMs = config.aiEngine.timeoutMs,
): Promise<Response> {
    const base = config.aiEngine.baseUrl.replace(/\/$/, "");
    const timedOut = new AppError("Saheli timed out. Memory is offline right now.", 503);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const controller = new AbortController();
    try {
        const headers = await aiRequestHeaders();
        const request = fetch(`${base}${path}`, {
            ...init,
            headers: {
                ...headers,
                ...(init?.headers as Record<string, string> | undefined),
            },
            signal: controller.signal,
        });
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(timedOut);
            }, timeoutMs);
        });
        return await Promise.race([request, timeout]);
    } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
            throw timedOut;
        }
        throw new AppError(
            "Cannot reach the AI engine. Start kawach-ai-engine on port 8000.",
            503,
        );
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Is the engine answering? For the uptime alarm: the engine is private, so outside checks go through the backend. */
export async function aiEngineHealth(timeoutMs = 8_000): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
    const started = Date.now();
    try {
        const res = await aiFetch("/health", { method: "GET" }, timeoutMs);
        const body = await res.text();
        return { ok: res.ok && body.includes('"ok"'), status: res.status, ms: Date.now() - started };
    } catch (err) {
        return { ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 120) : "failed" };
    }
}

/**
 * Feed Saheli's care ledger (ai-engine) with what happened outside a conversation, such as a
 * reminder the scheduler sent. Best effort: a failure is logged and never blocks the caller.
 */
export async function aiPushCareEvent(payload: {
    family_id: string;
    subject_id: string;
    kind: string;
    summary: string;
    payload?: Record<string, unknown>;
    ref?: string;
    at?: string;
}): Promise<void> {
    try {
        const res = await aiFetch(
            "/v2/events",
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
            5000,
        );
        if (!res.ok) console.warn(`care event push ${payload.kind} → HTTP ${res.status}`);
    } catch (err) {
        console.warn(`care event push ${payload.kind} failed:`, err instanceof Error ? err.message : err);
    }
}

/** JSON call to the ai-engine; an engine 4xx becomes an AppError with its detail. */
export async function aiEngineJson<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await aiFetch(
        path,
        { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
        timeoutMs,
    );
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
        throw new AppError("AI engine returned invalid JSON", 502);
    }
    if (!res.ok) {
        const detail = typeof json.detail === "string" ? json.detail : `AI engine HTTP ${res.status}`;
        throw new AppError(detail, res.status >= 500 ? 502 : res.status);
    }
    return json as T;
}

export async function aiPostBrainTurn(payload: {
    family_id: string;
    elder: { id: string; name: string; role: string; relation?: string; relation_to?: string };
    speaker: { id: string; name: string; role: string; relation?: string; relation_to?: string };
    members: Array<{ id: string; name: string; role: string; relation?: string; relation_to?: string }>;
    text: string;
    message_ref?: string;
    channel: string;
    mode: "live" | "shadow";
    modality?: "text" | "voice";
    voice_confidence?: number | null;
    voice_language?: string | null;
    images?: Array<{ mime: string; data: string }>;
    media_note?: string;
    reminders_soon?: Array<{ id: string; person: string; text: string; day: string; time: string; repeat: string; item: string | null }>;
    location?: { lat: number; lng: number; name: string; address: string };
    /** Messages that waited while their WhatsApp chat was closed (they got a template instead). */
    /** delivered: the backend already gave it word for word on this message (trust plan B3.4); Saheli must not repeat it. */
    waiting?: Array<{ purpose: string; text: string; at: string; delivered?: boolean }>;
}): Promise<{ reply: string; actions: unknown[]; alerts: unknown[]; model: string; shadow_writes?: Array<{ tool: string }>;
    buttons?: Array<{ id: string; title: string }>; location_request?: boolean; duplicate?: boolean }> {
    const res = await aiFetch(
        "/v2/turn",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
        120_000,
    );
    if (!res.ok) throw new AppError(`Brain v2 HTTP ${res.status}`, 502);
    return parseAiJson(res);
}

export async function aiPostDoctorBrief(payload: {
    subjectName: string;
    timeline: string;
    staleHealth?: string;
    memoryProfile?: string;
    /** Kavach ids: the engine then adds the current care record with each medicine's links (D-13). */
    familyId?: string;
    subjectUserId?: string;
}): Promise<{ brief: string; audience?: string }> {
    const res = await aiFetch(
        "/v1/doctor-brief/generate",
        {
            method: "POST",
            body: JSON.stringify({
                subject_name: payload.subjectName,
                timeline: payload.timeline,
                stale_health: payload.staleHealth ?? "",
                memory_profile: payload.memoryProfile ?? "",
                ...(payload.familyId && payload.subjectUserId ? { family_id: payload.familyId, subject_id: payload.subjectUserId } : {}),
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Doctor Brief generation failed", res.status);
    }

    return parseAiJson<{ brief: string; audience?: string }>(res);
}

