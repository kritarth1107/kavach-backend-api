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
    const rows = await SaheliMessage.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        thread: input.thread,
        sessionId: input.sessionId,
    })
        .sort({ createdAt: 1 })
        .limit(input.limit ?? 20)
        .lean();

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
