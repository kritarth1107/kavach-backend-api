import SaheliMessage from "../models/saheliMessage.model";
import type { SaheliThreadKind } from "../models/saheliMessage.model";
import { aiSyncConversationHistory } from "../clients/aiEngine.client";
import { ensureAiContext } from "./aiTenant.service";

function mapRole(thread: SaheliThreadKind, role: string): "elder" | "saheli" | "family" | "system" {
    if (role === "saheli") return "saheli";
    if (role === "system") return "system";
    if (thread === "caregiver" && role === "family") return "family";
    return "elder";
}

/** Newest-N then chronological order for AI history sync. */
async function loadNewestMessages(
    query: Record<string, unknown>,
    limit: number,
) {
    const rows = await SaheliMessage.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    rows.reverse();
    return rows;
}

export async function syncSessionHistoryToAiEngine(input: {
    familyId: string;
    recipientUserId: string;
    displayName: string;
    sessionId: string;
    thread: SaheliThreadKind;
    conversationId?: string;
    limit?: number;
}) {
    const ctx = await ensureAiContext(input.familyId, input.recipientUserId, input.displayName);
    const rows = await loadNewestMessages(
        {
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            thread: input.thread,
            sessionId: input.sessionId,
        },
        input.limit ?? 50,
    );

    if (!rows.length) return ctx;

    await aiSyncConversationHistory({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        conversationId: input.conversationId,
        thread: input.thread,
        messages: rows.map((row) => ({
            external_id: row.messageId,
            role: mapRole(input.thread, row.role),
            content: row.content,
            created_at: row.createdAt?.toISOString?.() ?? null,
        })),
    });

    return ctx;
}

export async function refreshRecipientMemoryToAiEngine(input: {
    familyId: string;
    recipientUserId: string;
    displayName: string;
    sessionId?: string;
}) {
    const ctx = await ensureAiContext(input.familyId, input.recipientUserId, input.displayName);
    const threads: SaheliThreadKind[] = ["elder", "caregiver"];
    for (const thread of threads) {
        const query: Record<string, unknown> = {
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            thread,
        };
        if (input.sessionId) query.sessionId = input.sessionId;
        const rows = await loadNewestMessages(query, 50);
        if (!rows.length) continue;
        await aiSyncConversationHistory({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            thread,
            messages: rows.map((row) => ({
                external_id: row.messageId,
                role: mapRole(thread, row.role),
                content: row.content,
                created_at: row.createdAt?.toISOString?.() ?? null,
            })),
        });
    }
    return ctx;
}
