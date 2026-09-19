import Order from "../models/order.model";
import { getMcpConnectionStatus } from "../partners/mcp/mcpClient.service";
import { getMcpPartner } from "../partners/mcp/partners";
import type { McpPartnerKey } from "../partners/mcp/types";
import { OrderPartner, OrderStatus } from "../types/careRecord.types";
import { getFamilyForActor, requirePermission } from "./careRecordAuth.service";
import { getPartnerOrderSettings } from "./commerceSettings.service";
import { listPartnerAddresses } from "./partnerAddress.service";

const PARTNER_TO_ORDER: Record<McpPartnerKey, OrderPartner> = {
    swiggy: OrderPartner.SWIGGY,
    instamart: OrderPartner.INSTAMART,
    zepto: OrderPartner.ZEPTO,
};

const PARTNER_CAPABILITIES: Record<McpPartnerKey, string[]> = {
    swiggy: [
        "Search restaurants and dishes from Saheli chat",
        "Build a food cart and choose a saved delivery address",
        "Place COD orders through your linked Swiggy account",
    ],
    instamart: [
        "Search groceries and daily essentials in chat",
        "Build an Instamart basket with live prices",
        "Checkout to your saved Instamart delivery addresses",
    ],
    zepto: [
        "Search Zepto catalog from Saheli chat",
        "Add items to cart with live pricing",
        "Place quick grocery orders via Zepto MCP",
    ],
};

export async function getPartnerIntegrationDetail(
    familyId: string,
    partner: McpPartnerKey,
    actorUserId: string,
) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const partnerConfig = getMcpPartner(partner);
    const [status, addresses, orderSettings, recentOrders, pendingCount] = await Promise.all([
        getMcpConnectionStatus(partner, familyId, actorUserId),
        listPartnerAddresses(familyId, partner),
        getPartnerOrderSettings(familyId, partner),
        Order.find({ familyId, partner: PARTNER_TO_ORDER[partner] })
            .sort({ createdAt: -1 })
            .limit(8)
            .lean(),
        Order.countDocuments({
            familyId,
            partner: PARTNER_TO_ORDER[partner],
            status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
        }),
    ]);

    return {
        partner,
        label: partnerConfig.label,
        connected: status.connected,
        connectedAt: status.connectedAt,
        addressCount: addresses.length,
        addresses: addresses.map((a) => ({
            address_id: a.address_id,
            partner: a.partner,
            partner_address_id: a.partner_address_id,
            label: a.label,
            line1: a.line1,
            line2: a.line2,
            city: a.city,
            pincode: a.pincode,
            is_default: a.is_default,
            synced_at: a.synced_at ?? null,
        })),
        capabilities: PARTNER_CAPABILITIES[partner],
        paymentNote: partnerConfig.paymentNote,
        partnerTrack: partnerConfig.partnerTrack,
        mcpUrl: partnerConfig.mcpUrl,
        description: status.connected
            ? partnerConfig.connectedDescription
            : partnerConfig.disconnectedDescription,
        pendingApprovals: pendingCount,
        orderSettings,
        recentOrders: recentOrders.map((o) => ({
            order_id: o.orderId,
            status: o.status,
            total_paise: o.totalPaise,
            created_at: o.createdAt?.toISOString() ?? null,
        })),
    };
}
