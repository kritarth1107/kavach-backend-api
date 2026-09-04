/**
 * Zepto MCP — thin wrapper over generic MCP partner service.
 */
import type { McpPartnerKey } from "../mcp/types";
import {
    completeMcpConnect,
    disconnectMcp,
    getMcpConnectionStatus,
    listMcpTools,
    placeMcpOrder,
    searchMcpProduct,
    startMcpConnect,
} from "../mcp/mcpClient.service";

const PARTNER: McpPartnerKey = "zepto";

export const getZeptoConnectionStatus = (familyId: string, userId: string) =>
    getMcpConnectionStatus(PARTNER, familyId, userId);

export const startZeptoConnect = (familyId: string, userId: string) =>
    startMcpConnect(PARTNER, familyId, userId);

export const completeZeptoConnect = (code: string, state: string) =>
    completeMcpConnect(code, state);

export const disconnectZepto = (familyId: string, userId: string) =>
    disconnectMcp(PARTNER, familyId, userId);

export const listZeptoTools = (familyId: string, userId: string) =>
    listMcpTools(PARTNER, familyId, userId);

export const searchZeptoProduct = (
    familyId: string,
    userId: string,
    query: string,
) => searchMcpProduct(PARTNER, familyId, userId, query);

export const placeZeptoOrderViaMcp = (input: {
    familyId: string;
    userId: string;
    items: Array<{ name: string; quantity: number }>;
    paymentMethod?: string;
}) =>
    placeMcpOrder({
        partner: PARTNER,
        familyId: input.familyId,
        userId: input.userId,
        items: input.items,
        paymentMethod: input.paymentMethod,
    });
