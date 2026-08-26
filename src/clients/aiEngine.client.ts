import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

type AiChatResponse = {
    reply: string;
    conversation_id: string;
};

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
        const request = fetch(`${base}${path}`, {
            ...init,
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

export async function aiPostChat(payload: {
    aiFamilyId: string;
    aiElderId: string;
    message: string;
    conversationId?: string;
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
