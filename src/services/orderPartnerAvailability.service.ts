import { searchMcpProduct } from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { OrderPartner } from "../types/careRecord.types";
import { listFamilyConnectedPartners, resolveFamilyMcpUserId } from "./commerceConnection.service";
import { ensurePartnerAddressesSynced, listPartnerAddresses } from "./partnerAddress.service";
import {
    extractOrderQuery,
    normalizeOrderText,
    parseExplicitPartner,
    partnerLabel,
    pickOrderPartner,
} from "./saheliOrder.service";

export type PartnerAvailabilityRow = {
    partner: McpPartnerKey;
    label: string;
    connected: boolean;
    serviceable: boolean;
    reason?: string;
};

function orderPartnerToMcp(partner: OrderPartner): McpPartnerKey | null {
    if (partner === OrderPartner.SWIGGY) return "swiggy";
    if (partner === OrderPartner.INSTAMART) return "instamart";
    if (partner === OrderPartner.ZEPTO) return "zepto";
    return null;
}

async function probeSwiggyServiceability(
    familyId: string,
    actorUserId: string,
): Promise<{ serviceable: boolean; reason?: string }> {
    const userId = await resolveFamilyMcpUserId(familyId, "swiggy", actorUserId);
    if (!userId) return { serviceable: false, reason: "not_connected" };

    await ensurePartnerAddressesSynced("swiggy", familyId, userId);
    const addresses = await listPartnerAddresses(familyId, "swiggy", userId);
    const addressId =
        addresses.find((a) => a.is_default)?.partner_address_id ?? addresses[0]?.partner_address_id;
    if (!addressId) return { serviceable: false, reason: "no_address" };

    try {
        const search = await searchMcpProduct("swiggy", familyId, userId, "food", { addressId });
        if (search.error === "no_address") {
            return { serviceable: false, reason: "no_address" };
        }
        const hasHits = search.items.some((h) => h.kind === "restaurant" || h.kind === "dish");
        if (!hasHits) {
            return {
                serviceable: false,
                reason: "closed_or_unavailable",
            };
        }
        return { serviceable: true };
    } catch {
        return { serviceable: false, reason: "probe_failed" };
    }
}

export async function getOrderPartnerAvailability(
    familyId: string,
    actorUserId: string,
): Promise<PartnerAvailabilityRow[]> {
    const connected = await listFamilyConnectedPartners(familyId, actorUserId);
    const rows: PartnerAvailabilityRow[] = [];

    for (const partner of ["swiggy", "instamart", "zepto"] as McpPartnerKey[]) {
        const orderPartner =
            partner === "swiggy"
                ? OrderPartner.SWIGGY
                : partner === "instamart"
                  ? OrderPartner.INSTAMART
                  : OrderPartner.ZEPTO;
        const isConnected = connected[partner];
        let serviceable = isConnected;
        let reason: string | undefined;

        if (!isConnected) {
            serviceable = false;
            reason = "not_connected";
        } else if (partner === "swiggy") {
            const probe = await probeSwiggyServiceability(familyId, actorUserId);
            serviceable = probe.serviceable;
            reason = probe.reason;
        }

        rows.push({
            partner,
            label: partnerLabel(orderPartner),
            connected: isConnected,
            serviceable,
            reason,
        });
    }

    return rows;
}

function groceryPartnerHint(partner: OrderPartner, query: string): string | null {
    const q = query.toLowerCase();
    const groceryish =
        /\b(parle|biscuit|milk|bread|coke|cola|atta|rice|grocery|groceries|snack|tea|coffee|maggi|oil|doodh)\b/i.test(
            q,
        );
    if (!groceryish) return null;
    if (partner === OrderPartner.INSTAMART) return "Instamart";
    if (partner === OrderPartner.ZEPTO) return "Zepto";
    return null;
}

export async function buildOrderCommunicationReply(input: {
    familyId: string;
    actorUserId: string;
    message: string;
}): Promise<string | null> {
    const text = normalizeOrderText(input.message.trim());
    if (text.length < 4) return null;

    const requested = await pickOrderPartner(text, input.familyId, input.actorUserId);
    const explicit = parseExplicitPartner(text);
    const query = extractOrderQuery(text) || "that";
    const availability = await getOrderPartnerAvailability(input.familyId, input.actorUserId);
    const byPartner = Object.fromEntries(availability.map((r) => [r.partner, r])) as Record<
        McpPartnerKey,
        PartnerAvailabilityRow
    >;

    const requestedMcp = orderPartnerToMcp(requested);
    const requestedRow = requestedMcp ? byPartner[requestedMcp] : undefined;

    const connectedUsable = availability.filter((r) => r.connected && r.serviceable);
    const connectedLabels = connectedUsable.map((r) => r.label);

    if (explicit && requestedRow && !requestedRow.connected) {
        const parts = [
            `${requestedRow.label} isn't connected to your family yet — your caregiver can connect it in Integrations.`,
        ];
        const groceryAlt = groceryPartnerHint(requested, query);
        const instamart = byPartner.instamart;
        if (groceryAlt === "Instamart" && instamart?.connected && instamart.serviceable) {
            parts.push(`I can order ${query} from Instamart instead — say "order ${query} from instamart".`);
        } else if (connectedLabels.length) {
            parts.push(`I can place orders on ${connectedLabels.join(" or ")} right now.`);
        }
        const swiggy = byPartner.swiggy;
        if (swiggy?.connected && !swiggy.serviceable && swiggy.reason === "closed_or_unavailable") {
            parts.push("Swiggy isn't taking orders at your delivery address right now — it's closed for the day.");
        }
        return parts.join(" ");
    }

    if (requestedRow?.connected && !requestedRow.serviceable && requestedMcp === "swiggy") {
        if (requestedRow.reason === "closed_or_unavailable") {
            const parts = [
                `Swiggy isn't taking orders at your saved address right now — restaurants look closed for the day.`,
            ];
            const instamart = byPartner.instamart;
            if (instamart?.connected && instamart.serviceable && groceryPartnerHint(requested, query)) {
                parts.push(`Want ${query} from Instamart instead?`);
            } else if (connectedUsable.some((r) => r.partner === "instamart")) {
                parts.push("Instamart is available for groceries if you need something.");
            }
            return parts.join(" ");
        }
        if (requestedRow.reason === "no_address") {
            return "Swiggy is connected but I couldn't find a delivery address — add one in the Swiggy app, then try again.";
        }
    }

    if (explicit && requestedRow?.connected && requestedRow.serviceable) {
        return null;
    }

    if (/^cancel(\s+order)?$/i.test(text) || /\bcancel\s+(the\s+)?order\b/i.test(text)) {
        return "Order cancelled. Tell me anytime if you'd like to order again.";
    }

    return null;
}
