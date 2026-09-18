import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "./commerceConnection.service";
import { OrderPartner } from "../types/careRecord.types";
import { suggestOrder } from "./order.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { MCP_PARTNERS } from "../partners/mcp/partners";
import { searchMcpProduct, startMcpConnect } from "../partners/mcp/mcpClient.service";
import {
    listPartnerAddresses,
    refreshPartnerAddressesInBackground,
} from "./partnerAddress.service";

const GROCERY_KEYWORDS =
    /\b(grocery|groceries|instamart|doodh|milk|bread|atta|rice|dal|sabzi|vegetable|fruit|maggi|oil|ghee|paneer|curd|dahi|eggs|bread|shampoo|soap|detergent|toilet|tissue|snack|biscuit|tea|coffee|sugar|salt|onion|potato|tomato|banana|apple|orange juice|juice|water bottle|bisleri)\b/i;

const FOOD_KEYWORDS =
    /\b(food|khana|lunch|dinner|breakfast|restaurant|biryani|pizza|burger|swiggy|order food|hungry|khana mangao|thali|dosa|idli|paratha|chinese|north indian|south indian)\b/i;

const ORDER_INTENT =
    /\b(order|mangao|manga|bhej|deliver|delivery|lana|la do|chahiye|need|want|get me|bring)\b/i;

const PARTNER_NOISE =
    /\b(from|on|via|using|through)\s+(swiggy|instamart|zepto)\b|\b(swiggy|instamart|zepto)\s+(food|groceries|grocery|se|pe)\b/gi;

export type ParsedOrderLine = {
    name: string;
    quantity: number;
    unitPricePaise: number;
    matchedName?: string;
};

export type OrderChatResult =
    | {
          kind: "order";
          orderId: string;
          partner: OrderPartner;
          partnerLabel: string;
          totalPaise: number;
          items: Array<{ name: string; quantity: number; unitPricePaise?: number; matchedName?: string }>;
          status: string;
          source: "mock" | "zepto_mcp" | "swiggy_mcp" | "instamart_mcp";
          searchResults: Array<{ query: string; name: string; pricePaise?: number }>;
          addresses: Array<{
              id: string;
              label: string;
              line1: string;
              city?: string;
              pincode?: string;
              isDefault?: boolean;
          }>;
      }
    | {
          kind: "connect_required";
          partner: OrderPartner;
          partnerLabel: string;
          connectPartner: McpPartnerKey;
          connectUrl?: string | null;
          message: string;
      }
    | {
          kind: "prompt";
          partner: OrderPartner;
          partnerLabel: string;
          message: string;
      };

export function messageLooksLikeOrder(text: string): boolean {
    const t = text.trim();
    if (t.length < 8) return false;
    return ORDER_INTENT.test(t) || (GROCERY_KEYWORDS.test(t) && /\d|kg|litre|packet|pack|bottle/.test(t));
}

export function messageIsOrderIntentOnly(text: string): boolean {
    const cleaned = text
        .replace(PARTNER_NOISE, " ")
        .replace(ORDER_INTENT, " ")
        .replace(/\b(please|mujhe|for|mama|mummy|papa)\b/gi, " ")
        .trim();
    return messageLooksLikeOrder(text) && cleaned.length < 8;
}

function extractItems(text: string): ParsedOrderLine[] {
    const items: ParsedOrderLine[] = [];
    const normalized = text.replace(PARTNER_NOISE, " ").replace(/\s+/g, " ").trim();
    const segments = normalized.split(/[,;·\n]+| and /i);

    for (const seg of segments) {
        const bit = seg.trim();
        if (bit.length < 3) continue;
        if (/^(order|please|mujhe|from|on|via|swiggy|instamart|zepto)$/i.test(bit)) continue;

        const qtyMatch = bit.match(/^(\d+)\s*(x|×)?\s*(.+)$/i) || bit.match(/^(.+?)\s+x\s*(\d+)$/i);
        if (qtyMatch) {
            const qty = Number(qtyMatch[1] || qtyMatch[2]) || 1;
            const name = (qtyMatch[3] || qtyMatch[1] || bit)
                .replace(/^(order|please|mujhe|mama ko|for mama)\s+/i, "")
                .trim();
            if (name.length >= 2 && !/^(from|swiggy|instamart|zepto)$/i.test(name)) {
                items.push({ name: name.slice(0, 120), quantity: Math.min(qty, 20), unitPricePaise: 5000 });
            }
            continue;
        }

        if (GROCERY_KEYWORDS.test(bit) || FOOD_KEYWORDS.test(bit)) {
            const cleaned = bit
                .replace(/^(order|please|mujhe|mama ko|for mama|get|bring)\s+/i, "")
                .trim();
            if (cleaned.length >= 2 && !/^(from|swiggy|instamart|zepto)$/i.test(cleaned)) {
                items.push({ name: cleaned.slice(0, 120), quantity: 1, unitPricePaise: 5000 });
            }
        }
    }

    return items.slice(0, 8);
}

export async function pickOrderPartner(
    message: string,
    familyId: string,
    actorUserId: string,
): Promise<OrderPartner> {
    const wantsFood = FOOD_KEYWORDS.test(message) && !GROCERY_KEYWORDS.test(message);
    const wantsGrocery = GROCERY_KEYWORDS.test(message) || !wantsFood;

    const connected = await listFamilyConnectedPartners(familyId, actorUserId);

    if (wantsGrocery && connected.instamart) return OrderPartner.INSTAMART;
    if (wantsFood && connected.swiggy) return OrderPartner.SWIGGY;
    if (connected.instamart && wantsGrocery) return OrderPartner.INSTAMART;
    if (connected.swiggy) return OrderPartner.SWIGGY;
    if (connected.instamart) return OrderPartner.INSTAMART;
    if (connected.zepto) return OrderPartner.ZEPTO;
    if (wantsGrocery) return OrderPartner.INSTAMART;
    if (wantsFood) return OrderPartner.SWIGGY;
    return OrderPartner.ZEPTO;
}

function partnerToMcp(partner: OrderPartner): McpPartnerKey | null {
    if (partner === OrderPartner.ZEPTO) return "zepto";
    if (partner === OrderPartner.SWIGGY) return "swiggy";
    if (partner === OrderPartner.INSTAMART) return "instamart";
    return null;
}

export function partnerLabel(partner: OrderPartner): string {
    if (partner === OrderPartner.SWIGGY) return "Swiggy Food";
    if (partner === OrderPartner.INSTAMART) return "Instamart";
    return "Zepto";
}

function connectChatMessage(partner: OrderPartner, label: string): string {
    const mcp = partnerToMcp(partner);
    const hint = mcp ? MCP_PARTNERS[mcp].disconnectedDescription : "";
    const swiggyNote =
        partner === OrderPartner.INSTAMART
            ? " Instamart uses the same Swiggy phone login but is a separate connection from Swiggy Food."
            : partner === OrderPartner.SWIGGY
              ? " Swiggy Food and Instamart groceries are connected separately — connect Food here for restaurant orders."
              : "";
    return `Connect ${label} to place this order from Saheli.${swiggyNote}\n\n${hint}`.trim();
}

async function buildConnectResult(
    partner: OrderPartner,
    familyId: string,
    actorUserId: string,
): Promise<Extract<OrderChatResult, { kind: "connect_required" }>> {
    const mcpPartner = partnerToMcp(partner);
    const label = partnerLabel(partner);
    let connectUrl: string | null = null;

    if (mcpPartner) {
        try {
            const result = await startMcpConnect(mcpPartner, familyId, actorUserId);
            connectUrl = result.authorizationUrl;
        } catch (err) {
            console.warn(`MCP connect URL for ${mcpPartner} failed:`, err);
        }
    }

    return {
        kind: "connect_required",
        partner,
        partnerLabel: label,
        connectPartner: mcpPartner ?? "zepto",
        connectUrl,
        message: connectChatMessage(partner, label),
    };
}

async function enrichItemsFromMcp(
    mcpPartner: McpPartnerKey,
    familyId: string,
    commerceUserId: string,
    items: ParsedOrderLine[],
): Promise<{
    items: ParsedOrderLine[];
    searchResults: Array<{ query: string; name: string; pricePaise?: number }>;
    source: "zepto_mcp" | "swiggy_mcp" | "instamart_mcp";
}> {
    const searchResults: Array<{ query: string; name: string; pricePaise?: number }> = [];
    const enriched: ParsedOrderLine[] = [];

    for (const item of items) {
        try {
            const search = await searchMcpProduct(mcpPartner, familyId, commerceUserId, item.name);
            for (const hit of search.items.slice(0, 4)) {
                searchResults.push({
                    query: item.name,
                    name: hit.name,
                    pricePaise: hit.pricePaise,
                });
            }
            const best = search.items[0];
            enriched.push({
                ...item,
                matchedName: best?.name,
                unitPricePaise: best?.pricePaise ?? item.unitPricePaise,
            });
        } catch (err) {
            console.warn(`MCP search failed for ${item.name}:`, err);
            enriched.push(item);
        }
    }

    return {
        items: enriched,
        searchResults,
        source: `${mcpPartner}_mcp` as "zepto_mcp" | "swiggy_mcp" | "instamart_mcp",
    };
}

async function loadPartnerAddresses(
    familyId: string,
    mcpPartner: McpPartnerKey,
    commerceUserId: string,
) {
    void refreshPartnerAddressesInBackground(mcpPartner, familyId, commerceUserId);
    const rows = await listPartnerAddresses(familyId, mcpPartner);
    return rows
        .filter((row) => row.partner === mcpPartner)
        .map((row) => ({
            id: row.partner_address_id,
            label: row.label || "Saved address",
            line1: row.line1,
            city: row.city || undefined,
            pincode: row.pincode || undefined,
            isDefault: row.is_default,
        }));
}

export function serializeOrderChatForClient(result: OrderChatResult | null): {
    order?: Extract<OrderChatResult, { kind: "order" }>;
    connect?: Extract<OrderChatResult, { kind: "connect_required" }>;
} {
    if (!result) return {};
    if (result.kind === "order") return { order: result };
    if (result.kind === "connect_required") return { connect: result };
    return {};
}

export async function maybeSuggestOrderFromChat(input: {
    familyId: string;
    subjectUserId: string;
    actorUserId: string;
    message: string;
}): Promise<OrderChatResult | null> {
    if (!messageLooksLikeOrder(input.message)) return null;

    const partner = await pickOrderPartner(input.message, input.familyId, input.actorUserId);
    const mcpPartner = partnerToMcp(partner);
    const connected = await listFamilyConnectedPartners(input.familyId, input.actorUserId);
    const isConnected =
        (partner === OrderPartner.SWIGGY && connected.swiggy) ||
        (partner === OrderPartner.INSTAMART && connected.instamart) ||
        (partner === OrderPartner.ZEPTO && connected.zepto);

    if (!isConnected) {
        return buildConnectResult(partner, input.familyId, input.actorUserId);
    }

    if (messageIsOrderIntentOnly(input.message)) {
        const label = partnerLabel(partner);
        return {
            kind: "prompt",
            partner,
            partnerLabel: label,
            message: `Sure — tell me what you'd like from ${label}. For example: "2 dal makhani and roti" or "1L milk and bread".`,
        };
    }

    const items = extractItems(input.message);
    if (!items.length) return null;

    const commerceUserId =
        (mcpPartner
            ? await resolveFamilyMcpUserId(input.familyId, mcpPartner, input.actorUserId)
            : null) ?? input.actorUserId;

    let pricedItems = items;
    let searchResults: Array<{ query: string; name: string; pricePaise?: number }> = [];
    let source: "mock" | "zepto_mcp" | "swiggy_mcp" | "instamart_mcp" = "mock";
    let addresses: Array<{
        id: string;
        label: string;
        line1: string;
        city?: string;
        pincode?: string;
        isDefault?: boolean;
    }> = [];

    if (mcpPartner && isConnected) {
        const enriched = await enrichItemsFromMcp(
            mcpPartner,
            input.familyId,
            commerceUserId,
            items,
        );
        pricedItems = enriched.items;
        searchResults = enriched.searchResults;
        source = enriched.source;
        addresses = await loadPartnerAddresses(input.familyId, mcpPartner, commerceUserId);
    }

    const order = await suggestOrder({
        familyId: input.familyId,
        subjectUserId: input.subjectUserId,
        actorUserId: input.actorUserId,
        commerceUserId,
        items: pricedItems,
        partner,
        notes: input.message.slice(0, 500),
    });

    return {
        kind: "order",
        orderId: order.orderId,
        partner,
        partnerLabel: partnerLabel(partner),
        totalPaise: order.totalPaise,
        items: order.items.map((item, idx) => ({
            name: item.name,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            matchedName: pricedItems[idx]?.matchedName,
        })),
        status: order.status,
        source,
        searchResults,
        addresses,
    };
}
