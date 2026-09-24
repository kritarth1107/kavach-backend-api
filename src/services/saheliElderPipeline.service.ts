import type { OrderFlowPayload } from "./orderOrchestrator.service";
import type { OrderChatResult } from "./saheliOrder.service";
import { messageLooksLikeOrder, messageLooksLikeUnsupportedCommerce, unsupportedCommerceReply } from "./saheliOrder.service";
import type { SaheliContextBundle } from "./saheliContext.service";
import type { ChannelType } from "../types/careRecord.types";
import type { SaheliReplySource } from "./whatsappWebhookLog.service";
import {
    buildElderHelpReply,
    buildGreetingReply,
    messageAsksHelp,
    messageAsksMemory,
    messageIsCasualOffer,
    messageIsGreeting,
    buildCasualOfferReply,
    messageIsAcknowledgment,
    tryHandleElderScheduleQuery,
} from "./saheliElderFacts.service";
import { stampCompanionVoice } from "./saheliCompanionVoice.service";
import { guardElderReply } from "./saheliReplyGuard.service";

export type ElderPipelineResult = {
    reply: string;
    replySource: SaheliReplySource;
    conversationId: string;
    order: OrderChatResult | null;
    orderFlow: OrderFlowPayload | null;
    orderPreview: Record<string, unknown> | null;
    guardAction?: string;
    skippedAi?: boolean;
};

type AiTurn = {
    reply: string;
    conversationId: string;
    orderFromAgent?: OrderChatResult | null;
    orderPreview?: Record<string, unknown> | null;
    orderFlow?: OrderFlowPayload | null;
    toolTrace?: Array<{ tool: string; status?: string }>;
};

export async function resolveElderWhatsappReply(input: {
    familyId: string;
    recipientUserId: string;
    displayName: string;
    message: string;
    sessionId: string;
    contextBundle: SaheliContextBundle;
    conversationId: string;
    careActionReply: string | null;
    runAi: () => Promise<AiTurn>;
}): Promise<ElderPipelineResult> {
    let reply = "";
    let replySource: SaheliReplySource = "ai";
    let conversationId = input.conversationId;
    let order: OrderChatResult | null = null;
    let orderFlow: OrderFlowPayload | null = null;
    let orderPreview: Record<string, unknown> | null = null;
    let toolTrace: Array<{ tool: string; status?: string }> | undefined;
    let guardAction: string | undefined;
    let skippedAi = false;

    if (input.careActionReply) {
        return {
            reply: await stampCompanionVoice(input.careActionReply, {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "careAction",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
        };
    }

    if (messageIsGreeting(input.message) && !messageAsksMemory(input.message)) {
        let memoryHook: string | null = null;
        try {
            const { ensureAiContext } = await import("./aiTenant.service");
            const { aiGrepMemory } = await import("../clients/aiEngine.client");
            const ctx = await ensureAiContext(
                input.familyId,
                input.recipientUserId,
                input.displayName,
            );
            const grep = await aiGrepMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                query: "family hobby food mood memories",
                limit: 1,
            });
            const hit = grep.hits[0];
            if (hit?.title) {
                memoryHook = `By the way — how is ${hit.title} these days?`;
            }
        } catch {
            memoryHook = null;
        }
        return {
            reply: buildGreetingReply(input.displayName, memoryHook),
            replySource: "scheduleFacts",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
            guardAction: "greeting",
        };
    }

    const wantsMemoryAi = messageAsksMemory(input.message);

    if (!wantsMemoryAi && messageIsCasualOffer(input.message)) {
        return {
            reply: await stampCompanionVoice(buildCasualOfferReply(input.displayName), {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
            guardAction: "casual_offer",
        };
    }

    if (/^(\.{2,}|…+|\?+)$/u.test(input.message.trim())) {
        return {
            reply: await stampCompanionVoice("I'm here — tell me more whenever you're ready.", {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
            guardAction: "ellipsis_ping",
        };
    }

    if (!wantsMemoryAi && messageIsAcknowledgment(input.message)) {
        return {
            reply: await stampCompanionVoice("Anytime! I'm here whenever you need me.", {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
            guardAction: "acknowledgment",
        };
    }

    if (!wantsMemoryAi) {
        const scheduleReply = tryHandleElderScheduleQuery({
            message: input.message,
            context: input.contextBundle,
        });
        if (scheduleReply) {
            return {
                reply: await stampCompanionVoice(scheduleReply, {
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                }),
                replySource: "scheduleFacts",
                conversationId,
                order: null,
                orderFlow: null,
                orderPreview: null,
                skippedAi: true,
            };
        }
    }

    if (!wantsMemoryAi && messageAsksHelp(input.message)) {
        return {
            reply: await stampCompanionVoice(buildElderHelpReply(input.displayName), {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
        };
    }

    // Any-site private browser (BigBasket / Amazon / URL paste / …) before unsupported gate.
    {
        const {
            messageLooksLikeBrowserTask,
            handleBrowserTaskWhatsAppTurn,
        } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        if (messageLooksLikeBrowserTask(input.message)) {
            const browser = await handleBrowserTaskWhatsAppTurn({
                phone: `elder:${input.recipientUserId}`,
                text: input.message,
                familyId: input.familyId,
                actorUserId: input.recipientUserId,
                recipientUserId: input.recipientUserId,
                actorRole: null,
            });
            if (browser) {
                return {
                    reply: await stampCompanionVoice(browser.text, {
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                    }),
                    replySource: "browserOrder",
                    conversationId,
                    order: null,
                    orderFlow: null,
                    orderPreview: null,
                    skippedAi: true,
                };
            }
        }
    }

    if (messageLooksLikeUnsupportedCommerce(input.message)) {
        return {
            reply: await stampCompanionVoice(unsupportedCommerceReply(), {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
            guardAction: "unsupported_commerce",
        };
    }

    {
        const { messageLooksLikePharmacyOrder, handlePharmacyWhatsAppTurn } = await import(
            "./pharmacyOrderFlow.service"
        );
        if (messageLooksLikePharmacyOrder(input.message)) {
            const pharmacy = await handlePharmacyWhatsAppTurn({
                phone: `elder:${input.recipientUserId}`,
                text: input.message,
                familyId: input.familyId,
                actorUserId: input.recipientUserId,
                recipientUserId: input.recipientUserId,
                actorRole: null,
            });
            if (pharmacy) {
                return {
                    reply: await stampCompanionVoice(pharmacy.text, {
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                    }),
                    replySource: "pharmacyOrder",
                    conversationId,
                    order: null,
                    orderFlow: null,
                    orderPreview: null,
                    skippedAi: true,
                };
            }
        }
    }

    if (messageLooksLikeOrder(input.message)) {
        const { buildOrderCommunicationReply } = await import("./orderPartnerAvailability.service");
        const orderComms = await buildOrderCommunicationReply({
            familyId: input.familyId,
            actorUserId: input.recipientUserId,
            message: input.message,
        });
        if (orderComms) {
            return {
                reply: await stampCompanionVoice(orderComms, {
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                }),
                replySource: "orderComms",
                conversationId,
                order: null,
                orderFlow: null,
                orderPreview: null,
                skippedAi: true,
            };
        }

        const { tryStartOrderFromMessage } = await import("./orderKernel.service");
        const kernel = await tryStartOrderFromMessage({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.recipientUserId,
            message: input.message,
            saheliSessionId: input.sessionId,
        });
        if (kernel) {
            return {
                reply: await stampCompanionVoice(kernel.reply, {
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                }),
                replySource: "kernelFallback",
                conversationId,
                order: null,
                orderFlow: kernel.orderFlow ?? null,
                orderPreview: null,
                skippedAi: true,
                guardAction: "order_kernel_first",
            };
        }
    }

    const ai = await input.runAi();
    reply = ai.reply;
    conversationId = ai.conversationId;
    order = ai.orderFromAgent ?? null;
    orderPreview = ai.orderPreview ?? null;
    orderFlow = ai.orderFlow ?? null;
    toolTrace = ai.toolTrace;
    replySource = "ai";

    const guarded = await guardElderReply({
        message: input.message,
        reply,
        replySource,
        orderFlow,
        toolTrace,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        displayName: input.displayName,
        sessionId: input.sessionId,
    });
    reply = guarded.reply;
    replySource = guarded.replySource;
    orderFlow = guarded.orderFlow ?? orderFlow;
    guardAction = guarded.guardAction;

    if (
        messageLooksLikeOrder(input.message) &&
        !orderFlow &&
        (replySource === "ai" || guarded.guardAction === "generic_order_blocked")
    ) {
        const { tryStartOrderFromMessage } = await import("./orderKernel.service");
        const kernel = await tryStartOrderFromMessage({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.recipientUserId,
            message: input.message,
            saheliSessionId: input.sessionId,
        });
        if (kernel) {
            reply = kernel.reply;
            orderFlow = kernel.orderFlow ?? null;
            replySource = "kernelFallback";
            guardAction = guardAction ?? "kernel_post_ai";
        }
    }

    return {
        reply,
        replySource,
        conversationId,
        order,
        orderFlow,
        orderPreview,
        guardAction,
    };
}

export async function resolveElderDashboardReply(input: {
    familyId: string;
    recipientUserId: string;
    displayName: string;
    message: string;
    contextBundle: SaheliContextBundle;
    conversationId: string;
    careActionReply: string | null;
    channel?: ChannelType;
    runAi: () => Promise<AiTurn>;
}): Promise<ElderPipelineResult> {
    if (input.careActionReply) {
        return {
            reply: await stampCompanionVoice(input.careActionReply, {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "careAction",
            conversationId: input.conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
        };
    }

    if (messageIsGreeting(input.message)) {
        return {
            reply: await stampCompanionVoice(buildGreetingReply(input.displayName), {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId: input.conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
            guardAction: "greeting",
        };
    }

    const scheduleReply = tryHandleElderScheduleQuery({
        message: input.message,
        context: input.contextBundle,
    });
    if (scheduleReply) {
        return {
            reply: await stampCompanionVoice(scheduleReply, {
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
            }),
            replySource: "scheduleFacts",
            conversationId: input.conversationId,
            order: null,
            orderFlow: null,
            orderPreview: null,
            skippedAi: true,
        };
    }

    const ai = await input.runAi();
    const guarded = await guardElderReply({
        message: input.message,
        reply: ai.reply,
        replySource: "ai",
        orderFlow: ai.orderFlow ?? null,
        toolTrace: ai.toolTrace,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        displayName: input.displayName,
    });

    return {
        reply: guarded.reply,
        replySource: guarded.replySource,
        conversationId: ai.conversationId,
        order: ai.orderFromAgent ?? null,
        orderFlow: guarded.orderFlow ?? ai.orderFlow ?? null,
        orderPreview: ai.orderPreview ?? null,
        guardAction: guarded.guardAction,
    };
}
