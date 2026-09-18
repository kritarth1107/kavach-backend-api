import { GoogleAuth } from "google-auth-library";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

type AiChatResponse = {
    reply: string;
    conversation_id: string;
    order?: Record<string, unknown>;
    connect?: Record<string, unknown>;
    tool_trace?: Array<{ tool: string; status: string }>;
};

export type AiStreamEvent =
    | { type: "token"; delta: string }
    | { type: "tool_start"; id: string; name: string; label?: string }
    | {
          type: "tool_result";
          id: string;
          order?: Record<string, unknown>;
          connect?: Record<string, unknown>;
      }
    | { type: "done"; conversation_id: string; reply?: string; order?: Record<string, unknown>; connect?: Record<string, unknown> }
    | { type: "error"; message: string };

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAiEngineOfflineError(err: unknown): boolean {
    return err instanceof AppError && (err.statusCode === 503 || err.statusCode === 502);
}

type AiHistoryResponse = {
    conversation_id: string;
    messages: Array<{ role: string; content: string; created_at?: string | null }>;
};

type AiFamilyResponse = {
    family: { id: string; name: string };
};

type AiElderResponse = {
    elder: { id: string; display_name: string; slug: string };
};

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
    if (!audience.includes(".run.app")) return headers;
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

function* chunkText(text: string, size = 24): Generator<string> {
    for (let i = 0; i < text.length; i += size) {
        yield text.slice(i, i + size);
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

export async function aiCreateFamily(payload: {
    name: string;
    ownerExternalId: string;
    ownerEmail?: string;
    ownerName?: string;
}): Promise<string> {
    const res = await aiFetch(
        "/v1/families",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                name: payload.name,
                owner_external_id: payload.ownerExternalId,
                owner_email: payload.ownerEmail,
                owner_name: payload.ownerName,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to provision AI family", res.status);
    }

    const json = await parseAiJson<AiFamilyResponse>(res);
    return json.family.id;
}

export async function aiCreateElder(payload: {
    aiFamilyId: string;
    displayName: string;
    slug: string;
}): Promise<{ elderId: string }> {
    const res = await aiFetch(
        `/v1/families/${payload.aiFamilyId}/elders`,
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                display_name: payload.displayName,
                slug: payload.slug,
                preferred_language: "hinglish",
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to provision AI elder", res.status);
    }

    const json = await parseAiJson<AiElderResponse>(res);
    return { elderId: json.elder.id };
}

export async function aiSyncConversationHistory(payload: {
    aiFamilyId: string;
    aiElderId: string;
    conversationId?: string;
    thread: "elder" | "caregiver";
    messages: Array<{
        external_id: string;
        role: string;
        content: string;
        created_at?: string | null;
    }>;
}): Promise<{ conversation_id: string; synced: number }> {
    const res = await aiFetch(
        "/v1/chat/sync-history",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId,
                conversation_id: payload.conversationId ?? null,
                thread: payload.thread,
                messages: payload.messages,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        console.warn("AI history sync failed:", body);
        return { conversation_id: payload.conversationId ?? "", synced: 0 };
    }

    return parseAiJson<{ conversation_id: string; synced: number }>(res);
}

export async function aiPostChat(payload: {
    aiFamilyId: string;
    aiElderId: string;
    message: string;
    conversationId?: string;
    careRecordContext?: string;
    companionProfile?: Record<string, unknown>;
    orderContext?: string;
}): Promise<AiChatResponse> {
    const res = await aiFetch(
        "/v1/chat",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId,
                message: payload.message,
                conversation_id: payload.conversationId ?? null,
                care_record_context: payload.careRecordContext ?? null,
                companion_profile: payload.companionProfile ?? null,
                order_context: payload.orderContext ?? null,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Saheli chat failed", res.status);
    }

    return parseAiJson<AiChatResponse>(res);
}

export async function aiPostCaregiverChat(payload: {
    aiFamilyId: string;
    aiElderId: string;
    message: string;
    conversationId?: string;
    careRecordContext?: string;
    elderThreadContext?: string;
    labsContext?: string;
    sessionContext?: string;
    orderContext?: string;
    useAgent?: boolean;
    actorUserId?: string;
}): Promise<AiChatResponse> {
    const res = await aiFetch(
        "/v1/chat/caregiver",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId,
                message: payload.message,
                conversation_id: payload.conversationId ?? null,
                care_record_context: payload.careRecordContext ?? null,
                elder_thread_context: payload.elderThreadContext ?? null,
                labs_context: payload.labsContext ?? null,
                session_context: payload.sessionContext ?? null,
                order_context: payload.orderContext ?? null,
                use_agent: payload.useAgent ?? true,
                actor_user_id: payload.actorUserId ?? null,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Caregiver Saheli chat failed", res.status);
    }

    return parseAiJson<AiChatResponse>(res);
}

export async function aiPostCaregiverChatWithRetry(
    payload: Parameters<typeof aiPostCaregiverChat>[0],
    retries = 3,
): Promise<AiChatResponse> {
    const delays = [500, 1000, 2000];
    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            return await aiPostCaregiverChat(payload);
        } catch (err) {
            lastErr = err;
            if (attempt < retries - 1 && isAiEngineOfflineError(err)) {
                await sleep(delays[attempt] ?? 2000);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

export async function* streamCaregiverSaheliChat(payload: {
    aiFamilyId: string;
    aiElderId: string;
    message: string;
    conversationId?: string;
    careRecordContext?: string;
    elderThreadContext?: string;
    labsContext?: string;
    sessionContext?: string;
    orderContext?: string;
    actorUserId?: string;
}): AsyncGenerator<AiStreamEvent> {
    const base = aiEngineAudience();
    const body = JSON.stringify({
        family_id: payload.aiFamilyId,
        elder_id: payload.aiElderId,
        message: payload.message,
        conversation_id: payload.conversationId ?? null,
        care_record_context: payload.careRecordContext ?? null,
        elder_thread_context: payload.elderThreadContext ?? null,
        labs_context: payload.labsContext ?? null,
        session_context: payload.sessionContext ?? null,
        order_context: payload.orderContext ?? null,
        use_agent: true,
        actor_user_id: payload.actorUserId ?? null,
    });
    const headers = await aiRequestHeaders();
    const res = await fetch(`${base}/v1/chat/caregiver/stream`, {
        method: "POST",
        headers,
        body,
    });

    if (!res.ok || !res.body) {
        if (res.status === 401 || res.status === 403) {
            const result = await aiPostCaregiverChatWithRetry({
                aiFamilyId: payload.aiFamilyId,
                aiElderId: payload.aiElderId,
                message: payload.message,
                conversationId: payload.conversationId,
                careRecordContext: payload.careRecordContext,
                elderThreadContext: payload.elderThreadContext,
                labsContext: payload.labsContext,
                sessionContext: payload.sessionContext,
                orderContext: payload.orderContext,
                useAgent: true,
                actorUserId: payload.actorUserId,
            });
            const reply = result.reply.trim();
            for (const delta of chunkText(reply)) {
                yield { type: "token", delta };
            }
            if (result.order) {
                yield { type: "tool_result", id: "order", order: result.order };
            }
            if (result.connect) {
                yield { type: "tool_result", id: "connect", connect: result.connect };
            }
            yield {
                type: "done",
                conversation_id: result.conversation_id,
                reply,
                order: result.order,
                connect: result.connect,
            };
            return;
        }
        const errBody = await res.text();
        yield {
            type: "error",
            message: errBody.includes("<html")
                ? "Saheli is reconnecting — try again in a moment."
                : errBody || "Stream failed",
        };
        return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json || json === "[DONE]") continue;
            try {
                yield JSON.parse(json) as AiStreamEvent;
            } catch {
                // skip malformed chunk
            }
        }
    }
}

export async function aiGetCaregiverChatHistory(payload: {
    aiFamilyId: string;
    aiElderId: string;
    limit?: number;
}): Promise<AiHistoryResponse> {
    const params = new URLSearchParams({
        family_id: payload.aiFamilyId,
        elder_id: payload.aiElderId,
        limit: String(payload.limit ?? 50),
    });

    const res = await aiFetch(`/v1/chat/caregiver/history?${params.toString()}`, {
        method: "GET",
        headers: aiHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to load caregiver Saheli history", res.status);
    }

    return parseAiJson<AiHistoryResponse>(res);
}

export async function aiGetChatHistory(payload: {
    aiFamilyId: string;
    aiElderId: string;
    limit?: number;
}): Promise<AiHistoryResponse> {
    const params = new URLSearchParams({
        family_id: payload.aiFamilyId,
        elder_id: payload.aiElderId,
        limit: String(payload.limit ?? 50),
    });

    const res = await aiFetch(`/v1/chat/history?${params.toString()}`, {
        method: "GET",
        headers: aiHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to load Saheli history", res.status);
    }

    return parseAiJson<AiHistoryResponse>(res);
}

export async function aiPostCheckIn(payload: {
    aiFamilyId: string;
    aiElderId: string;
    conversationId?: string;
    careRecordContext?: string;
    companionProfile?: Record<string, unknown>;
    scheduleItems?: Array<{
        title: string;
        time?: string;
        dosage?: string;
        type?: string;
    }>;
}): Promise<AiChatResponse> {
    const res = await aiFetch(
        "/v1/chat/check-in",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId,
                conversation_id: payload.conversationId ?? null,
                schedule_items: payload.scheduleItems ?? [],
                care_record_context: payload.careRecordContext ?? null,
                companion_profile: payload.companionProfile ?? null,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Saheli check-in failed", res.status);
    }

    return parseAiJson<AiChatResponse>(res);
}

export async function aiAnalyzeDocument(payload: {
    title: string;
    rawText: string;
    fileName?: string;
}): Promise<{
    title: string;
    kind: string;
    tags: string[];
    summary: string;
    record_date: string | null;
    highlights: string[];
}> {
    const res = await aiFetch(
        "/v1/documents/analyze",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                title: payload.title,
                raw_text: payload.rawText,
                file_name: payload.fileName ?? null,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Document analysis failed", res.status);
    }

    return parseAiJson(res);
}

export async function aiIngestDocument(payload: {
    aiFamilyId: string;
    aiElderId?: string;
    title: string;
    rawText: string;
    kind?: string;
    recordDate?: string;
    summary?: string;
    highlights?: { tags?: string[]; items?: string[] };
}): Promise<{ document_id: string; title: string; kind: string }> {
    const res = await aiFetch(
        "/v1/documents/ingest",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId ?? null,
                title: payload.title,
                raw_text: payload.rawText,
                kind: payload.kind ?? "lab",
                source: "upload",
                record_date: payload.recordDate ?? null,
                summary: payload.summary ?? null,
                highlights: payload.highlights ?? null,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to ingest document", res.status);
    }

    return parseAiJson(res);
}

export async function aiListDocuments(payload: {
    aiFamilyId: string;
    aiElderId?: string;
}): Promise<{
    documents: Array<{
        document_id: string;
        title: string;
        kind: string;
        record_date: string | null;
        created_at: string | null;
    }>;
}> {
    const params = new URLSearchParams({ family_id: payload.aiFamilyId });
    if (payload.aiElderId) params.set("elder_id", payload.aiElderId);

    const res = await aiFetch(`/v1/documents/list?${params.toString()}`, {
        method: "GET",
        headers: aiHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to list documents", res.status);
    }

    return parseAiJson(res);
}

export async function aiPostCareBrief(payload: {
    subjectName: string;
    timeline: string;
}): Promise<{ brief: string }> {
    const res = await aiFetch(
        "/v1/care-brief/generate",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                subject_name: payload.subjectName,
                timeline: payload.timeline,
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Care Brief generation failed", res.status);
    }

    return parseAiJson<{ brief: string }>(res);
}

type AiOutreachResponse = AiChatResponse & {
    topic_bucket: string;
    topic_hint: string;
    outreach_kind: string;
};

export async function aiPostOutreach(payload: {
    aiFamilyId: string;
    aiElderId: string;
    conversationId?: string;
    outreachKind?: string;
    topicBucket?: string;
    topicHint?: string;
    careRecordContext?: string;
    companionProfile?: Record<string, unknown>;
    scheduleItems?: Array<{
        title: string;
        time?: string;
        dosage?: string;
        type?: string;
    }>;
}): Promise<AiOutreachResponse> {
    const res = await aiFetch(
        "/v1/chat/outreach",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId,
                conversation_id: payload.conversationId ?? null,
                outreach_kind: payload.outreachKind ?? "casual",
                topic_bucket: payload.topicBucket ?? null,
                topic_hint: payload.topicHint ?? null,
                care_record_context: payload.careRecordContext ?? null,
                companion_profile: payload.companionProfile ?? null,
                schedule_items: payload.scheduleItems ?? [],
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Saheli outreach failed", res.status);
    }

    return parseAiJson<AiOutreachResponse>(res);
}

export async function aiPostFamilyShare(payload: {
    aiFamilyId: string;
    aiElderId: string;
    shareSummary: string;
    memoryIds?: string[];
}): Promise<AiChatResponse> {
    const res = await aiFetch(
        "/v1/chat/family-share",
        {
            method: "POST",
            headers: aiHeaders(),
            body: JSON.stringify({
                family_id: payload.aiFamilyId,
                elder_id: payload.aiElderId,
                share_summary: payload.shareSummary,
                memory_ids: payload.memoryIds ?? [],
            }),
        },
        config.aiEngine.writeTimeoutMs,
    );

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Family share failed", res.status);
    }

    return parseAiJson<AiChatResponse>(res);
}

export async function aiListFamilyMemories(payload: {
    aiFamilyId: string;
    aiElderId: string;
    limit?: number;
    shareableOnly?: boolean;
}): Promise<{
    memories: Array<{
        id: string;
        category: string;
        topic: string;
        content: string;
        share_with_family: boolean;
        importance: number;
        created_at: string | null;
    }>;
}> {
    const params = new URLSearchParams({
        family_id: payload.aiFamilyId,
        elder_id: payload.aiElderId,
        limit: String(payload.limit ?? 50),
        shareable_only: payload.shareableOnly ? "true" : "false",
    });

    const res = await aiFetch(`/v1/memory/list?${params.toString()}`, {
        method: "GET",
        headers: aiHeaders(),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new AppError(body || "Failed to list family memories", res.status);
    }

    return parseAiJson(res);
}
