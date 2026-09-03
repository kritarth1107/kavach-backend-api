/**
 * Zepto adapter — uses official Zepto MCP when caregiver has connected OAuth;
 * falls back to mock for pilot/dev without connection.
 */
import {
    getZeptoConnectionStatus,
    placeZeptoOrderViaMcp,
    searchZeptoProduct,
} from "./zepto/mcpClient.service";

export type ZeptoLineItem = {
    name: string;
    quantity: number;
    unitPricePaise: number;
};

export type ZeptoOrderContext = {
    familyId?: string;
    actorUserId?: string;
    items: ZeptoLineItem[];
    deliveryAddress?: string;
};

export async function createZeptoOrder(input: ZeptoOrderContext) {
    if (input.familyId && input.actorUserId) {
        const status = await getZeptoConnectionStatus(input.familyId, input.actorUserId);
        if (status.connected) {
            const pricedItems = [];
            for (const item of input.items) {
                const search = await searchZeptoProduct(
                    input.familyId,
                    input.actorUserId,
                    item.name,
                );
                const hit = search.items[0];
                pricedItems.push({
                    ...item,
                    unitPricePaise: hit?.pricePaise ?? item.unitPricePaise,
                });
            }
            const partnerRef = `zepto-mcp-suggest-${Date.now()}`;
            return {
                partnerRef,
                deepLink: "https://www.zeptonow.com/",
                status: "awaiting_approval" as const,
                pricedItems,
                source: "zepto_mcp" as const,
            };
        }
    }

    const partnerRef = `zepto-mock-${Date.now()}`;
    return {
        partnerRef,
        deepLink: "https://www.zeptonow.com/",
        status: "awaiting_approval" as const,
        pricedItems: input.items,
        source: "mock" as const,
    };
}

export async function payZeptoOrder(input: {
    orderId: string;
    amountPaise: number;
    payerUserId: string;
    familyId?: string;
    items?: Array<{ name: string; quantity: number }>;
    paymentMethod?: string;
}) {
    if (input.familyId) {
        const status = await getZeptoConnectionStatus(input.familyId, input.payerUserId);
        if (status.connected && input.items?.length) {
            const placed = await placeZeptoOrderViaMcp({
                familyId: input.familyId,
                userId: input.payerUserId,
                items: input.items,
                paymentMethod: input.paymentMethod ?? "cod",
            });
            return {
                paymentId: placed.partnerRef,
                provider: "zepto_mcp",
                partnerRef: placed.partnerRef,
                deepLink: placed.deepLink,
                paymentLink: placed.paymentLink,
                markDelivered: !placed.paymentLink,
                rawSummary: placed.rawSummary,
            };
        }
    }

    return {
        paymentId: `pay-mock-${input.orderId.slice(0, 8)}`,
        provider: "mock",
        partnerRef: `zepto-paid-${Date.now()}`,
        markDelivered: true,
    };
}
