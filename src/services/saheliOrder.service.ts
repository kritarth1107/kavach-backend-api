import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "./commerceConnection.service";
import { OrderPartner } from "../types/careRecord.types";
import { suggestOrder } from "./order.service";
import type { McpPartnerKey } from "../partners/mcp/types";

const GROCERY_KEYWORDS =
    /\b(grocery|groceries|instamart|doodh|milk|bread|atta|rice|dal|sabzi|vegetable|fruit|maggi|oil|ghee|paneer|curd|dahi|eggs|bread|shampoo|soap|detergent|toilet|tissue|snack|biscuit|tea|coffee|sugar|salt|onion|potato|tomato|banana|apple|orange juice|juice|water bottle|bisleri)\b/i;

const FOOD_KEYWORDS =
    /\b(food|khana|lunch|dinner|breakfast|restaurant|biryani|pizza|burger|swiggy|order food|hungry|khana mangao|thali|dosa|idli|paratha|chinese|north indian|south indian)\b/i;

const ORDER_INTENT =
    /\b(order|mangao|manga|bhej|deliver|delivery|lana|la do|chahiye|need|want|get me|bring)\b/i;

export type ParsedOrderLine = {
    name: string;
    quantity: number;
    unitPricePaise: number;
};

export function messageLooksLikeOrder(text: string): boolean {
    const t = text.trim();
    if (t.length < 8) return false;
    return ORDER_INTENT.test(t) || (GROCERY_KEYWORDS.test(t) && /\d|kg|litre|packet|pack|bottle/.test(t));
}

function extractItems(text: string): ParsedOrderLine[] {
    const items: ParsedOrderLine[] = [];
    const segments = text.split(/[,;·\n]+| and /i);
    for (const seg of segments) {
        const bit = seg.trim();
        if (bit.length < 3) continue;
        const qtyMatch = bit.match(/^(\d+)\s*(x|×)?\s*(.+)$/i) || bit.match(/^(.+?)\s+x\s*(\d+)$/i);
        if (qtyMatch) {
            const qty = Number(qtyMatch[1] || qtyMatch[2]) || 1;
            const name = (qtyMatch[3] || qtyMatch[1] || bit).replace(/^(order|please|mujhe|mama ko|for mama)\s+/i, "").trim();
            if (name.length >= 2) {
                items.push({ name: name.slice(0, 120), quantity: Math.min(qty, 20), unitPricePaise: 5000 });
            }
            continue;
        }
        if (GROCERY_KEYWORDS.test(bit) || FOOD_KEYWORDS.test(bit)) {
            const cleaned = bit
                .replace(/^(order|please|mujhe|mama ko|for mama|get|bring)\s+/i, "")
                .trim();
            if (cleaned.length >= 2) {
                items.push({ name: cleaned.slice(0, 120), quantity: 1, unitPricePaise: 5000 });
            }
        }
    }
    if (!items.length && ORDER_INTENT.test(text)) {
        const fallback = text
            .replace(/.*\b(order|mangao|manga|chahiye)\b[:\s]*/i, "")
            .trim()
            .slice(0, 120);
        if (fallback.length >= 3) {
            items.push({ name: fallback, quantity: 1, unitPricePaise: 5000 });
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

export async function maybeSuggestOrderFromChat(input: {
    familyId: string;
    subjectUserId: string;
    actorUserId: string;
    message: string;
}) {
    if (!messageLooksLikeOrder(input.message)) return null;

    const items = extractItems(input.message);
    if (!items.length) return null;

    const partner = await pickOrderPartner(input.message, input.familyId, input.actorUserId);
    const mcpPartner = partnerToMcp(partner);
    const commerceUserId =
        (mcpPartner
            ? await resolveFamilyMcpUserId(input.familyId, mcpPartner, input.actorUserId)
            : null) ?? input.actorUserId;

    const order = await suggestOrder({
        familyId: input.familyId,
        subjectUserId: input.subjectUserId,
        actorUserId: input.actorUserId,
        commerceUserId,
        items,
        partner,
        notes: input.message.slice(0, 500),
    });

    return {
        orderId: order.orderId,
        partner,
        partnerLabel: partnerLabel(partner),
        totalPaise: order.totalPaise,
        items: order.items,
        status: order.status,
    };
}
