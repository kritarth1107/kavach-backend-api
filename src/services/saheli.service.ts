import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";
import SaheliMessage, {
    type SaheliMessageConnectPayload,
    type SaheliMessageOrderPayload,
    type SaheliMessageRole,
    type SaheliThreadKind,
} from "../models/saheliMessage.model";
import { AppError } from "../middleware/error.middleware";
import { CareScheduleType } from "../types/careSchedule.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import {
    aiPostCaregiverChatWithRetry,
    aiPostChat,
    aiPostCheckIn,
    isAiEngineOfflineError,
    streamCaregiverSaheliChat,
    type AiStreamEvent,
} from "../clients/aiEngine.client";
import { syncSessionHistoryToAiEngine } from "./saheliMemorySync.service";
import {
    ensureAiContext,
    persistCaregiverConversationId,
    persistConversationId,
} from "./aiTenant.service";
import { getCareRecordContextForSaheli, appendCareRecordEvent } from "./careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";
import { getFamilyMembersList } from "./familyMember.service";
import {
    companionProfilePayload,
    getCompanionProfile,
} from "./saheliCompanion.service";
import {
    excerptReport,
    findNamedReports,
    findPrintedHits,
    formatPrintedHit,
} from "./labCite.service";
import {
    maybeSuggestOrderFromChat,
    messageLooksLikeOrder,
    serializeOrderChatForClient,
    type OrderChatResult,
} from "./saheliOrder.service";
import {
    createSaheliChatSession,
    getSaheliChatSession,
    maybeSetSessionTitle,
    touchSaheliChatSession,
} from "./saheliSession.service";

async function getFamilyAndRecipientLocal(familyId: string, recipientUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new AppError("Family not found", 404);

    const member = family.members.find((m) => m.userId === recipientUserId);
    if (!member || member.status !== FamilyMemberStatus.JOINED) {
        throw new AppError("Care recipient not found", 404);
    }
    if (member.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Member is not a care recipient", 400);
    }
    return family;
}

function resolveRecipientName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
): string {
    const found = members.find((m) => m.userId === recipientUserId);
    return found?.name?.trim() || "Care recipient";
}

async function appendMessage(
    familyId: string,
    recipientUserId: string,
    thread: SaheliThreadKind,
    role: SaheliMessageRole,
    content: string,
    sessionId?: string,
    extras?: {
        orderPayload?: SaheliMessageOrderPayload;
        connectPayload?: SaheliMessageConnectPayload;
    },
) {
    const doc = await SaheliMessage.create({
        messageId: randomUUID(),
        familyId,
        recipientUserId,
        thread,
        sessionId,
        role,
        content,
        orderPayload: extras?.orderPayload,
        connectPayload: extras?.connectPayload,
    });
    return doc;
}

function orderPayloadFromChat(order: Extract<OrderChatResult, { kind: "order" }>): SaheliMessageOrderPayload {
    return {
        orderId: order.orderId,
        partner: order.partner,
        partnerLabel: order.partnerLabel,
        totalPaise: order.totalPaise,
        items: order.items,
        status: order.status,
        source: order.source,
        searchResults: order.searchResults,
        addresses: order.addresses,
        addressNote: order.addressNote,
    };
}

function connectPayloadFromChat(
    connect: Extract<OrderChatResult, { kind: "connect_required" }>,
): SaheliMessageConnectPayload {
    return {
        partner: connect.partner,
        partnerLabel: connect.partnerLabel,
        connectPartner: connect.connectPartner,
        connectUrl: connect.connectUrl,
    };
}

function saheliChatExtras(order: OrderChatResult | null) {
    const serialized = serializeOrderChatForClient(order);
    return {
        orderPayload: serialized.order ? orderPayloadFromChat(serialized.order) : undefined,
        connectPayload: serialized.connect ? connectPayloadFromChat(serialized.connect) : undefined,
        clientPayload: serialized,
    };
}

async function listThread(
    familyId: string,
    recipientUserId: string,
    thread: SaheliThreadKind,
    limit = 50,
    sessionId?: string,
) {
    const filter: Record<string, unknown> = { familyId, recipientUserId, thread };
    if (sessionId) filter.sessionId = sessionId;

    const rows = await SaheliMessage.find(filter)
        .sort({ createdAt: 1 })
        .limit(limit)
        .lean();
    return rows.map((m) => ({
        role: m.role,
        content: m.content,
        createdAt: m.createdAt ? m.createdAt.toISOString() : null,
        order: m.orderPayload ?? undefined,
        connect: m.connectPayload ?? undefined,
    }));
}

function caregiverReplyFromCosmos(opts: {
    recipientName: string;
    question: string;
    elderLines: string[];
    labs: Array<{ title: string; recordDate?: string; rawText: string; kind?: string }>;
}): string {
    const name = opts.recipientName;
    const q = opts.question.trim();
    const qLower = q.toLowerCase();
    const parts: string[] = [];

    const wantsHow =
        /\b(how is|how's|how was|feeling|last said|check-?in|heard)\b/i.test(qLower);
    const wantsList =
        /\b(what reports|which labs|list (the )?(reports|labs)|what('s| is) saved|documents on file)\b/i.test(
            qLower,
        );
    const wantsOrder = messageLooksLikeOrder(q);
    const hits = findPrintedHits(opts.labs, q);
    const named = findNamedReports(opts.labs, q);

    if (!wantsOrder && wantsHow) {
        if (opts.elderLines.length) {
            const last = opts.elderLines[opts.elderLines.length - 1];
            parts.push(`${name} last said: “${last.slice(0, 280)}”`);
        } else {
            parts.push(`${name} has not sent a message yet.`);
        }
    }

    if (hits.length) {
        parts.push(hits.map(formatPrintedHit).join("\n\n"));
    } else if (named.length) {
        const latestNamed = named[named.length - 1];
        parts.push(excerptReport(latestNamed));
    } else if (wantsList) {
        if (!opts.labs.length) {
            parts.push("No reports are saved in the family record.");
        } else {
            const latest = [...opts.labs].slice(-8).reverse();
            parts.push(
                `${opts.labs.length} reports on file. Latest:\n${latest
                    .map((l) => `• ${l.title}${l.recordDate ? ` (${l.recordDate})` : ""}`)
                    .join("\n")}`,
            );
        }
    } else if (!hits.length && /tsh|creatinine|hba1c|hemoglobin|haemoglobin|cea|vitamin/i.test(qLower)) {
        parts.push("No matching printed row was found in the saved reports.");
    }

    if (parts.length) {
        parts.push("Reported only — nothing invented.");
    } else {
        parts.push(
            "I didn't find that in the saved care record. Ask about labs, check-ins, or tell me what to order from Swiggy, Instamart, or Zepto.",
        );
    }
    return parts.filter(Boolean).join("\n\n");
}

function orderContextForAi(order: OrderChatResult | null): string | undefined {
    if (!order) return undefined;
    if (order.kind === "prompt") {
        return `[Ordering note for Saheli] ${order.message}`;
    }
    if (order.kind === "order") {
        const items = order.items.map((i) => `${i.name} ×${i.quantity}`).join(", ");
        return `[Order card prepared] ${order.partnerLabel}: ${items}. Approx ₹${(order.totalPaise / 100).toFixed(0)}. ${order.addressNote ?? "User picks address in card and approves."}`;
    }
    if (order.kind === "connect_required") {
        return `[Partner connect needed] ${order.partnerLabel}: ${order.message}`;
    }
    return undefined;
}

function applyOrderChatResult(reply: string, order: OrderChatResult | null): string {
    if (!order) return reply;
    if (order.kind === "connect_required") {
        return reply.trim() ? `${reply.trim()}\n\n${order.message}` : order.message;
    }
    if (order.kind === "prompt") {
        return reply.trim() ? `${reply.trim()}\n\n${order.message}` : order.message;
    }
    const itemList = order.items.map((i) => `${i.name} ×${i.quantity}`).join(", ");
    const addressNote = order.addressNote ?? "";
    const basket = `I've prepared a ${order.partnerLabel} basket:\n${itemList}\nApprox ₹${(order.totalPaise / 100).toFixed(0)}. Your family can approve it in the dashboard or on WhatsApp.${addressNote}`;
    return reply.trim() ? `${reply.trim()}\n\n${basket}` : basket;
}

function buildElderSafeReply(displayName: string): string {
    return `I'm here with you, ${displayName}. Tell me more — how you're feeling, what you ate, or if you need anything.`;
}

function offlineSaheliMessage(): string {
    return "Saheli is reconnecting — please try again in a moment.";
}

async function elderReplyWithAi(
    familyId: string,
    recipientUserId: string,
    displayName: string,
    message: string,
    conversationIdOverride?: string,
    opts?: { sessionId?: string; orderContext?: string },
): Promise<{ reply: string; conversationId: string }> {
    try {
        if (opts?.sessionId) {
            await syncSessionHistoryToAiEngine({
                familyId,
                recipientUserId,
                displayName,
                sessionId: opts.sessionId,
                thread: "elder",
                conversationId: conversationIdOverride,
            });
        }
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const careContext = await getCareRecordContextForSaheli(familyId, recipientUserId, 30);
        const companion = await getCompanionProfile(familyId, recipientUserId);
        const profile = companionProfilePayload(companion);
        const result = await aiPostChat({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message,
            conversationId: conversationIdOverride ?? ctx.conversationId,
            careRecordContext: careContext,
            companionProfile: profile,
            orderContext: opts?.orderContext,
        });
        const conversationId =
            result.conversation_id || conversationIdOverride || `${familyId}:${recipientUserId}:elder`;
        if (result.conversation_id && !conversationIdOverride) {
            await persistConversationId(familyId, recipientUserId, result.conversation_id);
        }
        return {
            reply: result.reply.trim() || "I'm here. Tell me more when you're ready.",
            conversationId,
        };
    } catch (err) {
        console.warn("Saheli AI elder reply fallback:", err);
        if (isAiEngineOfflineError(err)) {
            return {
                reply: offlineSaheliMessage(),
                conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:elder`,
            };
        }
        return {
            reply: buildElderSafeReply(displayName),
            conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:elder`,
        };
    }
}

function buildCaregiverSmartReply(opts: {
    recipientName: string;
    question: string;
    elderLines: string[];
    labs: Array<{ title: string; recordDate?: string; rawText: string; kind?: string }>;
    careContext: string;
    sessionLines: string[];
}): string {
    const q = opts.question.trim();
    const qLower = q.toLowerCase();

    if (messageLooksLikeOrder(q)) {
        return `Tell me what to order and from where — Swiggy (food), Instamart (groceries), or Zepto. Example: "2 dal makhani from Swiggy" or "1L milk and bread from Instamart". I'll search live prices, build a cart, and you approve in chat.`;
    }

    if (/\b(help|what can you|kya kar sakti|capabilities|features)\b/i.test(qLower)) {
        return `I'm Saheli — your care co-pilot for ${opts.recipientName}.\n\n• Labs & reports — cite saved values with dates\n• Check-ins — what they last told Saheli\n• Orders — Swiggy, Instamart, Zepto from this chat\n• Care timeline — medicines, vitals, messages\n\nWhat do you need?`;
    }

    if (/\b(summary|summarize|overview|brief|kya hua|update)\b/i.test(qLower)) {
        const timeline =
            opts.careContext !== "No Care Record events yet."
                ? opts.careContext.slice(0, 1800)
                : "No care events logged yet.";
        return `Here's ${opts.recipientName}'s recent care timeline:\n\n${timeline}`;
    }

    if (/\b(schedule|medicine|meds|dose|tablet|aaj|today)\b/i.test(qLower)) {
        const scheduleHint = opts.careContext
            .split("\n")
            .filter((line) => /schedule|dose|medicine|check.?in|vitals/i.test(line))
            .slice(-8)
            .join("\n");
        if (scheduleHint) {
            return `From today's care record:\n${scheduleHint}\n\nOpen Family → schedule for full details.`;
        }
    }

    const structured = caregiverReplyFromCosmos({
        recipientName: opts.recipientName,
        question: q,
        elderLines: opts.elderLines,
        labs: opts.labs,
    });
    const body = structured.replace(/\n\nReported only — nothing invented\.$/, "").trim();
    if (body.length > 24) return structured;

    if (opts.elderLines.length) {
        const recent = opts.elderLines.slice(-3).join("\n• ");
        return `Recent from ${opts.recipientName}:\n• ${recent}\n\nAsk about a specific lab, order, or "how is ${opts.recipientName} today?"`;
    }

    if (opts.careContext !== "No Care Record events yet.") {
        return `${opts.recipientName}'s care record:\n${opts.careContext.slice(0, 1400)}\n\nAsk me something specific — a lab value, an order, or how they're doing.`;
    }

    return `I'm here for ${opts.recipientName}. Ask about reports, today's care, or order food and groceries — I'll pull from your family record.`;
}

async function caregiverReplyWithAi(
    familyId: string,
    recipientUserId: string,
    displayName: string,
    message: string,
    context: {
        elderLines: string[];
        labs: Array<{ title: string; recordDate?: string; rawText: string; kind?: string }>;
        sessionLines: string[];
    },
    conversationIdOverride?: string,
    opts?: { sessionId?: string; orderContext?: string; actorUserId?: string },
): Promise<{ reply: string; conversationId: string; orderFromAgent?: OrderChatResult | null }> {
    const careContext = await getCareRecordContextForSaheli(familyId, recipientUserId, 40);

    if (opts?.sessionId) {
        await syncSessionHistoryToAiEngine({
            familyId,
            recipientUserId,
            displayName,
            sessionId: opts.sessionId,
            thread: "caregiver",
            conversationId: conversationIdOverride,
        });
    }

    const elderThreadContext = context.elderLines
        .slice(-12)
        .map((line, i) => `${i + 1}. ${line}`)
        .join("\n");
    const labsContext = context.labs
        .slice(-10)
        .map((l) => `${l.title}${l.recordDate ? ` (${l.recordDate})` : ""}: ${l.rawText.slice(0, 400)}`)
        .join("\n---\n");

    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const result = await aiPostCaregiverChatWithRetry({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message,
            conversationId: conversationIdOverride || undefined,
            careRecordContext: careContext,
            elderThreadContext,
            labsContext,
            sessionContext: context.sessionLines.slice(-8).join("\n"),
            orderContext: opts?.orderContext,
            useAgent: true,
            actorUserId: opts?.actorUserId,
        });
        const conversationId =
            result.conversation_id ||
            conversationIdOverride ||
            `${familyId}:${recipientUserId}:caregiver`;
        if (result.conversation_id && !conversationIdOverride) {
            await persistCaregiverConversationId(
                familyId,
                recipientUserId,
                result.conversation_id,
            );
        }
        const reply = result.reply.trim();
        let orderFromAgent: OrderChatResult | null = null;
        if (result.order && typeof result.order === "object") {
            const o = result.order as Record<string, unknown>;
            orderFromAgent = { kind: "order", ...o } as unknown as OrderChatResult;
        } else if (result.connect && typeof result.connect === "object") {
            const c = result.connect as Record<string, unknown>;
            orderFromAgent = { kind: "connect_required", ...c } as unknown as OrderChatResult;
        }
        if (reply) {
            return { reply, conversationId, orderFromAgent };
        }
        throw new Error("Empty AI reply");
    } catch (err) {
        console.warn("Saheli AI caregiver failed:", err);
        if (!isAiEngineOfflineError(err)) {
            return {
                reply: `I'm having trouble forming a full answer right now. ${offlineSaheliMessage()}`,
                conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:caregiver`,
            };
        }
        const fallback = buildCaregiverSmartReply({
            recipientName: displayName,
            question: message,
            elderLines: context.elderLines,
            labs: context.labs,
            careContext,
            sessionLines: context.sessionLines,
        });
        return {
            reply: fallback,
            conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:caregiver`,
        };
    }
}

export async function sendSaheliMessage(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    message: string,
    opts?: {
        skipInboundCareRecord?: boolean;
        channel?: ChannelType;
        source?: CareRecordSource;
        sessionId?: string;
    },
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Caregivers use Ask Saheli for their own thread", 400);
    }
    if (actorUserId !== recipientUserId) {
        throw new AppError("You can only message Saheli for your own profile", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const text = message.trim();
    if (!text) throw new AppError("Message is required", 400);

    let sessionId = opts?.sessionId;
    if (sessionId) {
        await getSaheliChatSession({
            sessionId,
            familyId,
            recipientUserId,
            actorUserId,
            thread: "elder",
        });
    } else {
        const created = await createSaheliChatSession({
            familyId,
            recipientUserId,
            actorUserId,
            thread: "elder",
        });
        sessionId = created.sessionId;
    }

    await maybeSetSessionTitle(sessionId, text);
    await appendMessage(familyId, recipientUserId, "elder", "elder", text, sessionId);
    if (!opts?.skipInboundCareRecord) {
        await appendCareRecordEvent({
            familyId,
            subjectUserId: recipientUserId,
            actorUserId,
            type: CareRecordEventType.MESSAGE,
            source: opts?.source ?? CareRecordSource.DASHBOARD,
            channel: opts?.channel ?? ChannelType.DASHBOARD,
            title: displayName,
            detail: text,
            status: "reported",
        });
    }
    const session = await getSaheliChatSession({
        sessionId,
        familyId,
        recipientUserId,
        actorUserId,
        thread: "elder",
    });

    let order: OrderChatResult | null = null;
    try {
        order = await maybeSuggestOrderFromChat({
            familyId,
            subjectUserId: recipientUserId,
            actorUserId,
            message: text,
        });
    } catch (err) {
        console.warn("Order suggest from elder chat failed:", err);
    }

    let reply = "";
    let conversationId = session.aiConversationId ?? `${familyId}:${recipientUserId}:elder`;

    if (order?.kind === "connect_required") {
        reply = order.message;
    } else {
        const ai = await elderReplyWithAi(
            familyId,
            recipientUserId,
            displayName,
            text,
            session.aiConversationId,
            { sessionId, orderContext: orderContextForAi(order) },
        );
        reply = applyOrderChatResult(ai.reply, order);
        conversationId = ai.conversationId;
    }

    await touchSaheliChatSession(sessionId, {
        aiConversationId: conversationId,
    });

    const finalReply = reply;
    const chatExtras = saheliChatExtras(order);

    await appendMessage(familyId, recipientUserId, "elder", "saheli", finalReply, sessionId, {
        orderPayload: chatExtras.orderPayload,
        connectPayload: chatExtras.connectPayload,
    });
    await appendCareRecordEvent({
        familyId,
        subjectUserId: recipientUserId,
        type: CareRecordEventType.MESSAGE,
        source: CareRecordSource.SAHELI,
        channel: opts?.channel ?? ChannelType.DASHBOARD,
        title: "Saheli",
        detail: finalReply,
        status: "reported",
        skipSignalCheck: true,
    });

    void maybeShareWithFamily(familyId, recipientUserId, text, displayName).catch((err) => {
        console.warn("Family share after elder message failed:", err);
    });

    return {
        reply: finalReply,
        conversationId,
        sessionId,
        ...chatExtras.clientPayload,
    };
}

async function maybeShareWithFamily(
    familyId: string,
    recipientUserId: string,
    elderMessage: string,
    displayName: string,
) {
    const companion = await getCompanionProfile(familyId, recipientUserId);
    if (!companion.shareWithFamily) return;

    const shareable =
        elderMessage.length >= 20 &&
        !/\b(bp|blood pressure|creatinine|tsh|medicine|tablet|dose|mg)\b/i.test(elderMessage);
    if (!shareable) return;

    const { shareElderUpdateWithFamily } = await import("./saheliOutreach.service");
    await shareElderUpdateWithFamily({
        familyId,
        recipientUserId,
        shareSummary: `${displayName} told Saheli: "${elderMessage.slice(0, 400)}"`,
    });
}

export async function getSaheliHistory(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    limit = 50,
    sessionId?: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    if (sessionId) {
        const session = await getSaheliChatSession({
            sessionId,
            familyId,
            recipientUserId,
            actorUserId,
            thread: "elder",
        });
        const messages = await listThread(familyId, recipientUserId, "elder", limit, sessionId);
        return {
            sessionId,
            conversationId: session.aiConversationId ?? `${familyId}:${recipientUserId}:elder`,
            messages,
        };
    }

    return {
        sessionId: null,
        conversationId: `${familyId}:${recipientUserId}:elder`,
        messages: [],
    };
}

export async function sendCaregiverSaheliMessage(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    message: string,
    opts?: {
        skipInboundCareRecord?: boolean;
        channel?: ChannelType;
        source?: CareRecordSource;
        sessionId?: string;
    },
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role === FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Care recipients use their own Saheli thread", 400);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const text = message.trim();
    if (!text) throw new AppError("Message is required", 400);

    let sessionId = opts?.sessionId;
    if (sessionId) {
        await getSaheliChatSession({
            sessionId,
            familyId,
            recipientUserId,
            actorUserId,
            thread: "caregiver",
        });
    } else {
        const created = await createSaheliChatSession({
            familyId,
            recipientUserId,
            actorUserId,
            thread: "caregiver",
        });
        sessionId = created.sessionId;
    }

    await maybeSetSessionTitle(sessionId, text);
    await appendMessage(familyId, recipientUserId, "caregiver", "family", text, sessionId);
    if (!opts?.skipInboundCareRecord) {
        await appendCareRecordEvent({
            familyId,
            subjectUserId: recipientUserId,
            actorUserId,
            type: CareRecordEventType.MESSAGE,
            source: opts?.source ?? CareRecordSource.DASHBOARD,
            channel: opts?.channel ?? ChannelType.DASHBOARD,
            title: "Caregiver",
            detail: text,
            status: "reported",
        });
    }

    const session = await getSaheliChatSession({
        sessionId,
        familyId,
        recipientUserId,
        actorUserId,
        thread: "caregiver",
    });

    const elderHistory = await listThread(familyId, recipientUserId, "elder", 80);
    const elderLines = elderHistory.filter((m) => m.role === "elder").map((m) => m.content);
    const sessionHistory = await listThread(
        familyId,
        recipientUserId,
        "caregiver",
        16,
        sessionId,
    );
    const sessionLines = sessionHistory
        .filter((m) => m.role === "family" || m.role === "saheli")
        .map((m) => `${m.role}: ${m.content}`);
    const labs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: 1 })
        .lean();

    let order: OrderChatResult | null = null;
    let reply = "";
    let conversationId = session.aiConversationId ?? `${familyId}:${recipientUserId}:caregiver`;

    const ai = await caregiverReplyWithAi(
        familyId,
        recipientUserId,
        displayName,
        text,
        {
            elderLines,
            sessionLines,
            labs: labs.map((d) => ({
                title: d.title,
                recordDate: d.recordDate,
                rawText: d.rawText,
                kind: d.kind,
            })),
        },
        session.aiConversationId,
        { sessionId, actorUserId },
    );
    reply = ai.reply;
    conversationId = ai.conversationId;
    if (ai.orderFromAgent) {
        order = ai.orderFromAgent;
    }

    if (order?.kind === "connect_required") {
        reply = applyOrderChatResult(reply, order);
    } else if (order?.kind === "order") {
        reply = applyOrderChatResult(reply, order);
    } else if (order?.kind === "prompt") {
        reply = applyOrderChatResult(reply, order);
    }

    await touchSaheliChatSession(sessionId, {
        aiConversationId: conversationId,
    });

    const finalReply = reply;
    const chatExtras = saheliChatExtras(order);

    await appendMessage(familyId, recipientUserId, "caregiver", "saheli", finalReply, sessionId, {
        orderPayload: chatExtras.orderPayload,
        connectPayload: chatExtras.connectPayload,
    });
    await appendCareRecordEvent({
        familyId,
        subjectUserId: recipientUserId,
        type: CareRecordEventType.MESSAGE,
        source: CareRecordSource.SAHELI,
        channel: opts?.channel ?? ChannelType.DASHBOARD,
        title: "Saheli",
        detail: finalReply,
        status: "reported",
        skipSignalCheck: true,
    });

    return {
        reply: finalReply,
        conversationId,
        sessionId,
        ...chatExtras.clientPayload,
    };
}

function orderFromAgentPayload(raw: Record<string, unknown>): OrderChatResult | null {
    if (raw.orderId || raw.kind === "order") {
        return { kind: "order", ...raw } as unknown as OrderChatResult;
    }
    if (raw.connectPartner || raw.kind === "connect_required") {
        return { kind: "connect_required", ...raw } as unknown as OrderChatResult;
    }
    if (raw.kind === "prompt") {
        return { kind: "prompt", ...raw } as unknown as OrderChatResult;
    }
    return null;
}

export async function* streamCaregiverSaheliMessage(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    message: string,
    opts?: {
        skipInboundCareRecord?: boolean;
        channel?: ChannelType;
        source?: CareRecordSource;
        sessionId?: string;
    },
): AsyncGenerator<
    AiStreamEvent | { type: "done"; sessionId: string; conversationId: string; reply: string; order?: unknown; connect?: unknown }
> {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        yield { type: "error", message: "Family not found or access denied" };
        return;
    }

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role === FamilyRole.CARE_RECIPIENT) {
        yield { type: "error", message: "Care recipients use their own Saheli thread" };
        return;
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const text = message.trim();
    if (!text) {
        yield { type: "error", message: "Message is required" };
        return;
    }

    let sessionId = opts?.sessionId;
    if (sessionId) {
        await getSaheliChatSession({
            sessionId,
            familyId,
            recipientUserId,
            actorUserId,
            thread: "caregiver",
        });
    } else {
        const created = await createSaheliChatSession({
            familyId,
            recipientUserId,
            actorUserId,
            thread: "caregiver",
        });
        sessionId = created.sessionId;
    }

    await maybeSetSessionTitle(sessionId, text);
    await appendMessage(familyId, recipientUserId, "caregiver", "family", text, sessionId);
    if (!opts?.skipInboundCareRecord) {
        await appendCareRecordEvent({
            familyId,
            subjectUserId: recipientUserId,
            actorUserId,
            type: CareRecordEventType.MESSAGE,
            source: opts?.source ?? CareRecordSource.DASHBOARD,
            channel: opts?.channel ?? ChannelType.DASHBOARD,
            title: "Caregiver",
            detail: text,
            status: "reported",
        });
    }

    const session = await getSaheliChatSession({
        sessionId,
        familyId,
        recipientUserId,
        actorUserId,
        thread: "caregiver",
    });

    const elderHistory = await listThread(familyId, recipientUserId, "elder", 80);
    const elderLines = elderHistory.filter((m) => m.role === "elder").map((m) => m.content);
    const sessionHistory = await listThread(
        familyId,
        recipientUserId,
        "caregiver",
        16,
        sessionId,
    );
    const sessionLines = sessionHistory
        .filter((m) => m.role === "family" || m.role === "saheli")
        .map((m) => `${m.role}: ${m.content}`);
    const labs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: 1 })
        .lean();

    let conversationId = session.aiConversationId ?? `${familyId}:${recipientUserId}:caregiver`;
    const careContext = await getCareRecordContextForSaheli(familyId, recipientUserId, 40);

    await syncSessionHistoryToAiEngine({
        familyId,
        recipientUserId,
        displayName,
        sessionId,
        thread: "caregiver",
        conversationId: session.aiConversationId,
    });

    const elderThreadContext = elderLines
        .slice(-12)
        .map((line, i) => `${i + 1}. ${line}`)
        .join("\n");
    const labsContext = labs
        .slice(-10)
        .map((l) => `${l.title}${l.recordDate ? ` (${l.recordDate})` : ""}: ${l.rawText.slice(0, 400)}`)
        .join("\n---\n");

    let replyBuffer = "";
    let order: OrderChatResult | null = null;

    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        for await (const event of streamCaregiverSaheliChat({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message: text,
            conversationId: session.aiConversationId || undefined,
            careRecordContext: careContext,
            elderThreadContext,
            labsContext,
            sessionContext: sessionLines.slice(-8).join("\n"),
            actorUserId,
        })) {
            if (event.type === "token") {
                replyBuffer += event.delta;
                yield event;
            } else if (event.type === "tool_result") {
                if (event.order && typeof event.order === "object") {
                    order = orderFromAgentPayload(event.order as Record<string, unknown>);
                } else if (event.connect && typeof event.connect === "object") {
                    order = orderFromAgentPayload(event.connect as Record<string, unknown>);
                }
                yield event;
            } else if (event.type === "done") {
                conversationId = event.conversation_id || conversationId;
                if (event.reply?.trim()) replyBuffer = event.reply.trim();
                if (event.order && typeof event.order === "object") {
                    order = orderFromAgentPayload(event.order as Record<string, unknown>);
                } else if (event.connect && typeof event.connect === "object") {
                    order = orderFromAgentPayload(event.connect as Record<string, unknown>);
                }
            } else {
                yield event;
            }
        }

        if (conversationId && !session.aiConversationId) {
            await persistCaregiverConversationId(familyId, recipientUserId, conversationId);
        }
    } catch (err) {
        console.warn("Saheli AI caregiver stream failed:", err);
        if (!replyBuffer.trim()) {
            replyBuffer = isAiEngineOfflineError(err)
                ? buildCaregiverSmartReply({
                      recipientName: displayName,
                      question: text,
                      elderLines,
                      labs: labs.map((d) => ({
                          title: d.title,
                          recordDate: d.recordDate,
                          rawText: d.rawText,
                          kind: d.kind,
                      })),
                      careContext,
                      sessionLines,
                  })
                : `I'm having trouble forming a full answer right now. ${offlineSaheliMessage()}`;
            yield { type: "token", delta: replyBuffer };
        }
    }

    let reply = replyBuffer.trim();
    if (order) {
        reply = applyOrderChatResult(reply, order);
    }

    await touchSaheliChatSession(sessionId, { aiConversationId: conversationId });

    const chatExtras = saheliChatExtras(order);
    await appendMessage(familyId, recipientUserId, "caregiver", "saheli", reply, sessionId, {
        orderPayload: chatExtras.orderPayload,
        connectPayload: chatExtras.connectPayload,
    });
    await appendCareRecordEvent({
        familyId,
        subjectUserId: recipientUserId,
        type: CareRecordEventType.MESSAGE,
        source: CareRecordSource.SAHELI,
        channel: opts?.channel ?? ChannelType.DASHBOARD,
        title: "Saheli",
        detail: reply,
        status: "reported",
        skipSignalCheck: true,
    });

    yield {
        type: "done",
        sessionId,
        conversationId,
        reply,
        ...chatExtras.clientPayload,
    };
}

export async function getCaregiverSaheliHistory(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    limit = 50,
    sessionId?: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const actor = family.members.find((m) => m.userId === actorUserId);
    if (actor?.role === FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Care recipients use their own Saheli thread", 400);
    }

    if (sessionId) {
        const session = await getSaheliChatSession({
            sessionId,
            familyId,
            recipientUserId,
            actorUserId,
            thread: "caregiver",
        });
        const messages = await listThread(familyId, recipientUserId, "caregiver", limit, sessionId);
        return {
            sessionId,
            conversationId: session.aiConversationId ?? `${familyId}:${recipientUserId}:caregiver`,
            messages,
        };
    }

    return {
        sessionId: null,
        conversationId: `${familyId}:${recipientUserId}:caregiver`,
        messages: [],
    };
}

export async function triggerSaheliCheckIn(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const todayItems = await getTodayScheduleItems(familyId, recipientUserId);
    const companion = await getCompanionProfile(familyId, recipientUserId);
    const profile = companionProfilePayload(companion);
    const list =
        todayItems.length === 0
            ? "Nothing on today’s care list."
            : todayItems
                  .map((s) => `${s.title}${s.time ? ` · ${s.time}` : ""}${s.dosage ? ` · ${s.dosage}` : ""}`)
                  .join("; ");

    await appendMessage(
        familyId,
        recipientUserId,
        "elder",
        "system",
        `Check-in prompted for ${displayName}`,
    );

    let reply = `Check-in saved. On today’s list (not confirmed taken): ${list}`;
    let conversationId = `${familyId}:${recipientUserId}:elder`;

    try {
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const careContext = await getCareRecordContextForSaheli(familyId, recipientUserId, 25);
        const result = await aiPostCheckIn({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            conversationId: ctx.conversationId,
            scheduleItems: todayItems.map((s) => ({
                title: s.title,
                time: s.time,
                dosage: s.dosage,
                type: s.type,
            })),
            careRecordContext: careContext,
            companionProfile: profile,
        });
        if (result.reply?.trim()) reply = result.reply.trim();
        if (result.conversation_id) {
            conversationId = result.conversation_id;
            await persistConversationId(familyId, recipientUserId, result.conversation_id);
        }
    } catch (err) {
        console.warn("Saheli AI check-in fallback:", err);
    }

    await appendMessage(familyId, recipientUserId, "elder", "saheli", reply);

    return { reply, conversationId };
}

function parseTimeToMinutes(time: string): number | null {
    const match = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = Number(match[1]) % 12;
    const minutes = Number(match[2]);
    if (match[3].toUpperCase() === "PM") hours += 12;
    return hours * 60 + minutes;
}

async function getTodayScheduleItems(familyId: string, recipientUserId: string) {
    const today = new Date().getDay();
    const schedules = await CareSchedule.find({
        familyId,
        recipientUserId,
        active: true,
    }).lean();
    return schedules.filter((s) => scheduleAppliesToday(s.daysOfWeek ?? [], today));
}

export type BriefingItem = {
    title: string;
    time: string;
    dosage?: string;
    type: string;
};

export async function getRecipientBriefing(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const todayItems = await getTodayScheduleItems(familyId, recipientUserId);

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const unconfirmedItems: BriefingItem[] = todayItems
        .filter((s) => {
            const mins = parseTimeToMinutes(s.time);
            return mins !== null && mins <= nowMinutes;
        })
        .map((s) => ({
            title: s.title,
            time: s.time,
            dosage: s.dosage,
            type: s.type,
        }));

    const elderHistory = await listThread(familyId, recipientUserId, "elder", 80);
    const elderMsgs = elderHistory.filter((m) => m.role === "elder");
    const lastElder = elderMsgs[elderMsgs.length - 1];
    const checkIns = elderHistory.filter((m) => m.role === "system");
    const lastCheckIn = checkIns[checkIns.length - 1];

    return {
        recipientName: displayName,
        lastHeardAt: lastElder?.createdAt ?? null,
        lastHeardLine: lastElder?.content ?? null,
        lastCheckInAt: lastCheckIn?.createdAt ?? null,
        todayItems: todayItems.map((s) => ({
            title: s.title,
            time: s.time,
            dosage: s.dosage,
            type: s.type,
        })),
        unconfirmedItems,
    };
}

export function scheduleAppliesToday(daysOfWeek: number[], day = new Date().getDay()): boolean {
    if (!daysOfWeek.length) return true;
    return daysOfWeek.includes(day);
}

function scheduleTimeToday(time: string): string {
    const now = new Date();
    const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return now.toISOString();
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hours += 12;
    now.setHours(hours, Number(match[2]), 0, 0);
    return now.toISOString();
}

function isSameLocalDay(iso: string): boolean {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return false;
    const now = new Date();
    return (
        at.getFullYear() === now.getFullYear() &&
        at.getMonth() === now.getMonth() &&
        at.getDate() === now.getDate()
    );
}

export type ActivityItem = {
    id: string;
    type: "message" | "schedule" | "check_in" | "lab";
    title: string;
    detail: string;
    recipientUserId: string;
    recipientName: string;
    at: string;
    status: "completed" | "scheduled" | "reported";
};

function elderBlob(lines: string[]): string {
    return lines.join(" ").toLowerCase();
}

function scheduleHasReport(
    title: string,
    type: string,
    blob: string,
    heardToday: boolean,
    hasBpLab: boolean,
): boolean {
    const t = title.toLowerCase();
    if (type === CareScheduleType.CHECK_IN) return heardToday;
    if (type === CareScheduleType.VITALS || /blood pressure|\bbp\b/.test(t)) {
        return hasBpLab || /118\s*\/\s*76|blood pressure|\bbp\b/.test(blob);
    }
    if (/shelcal/.test(t)) return /shelcal/.test(blob);
    if (/folvite/.test(t)) return /folvite/.test(blob);
    if (/vitamin/.test(t)) return /vitamin d/.test(blob);
    if (type === CareScheduleType.MEDICINE) return /took|taken|medicine/.test(blob);
    return false;
}

export async function getFamilyOverview(familyId: string, actorUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const recipients = membersPayload.members.filter(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
    );

    const today = new Date().getDay();
    let schedulesToday = 0;
    let checkInsToday = 0;
    let completedToday = 0;
    let messagesToday = 0;
    let labCount = 0;
    let lastSaheliReply: string | null = null;
    let lastHeardLine: string | null = null;
    let lastActivityAt: string | null = null;
    const activity: ActivityItem[] = [];

    for (const recipient of recipients) {
        const recipientName =
            recipient.fullName?.trim() || recipient.name?.trim() || "Care recipient";
        const recipientUserId = recipient.userId;
        if (!recipientUserId) continue;

        const [schedules, msgs, labs] = await Promise.all([
            CareSchedule.find({ familyId, recipientUserId, active: true }).lean(),
            SaheliMessage.find({ familyId, recipientUserId }).sort({ createdAt: 1 }).limit(120).lean(),
            LabDocument.find({ familyId, recipientUserId }).sort({ createdAt: -1 }).lean(),
        ]);

        labCount += labs.length;
        const elderToday = msgs
            .filter((m) => m.role === "elder" && m.createdAt && isSameLocalDay(m.createdAt.toISOString()))
            .map((m) => m.content);
        const blob = elderBlob(elderToday);
        const heardToday = elderToday.length > 0;
        const hasBpLab = labs.some((l) => /blood pressure|\bbp\b/i.test(l.title));

        for (const s of schedules) {
            if (!scheduleAppliesToday(s.daysOfWeek ?? [], today)) continue;
            schedulesToday += 1;
            if (s.type === CareScheduleType.CHECK_IN) checkInsToday += 1;
            const done = scheduleHasReport(s.title, s.type, blob, heardToday, hasBpLab);
            if (done) completedToday += 1;
            const at = scheduleTimeToday(s.time);
            activity.push({
                id: `schedule-${s.scheduleId}`,
                type: s.type === CareScheduleType.CHECK_IN ? "check_in" : "schedule",
                title: s.title,
                detail: `${s.time}${s.dosage ? ` · ${s.dosage}` : ""}`,
                recipientUserId,
                recipientName,
                at,
                status: done ? "completed" : "scheduled",
            });
            if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
        }

        for (const lab of labs) {
            const at = lab.createdAt ? lab.createdAt.toISOString() : new Date().toISOString();
            const printed = lab.rawText.replace(/\s+/g, " ").trim().slice(0, 120);
            activity.push({
                id: `lab-${lab.documentId}`,
                type: "lab",
                title: lab.title,
                detail: lab.recordDate ? `${lab.recordDate} · ${printed}` : printed,
                recipientUserId,
                recipientName,
                at,
                status: "completed",
            });
            if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
        }

        for (const msg of msgs) {
            const at = msg.createdAt ? msg.createdAt.toISOString() : new Date().toISOString();
            activity.push({
                id: `msg-${msg.messageId}`,
                type: msg.role === "system" ? "check_in" : "message",
                title:
                    msg.role === "saheli"
                        ? "Saheli"
                        : msg.role === "system"
                          ? "Check-in"
                          : msg.role === "family"
                            ? "Family"
                            : recipientName,
                detail: msg.content.slice(0, 120),
                recipientUserId,
                recipientName,
                at,
                status: "reported",
            });
            if (msg.role === "elder") lastHeardLine = msg.content;
            if (msg.role === "saheli") {
                lastSaheliReply = msg.content;
                if (isSameLocalDay(at)) messagesToday += 1;
            } else if (isSameLocalDay(at) && msg.role !== "system") {
                messagesToday += 1;
            }
            if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
        }
    }

    activity.sort((a, b) => (a.at < b.at ? 1 : -1));

    const pendingApprovals = await Order.countDocuments({
        familyId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    });

    return {
        careRecipientCount: recipients.length,
        schedulesToday,
        checkInsToday,
        completedToday,
        messagesToday,
        pendingApprovals,
        medAdherencePercent: schedulesToday
            ? Math.round((completedToday / schedulesToday) * 100)
            : 0,
        lastSaheliReply,
        lastHeardLine,
        lastActivityAt,
        labCount,
        recipients: recipients.map((r) => ({
            userId: r.userId ?? "",
            name: r.fullName?.trim() || r.name?.trim() || "Care recipient",
        })).filter((r) => r.userId),
        recentActivity: activity.slice(0, 50),
    };
}

export async function getFamilyActivityLog(
    familyId: string,
    actorUserId: string,
    limit = 30,
) {
    const overview = await getFamilyOverview(familyId, actorUserId);
    return {
        items: overview.recentActivity.slice(0, limit),
    };
}

export async function maybeTriggerCheckInOnScheduleCreate(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    scheduleType: CareScheduleType,
): Promise<void> {
    if (scheduleType !== CareScheduleType.CHECK_IN) return;
    try {
        await triggerSaheliCheckIn(familyId, recipientUserId, actorUserId);
    } catch (err) {
        console.warn("Saheli check-in trigger failed:", err);
    }
}
