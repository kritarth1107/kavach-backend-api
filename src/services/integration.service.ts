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

    const kavachNumber = config.whatsapp.kavachNumber;
    const bridgeState = baileysStatus?.state ?? "unknown";
    const whatsappDescription =
        config.whatsapp.provider === "baileys"
            ? baileysStatus?.connected
                ? `Message Saheli on WhatsApp at ${kavachNumber}. One shared Kavach line for all families — no per-family WhatsApp setup.`
                : bridgeState === "connecting"
                  ? "WhatsApp bridge is reconnecting — scan QR at the bridge /logs page if needed."
                  : "Baileys bridge offline — open /logs on the bridge VM to scan QR."
            : "Dashboard chat is live. WhatsApp starts when the Baileys bridge is enabled.";

    const whatsappStatus =
        config.whatsapp.provider === "baileys"
            ? baileysStatus?.connected
                ? "baileys_connected"
                : bridgeState === "connecting"
                  ? "baileys_connecting"
                  : "baileys_disconnected"
            : "mock_adapter";

    return {
        zepto,
        swiggy,
        instamart,
        whatsapp: {
            status: whatsappStatus,
            bridgeState,
            hasQr: baileysStatus?.hasQr ?? false,
            lastDisconnectReason: baileysStatus?.lastDisconnectReason ?? null,
            description: whatsappDescription,
            kavachNumber,
            linkedIdentities: whatsappLinks.length,
            identities: [],
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
