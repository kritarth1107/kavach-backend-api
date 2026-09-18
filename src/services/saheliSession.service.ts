import { randomUUID } from "crypto";
import SaheliChatSession from "../models/saheliChatSession.model";
import SaheliMessage, { type SaheliThreadKind } from "../models/saheliMessage.model";
import WhatsappSession from "../models/whatsappSession.model";
import { AppError } from "../middleware/error.middleware";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function titleFromMessage(message: string): string {
    const cleaned = message.replace(/\s+/g, " ").trim();
    if (!cleaned) return "New chat";
    return cleaned.length > 48 ? `${cleaned.slice(0, 48)}…` : cleaned;
}

export async function createSaheliChatSession(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    thread: SaheliThreadKind;
    title?: string;
}) {
    const session = await SaheliChatSession.create({
        sessionId: randomUUID(),
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        thread: input.thread,
        actorUserId: input.actorUserId,
        title: input.title?.trim() || "New chat",
    });

    return {
        sessionId: session.sessionId,
        title: session.title,
        createdAt: session.createdAt?.toISOString() ?? null,
        updatedAt: session.updatedAt?.toISOString() ?? null,
    };
}

export async function listSaheliChatSessions(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    thread: SaheliThreadKind;
    limit?: number;
}) {
    const rows = await SaheliChatSession.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        thread: input.thread,
        actorUserId: input.actorUserId,
    })
        .sort({ updatedAt: -1 })
        .limit(input.limit ?? 40)
        .lean();

    const sessions = await Promise.all(
        rows.map(async (row) => {
            const last = await SaheliMessage.findOne({ sessionId: row.sessionId })
                .sort({ createdAt: -1 })
                .lean();
            return {
                sessionId: row.sessionId,
                title: row.title,
                preview: last?.content?.slice(0, 80) ?? "",
                createdAt: row.createdAt?.toISOString() ?? null,
                updatedAt: row.updatedAt?.toISOString() ?? null,
            };
        }),
    );

    return sessions;
}

export async function getSaheliChatSession(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    thread: SaheliThreadKind;
    sessionId: string;
}) {
    const session = await SaheliChatSession.findOne({
        sessionId: input.sessionId,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        thread: input.thread,
        actorUserId: input.actorUserId,
    }).lean();

    if (!session) throw new AppError("Chat session not found", 404);
    return session;
}

export async function touchSaheliChatSession(
    sessionId: string,
    patch?: { title?: string; aiConversationId?: string },
) {
    await SaheliChatSession.findOneAndUpdate(
        { sessionId },
        {
            $set: {
                ...(patch?.title ? { title: patch.title } : {}),
                ...(patch?.aiConversationId ? { aiConversationId: patch.aiConversationId } : {}),
                updatedAt: new Date(),
            },
        },
    );
}

export async function maybeSetSessionTitle(sessionId: string, message: string) {
    const session = await SaheliChatSession.findOne({ sessionId }).lean();
    if (!session || (session.title !== "New chat" && session.title.length > 3)) return;
    await touchSaheliChatSession(sessionId, { title: titleFromMessage(message) });
}

export async function resolveWhatsAppSaheliSession(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    thread: SaheliThreadKind;
}) {
    const existing = await WhatsappSession.findOne({ phone: input.phone }).lean();
    if (existing?.saheliSessionId) {
        const session = await SaheliChatSession.findOne({
            sessionId: existing.saheliSessionId,
            familyId: input.familyId,
        }).lean();
        if (session) return session.sessionId;
    }

    const created = await createSaheliChatSession({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        thread: input.thread,
        title: "WhatsApp chat",
    });

    await WhatsappSession.findOneAndUpdate(
        { phone: input.phone },
        {
            $set: {
                saheliSessionId: created.sessionId,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
        },
        { upsert: true },
    );

    return created.sessionId;
}
