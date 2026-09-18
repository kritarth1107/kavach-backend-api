import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "./commerceConnection.service";
import { OrderPartner } from "../types/careRecord.types";
import { suggestOrder } from "./order.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { MCP_PARTNERS } from "../partners/mcp/partners";
import { searchMcpProduct, startMcpConnect } from "../partners/mcp/mcpClient.service";
import {
    ensurePartnerAddressesSynced,
    listPartnerAddresses,
} from "./partnerAddress.service";

const GROCERY_KEYWORDS =
    /\b(grocery|groceries|instamart|doodh|milk|bread|atta|rice|dal|sabzi|vegetable|fruit|maggi|oil|ghee|paneer|curd|dahi|eggs|bread|shampoo|soap|detergent|toilet|tissue|snack|biscuit|tea|coffee|sugar|salt|onion|potato|tomato|banana|apple|orange juice|juice|water bottle|bisleri)\b/i;

const FOOD_KEYWORDS =
    /\b(food|khana|lunch|dinner|breakfast|restaurant|biryani|pizza|pasta|burger|sandwich|noodles|momos|wrap|swiggy|order food|hungry|khana mangao|thali|dosa|idli|paratha|chinese|north indian|south indian)\b/i;

const ORDER_INTENT =
    /\b(order|mangao|manga|bhej|deliver|delivery|lana|la do|chahiye|need|want|get me|bring)\b/i;

const PARTNER_NOISE =
    /\b(from|on|via|using|through)\s+(swiggy|instamart|zepto)\b|\b(swiggy|instamart|zepto)\s+(food|groceries|grocery|se|pe)\b/gi;

const FOOD_QUERY_STOP =
    /\b(i|we|me|my|want|to|eat|order|get|have|some|please|food|khana|the|a|an|would|like|need|bring|mujhe|hungry|craving|feel)\b/gi;

const ADDRESS_FOLLOWUP =
    /\b(address|addr|location|delivery|deliver to|home|office)\b/i;

const ADDRESS_ACTION =
    /\b(check|added|add|have|saved|save|see|confirm|verify|show|which|where|my|list)\b/i;

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
          searchResults: Array<{
              query: string;
              name: string;
              pricePaise?: number;
              kind?: "restaurant" | "dish" | "product";
              restaurantName?: string;
              restaurantId?: string;
          }>;
          addresses: Array<{
              id: string;
              label: string;
              line1: string;
              city?: string;
              pincode?: string;
              isDefault?: boolean;
          }>;
          addressNote?: string;
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
    if (t.length < 6) return false;
    if (messageIsAddressFollowUp(t)) return true;
    return (
        ORDER_INTENT.test(t) ||
        (GROCERY_KEYWORDS.test(t) && /\d|kg|litre|packet|pack|bottle/.test(t)) ||
        /\b(want to eat|feel like eating|craving|hungry for)\b/i.test(t) ||
        (FOOD_KEYWORDS.test(t) && /\b(want|eat|order|get|hungry|craving|like)\b/i.test(t))
    );
}

export function messageIsAddressFollowUp(text: string): boolean {
    const t = text.trim();
    return ADDRESS_FOLLOWUP.test(t) && ADDRESS_ACTION.test(t);
}

function normalizeOrderItemName(text: string): string {
    const cleaned = text
        .replace(PARTNER_NOISE, " ")
        .replace(FOOD_QUERY_STOP, " ")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.length >= 2 ? cleaned.slice(0, 120) : text.trim().slice(0, 120);
}

function formatAddressList(
    addresses: Array<{ label: string; line1: string; city?: string; pincode?: string }>,
): string {
    return addresses
        .map((addr, idx) => {
            const bits = [addr.label, addr.line1, addr.city, addr.pincode].filter(Boolean);
            return `${idx + 1}. ${bits.join(" · ")}`;
        })
        .join("\n");
}

export function messageIsOrderIntentOnly(text: string): boolean {
    if (!messageLooksLikeOrder(text)) return false;
    // "order pizza", "get biryani" etc. already name a dish — not intent-only.
    if (extractItems(text).length > 0) return false;
    const cleaned = text
        .replace(PARTNER_NOISE, " ")
        .replace(ORDER_INTENT, " ")
        .replace(FOOD_KEYWORDS, " ")
        .replace(GROCERY_KEYWORDS, " ")
        .replace(/\b(please|mujhe|for|mama|mummy|papa)\b/gi, " ")
        .trim();
    return cleaned.length < 4;
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

        if (GROCERY_KEYWORDS.test(bit) || FOOD_KEYWORDS.test(bit) || ORDER_INTENT.test(bit)) {
            const cleaned = normalizeOrderItemName(bit);
            if (cleaned.length >= 2 && !/^(from|swiggy|instamart|zepto)$/i.test(cleaned)) {
                items.push({ name: cleaned, quantity: 1, unitPricePaise: 5000 });
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

function pickCatalogHitForLine(
    hits: Array<{
        kind?: "restaurant" | "dish" | "product";
        name: string;
        matchedName?: string;
        pricePaise?: number;
    }>,
    mcpPartner: McpPartnerKey,
) {
    if (mcpPartner === "swiggy") {
        return (
            hits.find((h) => h.kind === "dish" && h.pricePaise) ??
            hits.find((h) => h.kind === "dish") ??
            undefined
        );
    }
    return (
        hits.find((h) => (h.kind === "product" || h.kind === "dish") && h.pricePaise) ??
        hits.find((h) => h.pricePaise) ??
        hits.find((h) => h.kind === "product" || h.kind === "dish")
    );
}

async function enrichItemsFromMcp(
    mcpPartner: McpPartnerKey,
    familyId: string,
    commerceUserId: string,
    items: ParsedOrderLine[],
    addressId?: string,
): Promise<{
    items: ParsedOrderLine[];
    searchResults: Array<{
        query: string;
        name: string;
        pricePaise?: number;
        kind?: "restaurant" | "dish" | "product";
        restaurantName?: string;
        restaurantId?: string;
    }>;
    source: "zepto_mcp" | "swiggy_mcp" | "instamart_mcp";
    catalogFound: boolean;
}> {
    const searchResults: Array<{
        query: string;
        name: string;
        pricePaise?: number;
        kind?: "restaurant" | "dish" | "product";
        restaurantName?: string;
        restaurantId?: string;
    }> = [];
    const enriched: ParsedOrderLine[] = [];
    let catalogFound = false;

    for (const item of items) {
        try {
            const search = await searchMcpProduct(mcpPartner, familyId, commerceUserId, item.name, {
                addressId,
            });
            for (const hit of search.items.slice(0, 6)) {
                searchResults.push({
                    query: item.name,
                    name: hit.matchedName ?? hit.name,
                    pricePaise: hit.pricePaise,
                    kind: hit.kind,
                    restaurantName: hit.restaurantName,
                    restaurantId: hit.restaurantId,
                });
            }
            const best = pickCatalogHitForLine(search.items, mcpPartner);
            const hasRestaurantOptions = search.items.some((h) => h.kind === "restaurant");
            if ((best?.pricePaise && best.kind !== "restaurant") || hasRestaurantOptions) {
                catalogFound = true;
            }
            enriched.push({
                ...item,
                matchedName: best?.matchedName ?? best?.name,
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
        catalogFound,
    };
}

async function loadPartnerAddresses(
    familyId: string,
    mcpPartner: McpPartnerKey,
    commerceUserId: string,
) {
    await ensurePartnerAddressesSynced(mcpPartner, familyId, commerceUserId);
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

async function maybeAddressStatusFromChat(input: {
    familyId: string;
    actorUserId: string;
    message: string;
}): Promise<OrderChatResult | null> {
    if (!messageIsAddressFollowUp(input.message)) return null;

    const connected = await listFamilyConnectedPartners(input.familyId, input.actorUserId);
    const partner = connected.swiggy
        ? OrderPartner.SWIGGY
        : connected.instamart
          ? OrderPartner.INSTAMART
          : connected.zepto
            ? OrderPartner.ZEPTO
            : null;
    if (!partner) return null;

    const mcpPartner = partnerToMcp(partner);
    if (!mcpPartner) return null;

    const commerceUserId =
        (await resolveFamilyMcpUserId(input.familyId, mcpPartner, input.actorUserId)) ??
        input.actorUserId;
    const addresses = await loadPartnerAddresses(input.familyId, mcpPartner, commerceUserId);
    const label = partnerLabel(partner);

    if (!addresses.length) {
        return {
            kind: "prompt",
            partner,
            partnerLabel: label,
            message: `I checked your linked ${label} account — no saved delivery addresses yet. Add one in the Swiggy app (same phone login), then tell me what to order — e.g. "pizza to Home".`,
        };
    }

    return {
        kind: "prompt",
        partner,
        partnerLabel: label,
        message: `I pulled ${addresses.length} saved ${label} address${addresses.length === 1 ? "" : "es"} from your account:\n\n${formatAddressList(addresses)}\n\nTell me what you'd like — e.g. "margherita pizza" — and pick the delivery address in the order card before approving.`,
    };
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
    const addressStatus = await maybeAddressStatusFromChat(input);
    if (addressStatus) return addressStatus;

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
    let searchResults: Array<{
        query: string;
        name: string;
        pricePaise?: number;
        kind?: "restaurant" | "dish" | "product";
        restaurantName?: string;
        restaurantId?: string;
    }> = [];
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
        addresses = await loadPartnerAddresses(input.familyId, mcpPartner, commerceUserId);
        const defaultAddressId = addresses.find((a) => a.isDefault)?.id ?? addresses[0]?.id;
        const enriched = await enrichItemsFromMcp(
            mcpPartner,
            input.familyId,
            commerceUserId,
            items,
            defaultAddressId,
        );
        pricedItems = enriched.items;
        searchResults = enriched.searchResults;
        source = enriched.source;

        if (!addresses.length) {
            const label = partnerLabel(partner);
            return {
                kind: "prompt",
                partner,
                partnerLabel: label,
                message: `Your ${label} account is connected but I couldn't find any saved delivery addresses. Add one in the Swiggy app, then try again — e.g. "pizza" or "biryani from Meghana".`,
            };
        }

        const hasRestaurants = searchResults.some((h) => h.kind === "restaurant");
        if (!enriched.catalogFound && hasRestaurants) {
            for (const item of pricedItems) {
                if (!item.unitPricePaise || item.unitPricePaise === 5000) {
                    const restHit = searchResults.find((h) => h.kind === "restaurant" && h.pricePaise);
                    if (restHit?.pricePaise) {
                        item.unitPricePaise = restHit.pricePaise;
                        item.matchedName = restHit.name;
                    }
                }
            }
        }

        if (!enriched.catalogFound && !hasRestaurants) {
            const label = partnerLabel(partner);
            return {
                kind: "prompt",
                partner,
                partnerLabel: label,
                message: `I checked ${label} for your saved addresses (${addresses.length} on file) but couldn't find matching restaurants or dishes for that request. Try a specific dish — e.g. "margherita pizza" or "biryani from Meghana".`,
            };
        }
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

    const addressNote =
        addresses.length > 1
            ? `\n\nPick which delivery address to use (${addresses.length} saved on Swiggy) before approving.`
            : addresses.length === 1
              ? `\n\nDelivering to: ${addresses[0].label} · ${addresses[0].line1}.`
              : "";

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
        addressNote,
    };
}
