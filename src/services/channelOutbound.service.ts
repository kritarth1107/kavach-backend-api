import { randomUUID } from "crypto";
import OutboundMessage from "../models/outboundMessage.model";
import ChannelIdentity from "../models/channelIdentity.model";
import { ChannelType } from "../types/careRecord.types";
import { sendViaBaileysBridge, isBaileysWhatsAppEnabled } from "../clients/baileysBridge.client";
import { whatsAppMockAdapter } from "../channels/whatsappMock.adapter";
import { phoneMockAdapter } from "../channels/whatsappMock.adapter";

export type OutboundDelivery = {
    channel: "whatsapp" | "phone" | "dashboard";
    channelIdentifier: string;
    delivered: boolean;
};

export async function resolveRecipientChannel(
    familyId: string,
    recipientUserId: string,
    preferred: "whatsapp" | "phone" | "dashboard",
): Promise<OutboundDelivery | null> {
    if (preferred === "dashboard") {
        return { channel: "dashboard", channelIdentifier: "dashboard", delivered: true };
    }

    const channelType = preferred === "phone" ? ChannelType.PHONE : ChannelType.WHATSAPP;
    const identity = await ChannelIdentity.findOne({
        familyId,
        userId: recipientUserId,
        channelType,
        active: true,
    }).lean();

    if (!identity?.channelIdentifier) {
        return { channel: "dashboard", channelIdentifier: "dashboard", delivered: true };
    }

    return {
        channel: preferred,
        channelIdentifier: identity.channelIdentifier,
        delivered: false,
    };
}

export async function deliverOutboundMessage(payload: {
    familyId: string;
    recipientUserId: string;
    content: string;
    channel: "whatsapp" | "phone" | "dashboard";
    channelIdentifier: string;
}): Promise<OutboundDelivery> {
    const record = {
        messageId: randomUUID(),
        familyId: payload.familyId,
        recipientUserId: payload.recipientUserId,
        channel: payload.channel,
        channelIdentifier: payload.channelIdentifier,
        content: payload.content,
        direction: "outbound" as const,
        deliveredAt: new Date(),
    };

    if (payload.channel === "dashboard") {
        await OutboundMessage.create(record);
        return {
            channel: payload.channel,
            channelIdentifier: payload.channelIdentifier,
            delivered: true,
        };
    }

    try {
        if (payload.channel === "whatsapp" && isBaileysWhatsAppEnabled()) {
            await sendViaBaileysBridge(payload.channelIdentifier, payload.content);
        } else {
            const adapter =
                payload.channel === "phone" ? phoneMockAdapter : whatsAppMockAdapter;
            await adapter.send({
                channelType:
                    payload.channel === "phone" ? ChannelType.PHONE : ChannelType.WHATSAPP,
                channelIdentifier: payload.channelIdentifier,
                modality: "text",
                content: payload.content,
            });
        }
        await OutboundMessage.create(record);
        return {
            channel: payload.channel,
            channelIdentifier: payload.channelIdentifier,
            delivered: true,
        };
    } catch (err) {
        console.warn("Outbound delivery failed, stored for dashboard:", err);
        await OutboundMessage.create({ ...record, deliveredAt: undefined });
        return {
            channel: "dashboard",
            channelIdentifier: "dashboard",
            delivered: false,
        };
    }
}

export async function listRecentOutbound(
    familyId: string,
    recipientUserId: string,
    limit = 20,
) {
    return OutboundMessage.find({ familyId, recipientUserId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
}
