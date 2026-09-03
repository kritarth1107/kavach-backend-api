import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";
import { getFamilyForActor, requirePermission } from "./careRecordAuth.service";
import { listChannelIdentities } from "./identityResolver.service";
import { getZeptoConnectionStatus } from "../partners/zepto/mcpClient.service";
import { getZeptoRedirectUri } from "../partners/zepto/config";

export async function getFamilyIntegrations(familyId: string, actorUserId: string) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const [identities, pendingCount, recentOrders, zeptoStatus] = await Promise.all([
        listChannelIdentities(familyId),
        Order.countDocuments({
            familyId,
            status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
        }),
        Order.find({ familyId }).sort({ createdAt: -1 }).limit(5).lean(),
        getZeptoConnectionStatus(familyId, actorUserId),
    ]);

    const whatsappLinks = identities.filter((i) => i.channelType === "whatsapp");
    const phoneLinks = identities.filter((i) => i.channelType === "phone");
    const speakerLinks = identities.filter((i) => i.channelType === "smart_speaker");

    return {
        zepto: {
            status: zeptoStatus.connected ? "connected_mcp" : "mock_or_disconnected",
            mode: zeptoStatus.connected ? "zepto_mcp_live" : "deep_link_handoff",
            description: zeptoStatus.connected
                ? "Your Zepto account is linked via official MCP. Approved orders are placed through Zepto."
                : "Connect your Zepto account to place real orders. Until then, mock fulfillment + deep link.",
            connected: zeptoStatus.connected,
            connectedAt: zeptoStatus.connectedAt,
            redirectUri: getZeptoRedirectUri(),
            pendingApprovals: pendingCount,
            partnerTrack: "https://github.com/zeptonow/mcp/issues",
            paymentNote: "Payment via Zepto MCP (COD, UPI link, wallet). Razorpay not required for Zepto orders.",
        },
        whatsapp: {
            status: "mock_adapter",
            description: "Mock webhook at POST /api/webhooks/whatsapp/mock until Meta numbers are live.",
            linkedIdentities: whatsappLinks.length,
            identities: whatsappLinks.map((i) => ({
                label: i.label,
                role: i.role,
                identifier: i.channelIdentifier,
            })),
        },
        phone: {
            status: "mock_adapter",
            linkedIdentities: phoneLinks.length,
            webhook: "POST /api/webhooks/phone/mock",
        },
        smartSpeaker: {
            status: "mock_adapter",
            linkedIdentities: speakerLinks.length,
            webhook: "POST /api/webhooks/speaker/mock",
        },
        recentOrders: recentOrders.map((o) => ({
            order_id: o.orderId,
            status: o.status,
            total_paise: o.totalPaise,
            created_at: o.createdAt?.toISOString() ?? null,
        })),
    };
}
