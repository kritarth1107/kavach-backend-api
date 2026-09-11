import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";
import { getFamilyForActor, requirePermission } from "./careRecordAuth.service";
import { listChannelIdentities } from "./identityResolver.service";
import { getMcpConnectionStatus } from "../partners/mcp/mcpClient.service";
import { MCP_PARTNERS } from "../partners/mcp/partners";
import type { McpPartnerKey } from "../partners/mcp/types";
import config from "../config/app.config";
import { getBaileysBridgeStatus } from "../clients/baileysBridge.client";
import { listPartnerAddresses } from "./partnerAddress.service";

async function enrichMcpBlock(
    partner: McpPartnerKey,
    familyId: string,
    actorUserId: string,
    pendingCount: number,
) {
    const config = MCP_PARTNERS[partner];
    const status = await getMcpConnectionStatus(partner, familyId, actorUserId);
    return {
        status: status.connected ? ("connected_mcp" as const) : ("mock_or_disconnected" as const),
        mode: status.connected ? (`${partner}_mcp_live` as const) : ("deep_link_handoff" as const),
        description: status.connected
            ? config.connectedDescription
            : config.disconnectedDescription,
        connected: status.connected,
        connectedAt: status.connectedAt,
        redirectUri: config.getRedirectUri(),
        mcpUrl: config.mcpUrl,
        pendingApprovals: pendingCount,
        partnerTrack: config.partnerTrack,
        paymentNote: config.paymentNote,
        label: config.label,
    };
}

export async function getFamilyIntegrations(familyId: string, actorUserId: string) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const [identities, pendingCount, recentOrders, partnerAddresses] = await Promise.all([
        listChannelIdentities(familyId),
        Order.countDocuments({
            familyId,
            status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
        }),
        Order.find({ familyId }).sort({ createdAt: -1 }).limit(5).lean(),
        listPartnerAddresses(familyId),
    ]);

    const [zepto, swiggy, instamart] = await Promise.all([
        enrichMcpBlock("zepto", familyId, actorUserId, pendingCount),
        enrichMcpBlock("swiggy", familyId, actorUserId, pendingCount),
        enrichMcpBlock("instamart", familyId, actorUserId, pendingCount),
    ]);

    const whatsappLinks = identities.filter((i) => i.channelType === "whatsapp");
    const phoneLinks = identities.filter((i) => i.channelType === "phone");
    const speakerLinks = identities.filter((i) => i.channelType === "smart_speaker");

    const baileysStatus =
        config.whatsapp.provider === "baileys" ? await getBaileysBridgeStatus() : null;

    const whatsappDescription =
        config.whatsapp.provider === "baileys"
            ? baileysStatus?.connected
                ? "Pilot WhatsApp via Baileys bridge — linked numbers can chat with Saheli."
                : "Baileys bridge configured but not connected — scan QR on the bridge service."
            : "Dashboard chat is live. WhatsApp pilot starts when Baileys bridge is enabled.";

    return {
        zepto,
        swiggy,
        instamart,
        whatsapp: {
            status:
                config.whatsapp.provider === "baileys"
                    ? baileysStatus?.connected
                        ? "baileys_connected"
                        : "baileys_disconnected"
                    : "mock_adapter",
            description: whatsappDescription,
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
            partner: o.partner,
            total_paise: o.totalPaise,
            created_at: o.createdAt?.toISOString() ?? null,
        })),
        partnerAddresses,
    };
}
