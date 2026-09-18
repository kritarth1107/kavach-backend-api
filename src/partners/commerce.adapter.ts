/**
 * Commerce adapters — route order placement to the correct MCP partner.
 */
import type { McpPartnerKey } from "./mcp/types";
import { getMcpConnectionStatus, placeMcpOrder, searchMcpProduct } from "./mcp/mcpClient.service";
import { getMcpPartner } from "./mcp/partners";
import { OrderPartner } from "../types/careRecord.types";
import { resolveFamilyMcpUserId } from "../services/commerceConnection.service";
import { getDefaultPartnerAddressId } from "../services/partnerAddress.service";
import config from "../config/app.config";

export type CommerceLineItem = {
    name: string;
    quantity: number;
    unitPricePaise: number;
};

export type CommerceOrderContext = {
    partner: OrderPartner;
    familyId?: string;
    actorUserId?: string;
    items: CommerceLineItem[];
    deliveryAddress?: string;
};

function orderPartnerToMcp(partner: OrderPartner): McpPartnerKey | null {
    if (partner === OrderPartner.ZEPTO) return "zepto";
    if (partner === OrderPartner.SWIGGY) return "swiggy";
    if (partner === OrderPartner.INSTAMART) return "instamart";
    return null;
}

function isProduction(): boolean {
    return config.server.env === "production";
}

export async function createCommerceOrder(input: CommerceOrderContext) {
    const mcpPartner = orderPartnerToMcp(input.partner);
    const partnerConfig = mcpPartner ? getMcpPartner(mcpPartner) : null;

    if (input.familyId && input.actorUserId && mcpPartner) {
        const mcpUserId = await resolveFamilyMcpUserId(
            input.familyId,
            mcpPartner,
            input.actorUserId,
        );
        const status = mcpUserId
            ? await getMcpConnectionStatus(mcpPartner, input.familyId, mcpUserId)
            : { connected: false };
        if (status.connected && mcpUserId) {
            const addressId = await getDefaultPartnerAddressId(
                input.familyId,
                mcpPartner,
                mcpUserId,
            );
            const pricedItems = [];
            for (const item of input.items) {
                const search = await searchMcpProduct(
                    mcpPartner,
                    input.familyId,
                    mcpUserId,
                    item.name,
                    { addressId: addressId ?? undefined },
                );
                if (search.error === "no_address") {
                    throw new Error(
                        `Connect ${input.partner} and sync a delivery address before ordering.`,
                    );
                }
                const hit =
                    mcpPartner === "swiggy"
                        ? (search.items.find((row) => row.kind === "dish" && row.pricePaise) ??
                          search.items.find((row) => row.kind === "dish"))
                        : (search.items.find((row) => row.kind === "product" && row.pricePaise) ??
                          search.items.find((row) => row.pricePaise));
                if (!hit?.pricePaise) {
                    throw new Error(
                        `No live MCP price for "${item.name}". Search the catalog and pick a listed item.`,
                    );
                }
                pricedItems.push({
                    ...item,
                    unitPricePaise: hit.pricePaise,
                });
            }
            return {
                partnerRef: `${mcpPartner}-mcp-suggest-${Date.now()}`,
                deepLink: partnerConfig?.deepLink ?? "https://www.swiggy.com/",
                status: "awaiting_approval" as const,
                pricedItems,
                source: `${mcpPartner}_mcp` as const,
            };
        }

        if (isProduction()) {
            throw new Error(
                `${input.partner} is not connected. Open Integrations and connect ${partnerConfig?.label ?? input.partner} first.`,
            );
        }
    }

    if (isProduction()) {
        throw new Error("Commerce partner is not configured for live ordering.");
    }

    const label = input.partner;
    return {
        partnerRef: `${label}-mock-${Date.now()}`,
        deepLink: partnerConfig?.deepLink ?? "https://www.swiggy.com/",
        status: "awaiting_approval" as const,
        pricedItems: input.items,
        source: "mock" as const,
    };
}

export async function payCommerceOrder(input: {
    partner: OrderPartner;
    orderId: string;
    amountPaise: number;
    payerUserId: string;
    familyId?: string;
    items?: Array<{ name: string; quantity: number }>;
    paymentMethod?: string;
    addressId?: string;
}) {
    const mcpPartner = orderPartnerToMcp(input.partner);

    if (input.familyId && mcpPartner) {
        const mcpUserId = await resolveFamilyMcpUserId(
            input.familyId,
            mcpPartner,
            input.payerUserId,
        );
        const status = mcpUserId
            ? await getMcpConnectionStatus(mcpPartner, input.familyId, mcpUserId)
            : { connected: false };
        if (status.connected && mcpUserId && input.items?.length) {
            const addressId =
                input.addressId ??
                (await getDefaultPartnerAddressId(input.familyId, mcpPartner, mcpUserId));
            const placed = await placeMcpOrder({
                partner: mcpPartner,
                familyId: input.familyId,
                userId: mcpUserId,
                items: input.items,
                paymentMethod: input.paymentMethod ?? "COD",
                addressId,
            });
            return {
                paymentId: placed.partnerRef,
                provider: `${mcpPartner}_mcp`,
                partnerRef: placed.partnerRef,
                deepLink: placed.deepLink,
                paymentLink: placed.paymentLink,
                markDelivered: !placed.paymentLink,
                rawSummary: placed.rawSummary,
            };
        }

        if (isProduction()) {
            throw new Error(`${input.partner} MCP is not connected for checkout.`);
        }
    }

    if (isProduction()) {
        throw new Error("Cannot place mock payment in production.");
    }

    return {
        paymentId: `pay-mock-${input.orderId.slice(0, 8)}`,
        provider: "mock",
        partnerRef: `${input.partner}-paid-${Date.now()}`,
        markDelivered: true,
    };
}
