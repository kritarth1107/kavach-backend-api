import type { OrderFlowPayload } from "./orderOrchestrator.service";
import { messageLooksLikeOrder } from "./saheliOrder.service";
import {
    buildCasualOfferReply,
    messageIsCasualOffer,
} from "./saheliElderFacts.service";
import type { SaheliReplySource } from "./whatsappWebhookLog.service";

const GENERIC_ORDER_PATTERNS = [
    /tell me what to order/i,
    /what would you like to order/i,
    /what do you want to order/i,
    /order from where/i,
    /from swiggy, instamart, or zepto/i,
];

const ORDER_TOOL_NAMES = new Set([
    "resolve_order_partner",
    "ensure_order_session",
    "search_catalog",
    "add_to_order_cart",
    "get_order_cart",
    "submit_order_cart",
    "select_order_address",
    "list_partner_addresses",
    "resolve_catalog_item",
]);

export type ElderReplyGuardInput = {
    message: string;
    reply: string;
    replySource: SaheliReplySource;
    orderFlow?: OrderFlowPayload | null;
    toolTrace?: Array<{ tool: string; status?: string }>;
    familyId: string;
    recipientUserId: string;
    displayName: string;
    sessionId?: string;
};

export type ElderReplyGuardResult = {
    reply: string;
    replySource: SaheliReplySource;
    orderFlow?: OrderFlowPayload | null;
    guardAction?: string;
};

function hasOrderToolTrace(toolTrace?: Array<{ tool: string }>): boolean {
    return Boolean(toolTrace?.some((row) => ORDER_TOOL_NAMES.has(row.tool)));
}

function looksLikeGenericOrderFallback(reply: string): boolean {
    return GENERIC_ORDER_PATTERNS.some((re) => re.test(reply));
}

function replyInventsPrice(reply: string, hadOrderTools: boolean): boolean {
    if (hadOrderTools || !/₹\s?\d+/.test(reply)) return false;
    return true;
}

function replyLooksLikeOrderWhenCasual(message: string, reply: string): boolean {
    if (!messageIsCasualOffer(message)) return false;
    return messageLooksLikeOrder(reply) || /\border\b.*\b(swiggy|instamart|zepto)\b/i.test(reply);
}

export async function guardElderReply(
    input: ElderReplyGuardInput,
): Promise<ElderReplyGuardResult> {
    let { reply, replySource, orderFlow } = input;

    if (replyLooksLikeOrderWhenCasual(input.message, reply)) {
        return {
            reply: buildCasualOfferReply(input.displayName),
            replySource: "scheduleFacts",
            orderFlow: null,
            guardAction: "blocked_casual_order_hallucination",
        };
    }

    if (messageIsCasualOffer(input.message) && replySource === "ai") {
        return {
            reply: buildCasualOfferReply(input.displayName),
            replySource: "scheduleFacts",
            orderFlow: null,
            guardAction: "casual_offer_facts",
        };
    }

    const hadOrderTools = hasOrderToolTrace(input.toolTrace);
    const orderLike = messageLooksLikeOrder(input.message);
    const asksExactBill =
        /\b(last\s+bill|bill\s+exact|exact(ly)?|how\s+much)\b/i.test(input.message) &&
        /\b(bill|order|paid|cost|price|total)\b/i.test(input.message);

    if (asksExactBill && replyInventsPrice(reply, hadOrderTools) && !orderFlow) {
        return {
            reply:
                "I don't invent bill amounts. Check the dashboard or ask your caregiver for the exact saved total.",
            replySource: "scheduleFacts",
            orderFlow: null,
            guardAction: "invented_bill_blocked",
        };
    }

    if (
        orderLike &&
        replySource === "ai" &&
        !orderFlow &&
        replyInventsPrice(reply, hadOrderTools)
    ) {
        return {
            reply: "I couldn't start that order just now — please try again in a moment, or say exactly what you'd like (e.g. order milk from instamart).",
            replySource: "kernelFallback",
            orderFlow: null,
            guardAction: "invented_price_blocked",
        };
    }

    if (
        orderLike &&
        replySource === "ai" &&
        !orderFlow &&
        (looksLikeGenericOrderFallback(reply) ||
            (!hadOrderTools && reply.length > 0 && !/don't see|not connected|timed out/i.test(reply)))
    ) {
        const { buildOrderCommunicationReply } = await import("./orderPartnerAvailability.service");
        const orderComms = await buildOrderCommunicationReply({
            familyId: input.familyId,
            actorUserId: input.recipientUserId,
            message: input.message,
        });
        if (orderComms) {
            return {
                reply: orderComms,
                replySource: "orderComms",
                orderFlow: null,
                guardAction: "order_comms_from_guard",
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
                reply: kernel.reply,
                replySource: "kernelFallback",
                orderFlow: kernel.orderFlow ?? null,
                guardAction: "kernel_from_guard",
            };
        }

        if (looksLikeGenericOrderFallback(reply)) {
            return {
                reply: "I couldn't start that order just now — please try again in a moment, or say exactly what you'd like (e.g. order milk from instamart).",
                replySource: "kernelFallback",
                orderFlow: null,
                guardAction: "generic_order_blocked",
            };
        }
    }

    if (orderFlow?.sessionId && replySource === "ai") {
        const flowMessage = orderFlow.message?.trim();
        if (flowMessage) {
            return {
                reply: flowMessage,
                replySource: "kernelFallback",
                orderFlow,
                guardAction: "order_flow_message_only",
            };
        }
    }

    return { reply, replySource, orderFlow: orderFlow ?? null };
}
