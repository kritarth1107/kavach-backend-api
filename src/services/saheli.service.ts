import { randomUUID } from "crypto";
import CareSchedule from "../models/careSchedule.model";
import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";
import SaheliMessage, {
    type SaheliMessageConnectPayload,
    type SaheliMessageOrderPayload,
    type SaheliOrderFlowPayload,
    type SaheliMessageRole,
    type SaheliThreadKind,
} from "../models/saheliMessage.model";
import { AppError } from "../middleware/error.middleware";
import { CareScheduleType } from "../types/careSchedule.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import {
    aiPostCaregiverChatWithRetry,
    aiPostCheckIn,
    aiPostElderChatWithRetry,
    isAiEngineOfflineError,
    streamCaregiverSaheliChat,
    type AiStreamEvent,
} from "../clients/aiEngine.client";
import {
    buildSaheliContextBundle,
    formatSaheliContextForAi,
    formatScheduleSection,
    type SaheliContextBundle,
} from "./saheliContext.service";
import {
    recordWhatsAppAiDebug,
    type SaheliReplySource,
} from "./whatsappWebhookLog.service";
import {
    resolveElderDashboardReply,
    resolveElderWhatsappReply,
} from "./saheliElderPipeline.service";
import { buildGreetingReply, messageIsGreeting } from "./saheliElderFacts.service";
import { messageAsksForMemberPhone } from "./saheliCaregiverFacts.service";
import {
    refreshRecipientMemoryToAiEngine,
    syncSessionHistoryToAiEngine,
} from "./saheliMemorySync.service";
import { aiConversationId } from "../utils/uuid.util";
import type { AiContext } from "./aiTenant.service";
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
    buildWhatsAppElderChannelContext,
    companionProfilePayload,
    getCompanionProfile,
    type SaheliLanguage,
} from "./saheliCompanion.service";
import {
    excerptReport,
    findNamedReports,
    findPrintedHits,
    formatPrintedHit,
} from "./labCite.service";
import { type OrderFlowPayload } from "./orderOrchestrator.service";
import {
    messageLooksLikeOrder,
    normalizeOrderText,
    serializeOrderChatForClient,
    type OrderChatResult,
} from "./saheliOrder.service";
import {
    createSaheliChatSession,
    getSaheliChatSession,
    maybeSetSessionTitle,
    touchSaheliChatSession,
} from "./saheliSession.service";
import { getISTParts } from "../utils/istTime.util";

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
        orderFlowPayload?: SaheliOrderFlowPayload;
        orderPreviewPayload?: Record<string, unknown>;
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
        orderFlowPayload: extras?.orderFlowPayload,
        orderPreviewPayload: extras?.orderPreviewPayload,
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

function resolveCaregiverConversationForAi(
    ctx: AiContext,
    sessionConversationId?: string | null,
): string | undefined {
    return (
        aiConversationId(sessionConversationId) ??
        aiConversationId(ctx.caregiverConversationId) ??
        undefined
    );
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
        orderFlow: m.orderFlowPayload ?? undefined,
        orderPreview: m.orderPreviewPayload ?? undefined,
        connect: m.connectPayload ?? undefined,
    }));
}

function serializeOrderFlow(flow: OrderFlowPayload | null | undefined): SaheliOrderFlowPayload | undefined {
    if (!flow) return undefined;
    return {
        sessionId: flow.sessionId,
        phase: flow.phase,
        partner: flow.partner,
        partnerLabel: flow.partnerLabel,
        query: flow.query,
        selectedAddressId: flow.selectedAddressId,
        addresses: flow.addresses,
        catalog: flow.catalog,
        cartItems: flow.cartItems,
        orderId: flow.orderId,
        message: flow.message,
        disambiguation: flow.disambiguation,
        connectPartner: flow.connectPartner,
        connectUrl: flow.connectUrl ?? undefined,
    };
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
    const name = displayName.split(/\s+/)[0] || displayName;
    return `Hi ${name}! I'm Saheli. How can I help?`;
}

function buildElderHelpReply(_displayName: string): string {
    return "I can help with today's schedule, medicines, orders, and check-ins. Just ask.";
}

function trimElderReplyFluff(reply: string): string {
    let out = reply.trim();
    const fluffPatterns = [
        /\n+(What would you like|How can I help|Just ask|Is there anything else|Let me know if).*/is,
        /\n+(To change language|You can say "switch to).*/is,
        /\n+(I can also help|Here are some things|Quick actions).*/is,
    ];
    for (const pattern of fluffPatterns) {
        out = out.replace(pattern, "");
    }
    return out.trim();
}

function sanitizeElderReply(reply: string, displayName: string): string {
    let out = trimElderReplyFluff(reply);
    const first = displayName.split(/\s+/)[0]?.trim();
    const escapedFirst = first ? first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
    const escapedFull = displayName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    out = out.replace(/\bAI care co-pilot\b/gi, "companion");
    out = out.replace(/\bcare co-pilot\b/gi, "companion");
    out = out.replace(/\bcare coordination\b/gi, "daily care");

    if (escapedFirst) {
        out = out.replace(new RegExp(`how\\s+${escapedFirst}\\s+is\\s+doing`, "gi"), "how you're doing");
        out = out.replace(
            new RegExp(`updates on how\\s+${escapedFirst}\\s+is`, "gi"),
            "updates on how you're",
        );
        out = out.replace(new RegExp(`${escapedFirst}\\s+last said`, "gi"), "You last told me");
        out = out.replace(new RegExp(`if\\s+${escapedFirst}\\s+has told me`, "gi"), "if you've told me");
    }
    if (escapedFull && escapedFull !== escapedFirst) {
        out = out.replace(new RegExp(`how\\s+${escapedFull}\\s+is\\s+doing`, "gi"), "how you're doing");
        out = out.replace(new RegExp(`${escapedFull}\\s+last said`, "gi"), "You last told me");
    }

    return out;
}

function offlineSaheliMessage(): string {
    return "Saheli is reconnecting — please try again in a moment.";
}

function elderMissedIntent(qLower: string): boolean {
    return (
        /\bwhat\s+(did\s+)?i\s+miss/i.test(qLower) ||
        (/\b(miss(ed)?|forgot|skip(ped)?|didn't|did not)\b/i.test(qLower) &&
            /\b(today|aaj|schedule|medicine|meds|check|task)\b/i.test(qLower))
    );
}

function buildElderSmartReply(opts: {
    displayName: string;
    question: string;
    context: SaheliContextBundle;
    isFirstMessage: boolean;
    orderHint?: string;
    labs?: Array<{ title: string; recordDate?: string; rawText: string; kind?: string }>;
    elderLines?: string[];
}): string {
    const q = opts.question.trim();
    const qLower = q.toLowerCase();

    if (messageLooksLikeOrder(q)) {
        return (
            opts.orderHint ??
            "I couldn't reach ordering right now — please try again in a moment, or ask your caregiver to check Integrations."
        );
    }

    if (/\b(help|what can you|what do you|capabilities|features|kya kar)\b/i.test(qLower)) {
        return buildElderHelpReply(opts.displayName);
    }

    if (
        /\b(how am i|how i am|how are you asking|feeling|last said|check-?in)\b/i.test(qLower) &&
        opts.elderLines?.length
    ) {
        const last = opts.elderLines[opts.elderLines.length - 1]!;
        return `You last told me: "${last.slice(0, 280)}"`;
    }

    if (elderMissedIntent(qLower) || /\bwhat did i miss\b/i.test(qLower)) {
        if (!opts.context.missed.length) {
            return "Nothing missed today.";
        }
        return formatScheduleSection(opts.context.missed, "Missed today");
    }

    if (/\bwhat('s| is) next|coming up|upcoming\b/i.test(qLower)) {
        if (!opts.context.upcoming.length) {
            return "Nothing else scheduled for today.";
        }
        return formatScheduleSection(opts.context.upcoming, "Up next");
    }

    if (/\b(schedule|medicine|meds|dose|tablet|aaj|today|reminder)\b/i.test(qLower)) {
        const parts: string[] = [];
        if (opts.context.missed.length) {
            parts.push(formatScheduleSection(opts.context.missed, "Missed"));
        }
        if (opts.context.upcoming.length) {
            parts.push(formatScheduleSection(opts.context.upcoming, "Upcoming"));
        }
        if (!parts.length) {
            return "Nothing scheduled for today.";
        }
        return parts.filter(Boolean).join("\n\n");
    }

    if (opts.labs?.length || opts.elderLines?.length) {
        const structured = caregiverReplyFromCosmos({
            recipientName: opts.displayName,
            question: q,
            elderLines: opts.elderLines ?? [],
            labs: opts.labs ?? [],
        });
        const body = structured.replace(/\n\nReported only — nothing invented\.$/, "").trim();
        if (body.length > 24 && !/didn't find that in the saved care record/i.test(body)) {
            return body;
        }
    }

    if (messageIsGreeting(q)) {
        return buildGreetingReply(opts.displayName);
    }

    if (opts.isFirstMessage) {
        return buildElderSafeReply(opts.displayName);
    }

    if (/^(thanks|thank you|ok|okay|bye|goodbye|good night)[!.?\s]*$/i.test(qLower)) {
        return "Anytime! I'm here whenever you need me.";
    }

    return buildGreetingReply(opts.displayName);
}

async function elderReplyWithAi(
    familyId: string,
    recipientUserId: string,
    displayName: string,
    message: string,
    conversationIdOverride?: string,
    opts?: {
        sessionId?: string;
        orderContext?: string;
        channel?: ChannelType;
        contextBundle?: SaheliContextBundle;
        isFirstMessage?: boolean;
        elderLines?: string[];
        labs?: Array<{ title: string; recordDate?: string; rawText: string; kind?: string }>;
    },
): Promise<{
    reply: string;
    conversationId: string;
    orderFromAgent?: OrderChatResult | null;
    orderPreview?: Record<string, unknown> | null;
    orderFlow?: OrderFlowPayload | null;
    toolTrace?: Array<{ tool: string; status?: string }>;
}> {
    const waChannel = opts?.channel === ChannelType.WHATSAPP;
    const contextBundle =
        opts?.contextBundle ??
        (await buildSaheliContextBundle({
            familyId,
            recipientUserId,
            actorUserId: recipientUserId,
            channel: waChannel ? "whatsapp" : "dashboard",
        }));
    const scheduleContext = formatSaheliContextForAi(contextBundle);
    const contextChars = scheduleContext.length;

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
        const companion = await getCompanionProfile(familyId, recipientUserId);
        const lang = (companion.preferredLanguage ?? "english") as SaheliLanguage;
        const result = await aiPostElderChatWithRetry({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message,
            conversationId: conversationIdOverride ?? ctx.conversationId,
            careRecordContext: contextBundle.careRecordContext,
            companionProfile: {
                ...contextBundle.companionProfile,
                preferred_language: lang,
                audience: "elder_direct",
            },
            scheduleContext,
            channelContext: waChannel ? buildWhatsAppElderChannelContext(lang) : undefined,
            orderContext: opts?.orderContext,
            useAgent: true,
            actorUserId: recipientUserId,
            kavachFamilyId: familyId,
            kavachRecipientUserId: recipientUserId,
        });
        const conversationId =
            result.conversation_id || conversationIdOverride || `${familyId}:${recipientUserId}:elder`;
        if (result.conversation_id && !conversationIdOverride) {
            await persistConversationId(familyId, recipientUserId, result.conversation_id);
        }
        const rawReply = result.reply.trim() || "I'm here. Tell me more when you're ready.";
        let orderFromAgent: OrderChatResult | null = null;
        let orderPreview: Record<string, unknown> | null = null;
        let orderFlow: OrderFlowPayload | null = null;
        if (result.order && typeof result.order === "object") {
            orderFromAgent = { kind: "order", ...result.order } as unknown as OrderChatResult;
        } else if (result.connect && typeof result.connect === "object") {
            orderFromAgent = {
                kind: "connect_required",
                ...result.connect,
            } as unknown as OrderChatResult;
        }
        if (result.order_preview && typeof result.order_preview === "object") {
            orderPreview = result.order_preview;
        }
        if (result.order_flow && typeof result.order_flow === "object") {
            orderFlow = result.order_flow as OrderFlowPayload;
        }
        return {
            reply: waChannel ? sanitizeElderReply(rawReply, displayName) : rawReply,
            conversationId,
            orderFromAgent,
            orderPreview,
            orderFlow,
            toolTrace: result.tool_trace,
        };
    } catch (err) {
        const statusCode = err instanceof AppError ? err.statusCode : undefined;
        const aiError = err instanceof Error ? err.message : String(err);
        console.warn("Saheli AI elder reply fallback:", err);
        if (waChannel) {
            recordWhatsAppAiDebug({
                familyId,
                recipientUserId,
                actorUserId: recipientUserId,
                contextChars,
                aiError,
                aiStatusCode: statusCode,
                fallbackUsed: "buildElderSmartReply",
                replySource: "ai",
            });
        }
        const { buildOrderCommunicationReply } = await import("./orderPartnerAvailability.service");
        const orderComms = await buildOrderCommunicationReply({
            familyId,
            actorUserId: recipientUserId,
            message,
        });
        if (orderComms) {
            if (waChannel) {
                recordWhatsAppAiDebug({
                    familyId,
                    recipientUserId,
                    actorUserId: recipientUserId,
                    replySource: "orderComms",
                    fallbackUsed: "buildOrderCommunicationReply",
                });
            }
            return {
                reply: orderComms,
                conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:elder`,
            };
        }
        if (messageLooksLikeOrder(message)) {
            const { tryStartOrderFromMessage } = await import("./orderKernel.service");
            const kernel = await tryStartOrderFromMessage({
                familyId,
                recipientUserId,
                actorUserId: recipientUserId,
                message,
                saheliSessionId: opts?.sessionId,
            });
            if (kernel) {
                if (waChannel) {
                    recordWhatsAppAiDebug({
                        familyId,
                        recipientUserId,
                        actorUserId: recipientUserId,
                        replySource: "kernelFallback",
                        fallbackUsed: "tryStartOrderFromMessage",
                    });
                }
                return {
                    reply: kernel.reply,
                    conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:elder`,
                    orderFlow: kernel.orderFlow ?? null,
                };
            }
        }
        if (isAiEngineOfflineError(err)) {
            const offlineFallback = buildElderSmartReply({
                displayName,
                question: message,
                context: contextBundle,
                isFirstMessage: opts?.isFirstMessage ?? false,
                orderHint: opts?.orderContext,
                labs: opts?.labs,
                elderLines: opts?.elderLines,
            });
            return {
                reply: offlineFallback.includes("missed today") ? offlineFallback : offlineSaheliMessage(),
                conversationId: conversationIdOverride ?? `${familyId}:${recipientUserId}:elder`,
            };
        }
        return {
            reply: buildElderSmartReply({
                displayName,
                question: message,
                context: contextBundle,
                isFirstMessage: opts?.isFirstMessage ?? false,
                orderHint: opts?.orderContext,
                labs: opts?.labs,
                elderLines: opts?.elderLines,
            }),
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

    if (messageAsksForMemberPhone(q)) {
        return `${opts.recipientName}'s contact details are in Family — I couldn't load the number just now. Check Family → ${opts.recipientName}'s profile.`;
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
    opts?: {
        sessionId?: string;
        orderContext?: string;
        actorUserId?: string;
        useAgent?: boolean;
        scheduleContext?: string;
        familyRosterContext?: string;
        channel?: ChannelType;
    },
): Promise<{
    reply: string;
    conversationId: string;
    orderFromAgent?: OrderChatResult | null;
    orderPreview?: Record<string, unknown> | null;
}> {
    const careContextRaw = await getCareRecordContextForSaheli(familyId, recipientUserId, 40);
    const careContext = [
        opts?.scheduleContext,
        opts?.familyRosterContext,
        careContextRaw,
    ]
        .filter(Boolean)
        .join("\n\n");

    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
    const conversationForAi = resolveCaregiverConversationForAi(ctx, conversationIdOverride);

    if (opts?.sessionId) {
        await syncSessionHistoryToAiEngine({
            familyId,
            recipientUserId,
            displayName,
            sessionId: opts.sessionId,
            thread: "caregiver",
            conversationId: conversationForAi,
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
        const result = await aiPostCaregiverChatWithRetry({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message,
            conversationId: conversationForAi,
            careRecordContext: careContext,
            elderThreadContext,
            labsContext,
            sessionContext: context.sessionLines.slice(-8).join("\n"),
            orderContext: opts?.orderContext,
            useAgent: opts?.useAgent ?? true,
            actorUserId: opts?.actorUserId,
            kavachFamilyId: familyId,
            kavachRecipientUserId: recipientUserId,
        });
        const conversationId =
            result.conversation_id ||
            conversationForAi ||
            `${familyId}:${recipientUserId}:caregiver`;
        if (result.conversation_id) {
            await persistCaregiverConversationId(
                familyId,
                recipientUserId,
                result.conversation_id,
            );
        }
        const reply = result.reply.trim();
        let orderFromAgent: OrderChatResult | null = null;
        let orderPreview: Record<string, unknown> | null = null;
        if (result.order && typeof result.order === "object") {
            const o = result.order as Record<string, unknown>;
            orderFromAgent = { kind: "order", ...o } as unknown as OrderChatResult;
        } else if (result.connect && typeof result.connect === "object") {
            const c = result.connect as Record<string, unknown>;
            orderFromAgent = { kind: "connect_required", ...c } as unknown as OrderChatResult;
        }
        if (result.order_preview && typeof result.order_preview === "object") {
            orderPreview = result.order_preview as Record<string, unknown>;
        }
        if (reply) {
            return { reply, conversationId, orderFromAgent, orderPreview };
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
        whatsappPhone?: string;
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
    const waChannel = opts?.channel === ChannelType.WHATSAPP;
    const text = waChannel ? normalizeOrderText(message.trim()) : message.trim();
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

    const priorElderTurns = await SaheliMessage.countDocuments({
        familyId,
        recipientUserId,
        thread: "elder",
        role: "elder",
        sessionId,
    });
    const isFirstMessage = priorElderTurns === 0;
    const contextBundle = await buildSaheliContextBundle({
        familyId,
        recipientUserId,
        actorUserId,
        channel: waChannel ? "whatsapp" : "dashboard",
    });
    const historyLimit = waChannel ? 10 : 80;
    const elderHistory = await listThread(familyId, recipientUserId, "elder", historyLimit, sessionId);
    const elderLines = elderHistory.filter((m) => m.role === "elder").map((m) => m.content);
    const labs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: 1 })
        .lean();

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

    if (waChannel) {
        const { touchWhatsAppInbound } = await import("./saheliCompanion.service");
        await touchWhatsAppInbound(familyId, recipientUserId);
    }

    const { tryApplyElderCareActionFromMessage } = await import("./saheliCareAction.service");
    const careActionReply = await tryApplyElderCareActionFromMessage({
        familyId,
        recipientUserId,
        actorUserId,
        message: text,
        displayName,
        channel: opts?.channel,
    });

    const session = await getSaheliChatSession({
        sessionId,
        familyId,
        recipientUserId,
        actorUserId,
        thread: "elder",
    });

    const aiOpts = {
        sessionId,
        channel: opts?.channel,
        contextBundle,
        isFirstMessage,
        elderLines,
        labs: labs.map((d) => ({
            title: d.title,
            recordDate: d.recordDate,
            rawText: d.rawText,
            kind: d.kind,
        })),
    };
    const runAi = () =>
        elderReplyWithAi(
            familyId,
            recipientUserId,
            displayName,
            text,
            session.aiConversationId,
            aiOpts,
        );

    const pipelineResult = waChannel
        ? await resolveElderWhatsappReply({
              familyId,
              recipientUserId,
              displayName,
              message: text,
              sessionId: sessionId!,
              contextBundle,
              conversationId: session.aiConversationId ?? `${familyId}:${recipientUserId}:elder`,
              careActionReply,
              runAi,
          })
        : await resolveElderDashboardReply({
              familyId,
              recipientUserId,
              displayName,
              message: text,
              contextBundle,
              conversationId: session.aiConversationId ?? `${familyId}:${recipientUserId}:elder`,
              careActionReply,
              channel: opts?.channel,
              runAi,
          });

    let reply = pipelineResult.reply;
    let conversationId = pipelineResult.conversationId;
    let replySource: SaheliReplySource = pipelineResult.replySource;
    let order: OrderChatResult | null = pipelineResult.order;
    let orderFlow: OrderFlowPayload | null = pipelineResult.orderFlow;
    let orderPreview: Record<string, unknown> | null = pipelineResult.orderPreview;

    if (waChannel) {
        recordWhatsAppAiDebug({
            familyId,
            recipientUserId,
            actorUserId: recipientUserId,
            replySource,
            fallbackUsed:
                replySource !== "ai"
                    ? pipelineResult.guardAction ?? replySource
                    : pipelineResult.guardAction,
        });
    }

    if (pipelineResult.skippedAi && text.length >= 12) {
        void (async () => {
            try {
                const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
                const { aiEnqueueMemoryExtract } = await import("../clients/aiEngine.client");
                await aiEnqueueMemoryExtract({
                    aiFamilyId: ctx.aiFamilyId,
                    aiElderId: ctx.aiElderId,
                    message: text,
                });
            } catch {
                /* best-effort memory capture when AI path skipped */
            }
        })();
    }

    if (order?.kind === "connect_required" || order?.kind === "prompt") {
        reply = applyOrderChatResult(reply, order);
    } else if (order?.kind === "order") {
        reply = applyOrderChatResult(reply, order);
    }

    if (waChannel && opts?.whatsappPhone && orderFlow?.sessionId) {
        const { syncWhatsappOrderSession } = await import("./whatsappOrderFlow.service");
        await syncWhatsappOrderSession(opts.whatsappPhone, orderFlow);
    }

    await touchSaheliChatSession(sessionId, {
        aiConversationId: conversationId,
    });

    const finalReply = reply;
    const chatExtras = saheliChatExtras(order);
    const orderFlowPayload = serializeOrderFlow(orderFlow);

    await appendMessage(familyId, recipientUserId, "elder", "saheli", finalReply, sessionId, {
        orderPayload: chatExtras.orderPayload,
        orderFlowPayload,
        orderPreviewPayload: orderPreview ?? undefined,
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
        orderFlow: orderFlow ?? undefined,
        orderPreview: orderPreview ?? undefined,
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

    const waChannel = opts?.channel === ChannelType.WHATSAPP;
    const scheduleContext = waChannel
        ? formatSaheliContextForAi(
              await buildSaheliContextBundle({
                  familyId,
                  recipientUserId,
                  actorUserId,
                  channel: "whatsapp",
              }),
          )
        : undefined;

    const { tryHandleCaregiverContactQuery, formatFamilyRosterForAi } = await import(
        "./saheliCaregiverFacts.service"
    );
    const contactReply = await tryHandleCaregiverContactQuery({
        familyId,
        actorUserId,
        recipientUserId,
        message: text,
        displayName,
    });

    let order: OrderChatResult | null = null;
    let orderPreview: Record<string, unknown> | null = null;
    let reply = "";
    let conversationId =
        session.aiConversationId ?? `${familyId}:${recipientUserId}:caregiver`;
    if (contactReply) {
        reply = contactReply;
    } else {
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
            aiConversationId(session.aiConversationId),
            {
                sessionId,
                actorUserId,
                useAgent: true,
                scheduleContext,
                familyRosterContext: formatFamilyRosterForAi(membersPayload.members),
                channel: opts?.channel,
            },
        );
        conversationId = ai.conversationId;
        reply = ai.reply;
        if (ai.orderFromAgent) {
            order = ai.orderFromAgent;
        }
        if (ai.orderPreview) {
            orderPreview = ai.orderPreview;
        }
    }

    if (order?.kind === "connect_required") {
        reply = applyOrderChatResult(reply, order);
    } else if (order?.kind === "order") {
        reply = applyOrderChatResult(reply, order);
    } else if (order?.kind === "prompt") {
        reply = applyOrderChatResult(reply, order);
    }

    await touchSaheliChatSession(sessionId, {
        aiConversationId: aiConversationId(conversationId) ?? undefined,
    });

    const finalReply = reply;
    const chatExtras = saheliChatExtras(order);

    await appendMessage(familyId, recipientUserId, "caregiver", "saheli", finalReply, sessionId, {
        orderPayload: chatExtras.orderPayload,
        orderPreviewPayload: orderPreview ?? undefined,
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
        orderPreview: orderPreview ?? undefined,
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
    | AiStreamEvent
    | {
          type: "done";
          sessionId: string;
          conversationId: string;
          reply: string;
          order?: unknown;
          connect?: unknown;
          orderFlow?: SaheliOrderFlowPayload;
          orderPreview?: Record<string, unknown>;
      }
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

    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
    const conversationForAi = resolveCaregiverConversationForAi(ctx, session.aiConversationId);
    let conversationId =
        conversationForAi ?? `${familyId}:${recipientUserId}:caregiver`;
    const careContext = await getCareRecordContextForSaheli(familyId, recipientUserId, 40);

    await refreshRecipientMemoryToAiEngine({
        familyId,
        recipientUserId,
        displayName,
        sessionId,
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
    let orderPreview: Record<string, unknown> | null = null;

    try {
        for await (const event of streamCaregiverSaheliChat({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            message: text,
            conversationId: conversationForAi,
            careRecordContext: careContext,
            elderThreadContext,
            labsContext,
            sessionContext: sessionLines.slice(-8).join("\n"),
            useAgent: true,
            actorUserId,
            kavachFamilyId: familyId,
            kavachRecipientUserId: recipientUserId,
        })) {
            if (event.type === "token") {
                replyBuffer += event.delta;
                yield event;
            } else if (event.type === "tool_result") {
                if (event.order && typeof event.order === "object") {
                    order = orderFromAgentPayload(event.order as Record<string, unknown>);
                } else if (event.connect && typeof event.connect === "object") {
                    order = orderFromAgentPayload(event.connect as Record<string, unknown>);
                } else if (event.order_preview && typeof event.order_preview === "object") {
                    orderPreview = event.order_preview as Record<string, unknown>;
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
                if (event.order_preview && typeof event.order_preview === "object") {
                    orderPreview = event.order_preview as Record<string, unknown>;
                }
            } else {
                yield event;
            }
        }

        if (aiConversationId(conversationId)) {
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

    await touchSaheliChatSession(sessionId, {
        aiConversationId: aiConversationId(conversationId) ?? conversationForAi,
    });

    const chatExtras = saheliChatExtras(order);
    await appendMessage(familyId, recipientUserId, "caregiver", "saheli", reply, sessionId, {
        orderPayload: chatExtras.orderPayload,
        orderPreviewPayload: orderPreview ?? undefined,
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
        orderPreview: orderPreview ?? undefined,
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
    const today = getISTParts().dayOfWeek;
    const schedules = await CareSchedule.find({
        familyId,
        recipientUserId,
        active: true,
    }).lean();
    return schedules.filter((s) => scheduleAppliesToday(s.daysOfWeek ?? [], today));
}

export type BriefingItem = {
    scheduleId?: string;
    title: string;
    time: string;
    dosage?: string;
    type: string;
    status?: string;
};

export async function getRecipientBriefing(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    dateKey?: string,
) {
    const family = await getFamilyAndRecipientLocal(familyId, recipientUserId);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveRecipientName(membersPayload.members, recipientUserId);
    const { getScheduleDayStatuses } = await import("./careScheduleCompletion.service");
    const dayStatus = await getScheduleDayStatuses(
        familyId,
        recipientUserId,
        actorUserId,
        dateKey,
    );

    const todayItems: BriefingItem[] = dayStatus.items.map((s) => ({
        scheduleId: s.scheduleId,
        title: s.title,
        time: s.time,
        dosage: s.dosage ?? undefined,
        type: s.type,
        status: s.status,
    }));

    const unconfirmedItems = dayStatus.items
        .filter((s) => s.status === "missed" || s.status === "due")
        .map((s) => ({
            scheduleId: s.scheduleId,
            title: s.title,
            time: s.time,
            dosage: s.dosage ?? undefined,
            type: s.type,
            status: s.status,
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
        todayItems,
        unconfirmedItems,
        scheduleStatuses: dayStatus.items,
        completedCount: dayStatus.completedCount,
        missedCount: dayStatus.missedCount,
        upcomingCount: dayStatus.upcomingCount,
        elapsedCount: dayStatus.elapsedCount,
        adherencePercent: dayStatus.adherencePercent,
        dateKey: dayStatus.dateKey,
    };
}

export function scheduleAppliesToday(daysOfWeek: number[], day?: number): boolean {
    if (!daysOfWeek.length) return true;
    const dow = day ?? getISTParts().dayOfWeek;
    return daysOfWeek.includes(dow);
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

    const today = getISTParts().dayOfWeek;
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
