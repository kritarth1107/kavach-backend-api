import { randomUUID } from "crypto";
import OutboundMessage from "../models/outboundMessage.model";
import { ChannelType } from "../types/careRecord.types";
import {
    isMetaWhatsAppEnabled,
    sendViaMetaWhatsApp,
    sendMetaWhatsAppTemplate,
} from "../clients/metaWhatsApp.client";
import SaheliCompanion from "../models/saheliCompanion.model";
import type { MetaWhatsAppPayload } from "../types/whatsappMessage.types";
import { composeWhatsAppReply } from "./whatsappMessageComposer.service";
import { whatsAppMockAdapter } from "../channels/whatsappMock.adapter";
import { phoneMockAdapter } from "../channels/whatsappMock.adapter";
import { resolveUserWhatsAppPhone } from "./identityResolver.service";

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

    if (preferred === "whatsapp") {
        const recipientPhone = await resolveUserWhatsAppPhone(recipientUserId);
        if (recipientPhone) {
            return {
                channel: "whatsapp",
                channelIdentifier: recipientPhone,
                delivered: false,
            };
        }
    }

    return { channel: "dashboard", channelIdentifier: "dashboard", delivered: true };
}

export async function deliverOutboundMessage(payload: {
    familyId: string;
    recipientUserId: string;
    content: string;
    channel: "whatsapp" | "phone" | "dashboard";
    channelIdentifier: string;
    whatsappPayloads?: MetaWhatsAppPayload[];
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
        if (payload.channel === "whatsapp" && isMetaWhatsAppEnabled()) {
            const companion = await SaheliCompanion.findOne({
                familyId: payload.familyId,
                recipientUserId: payload.recipientUserId,
            }).lean();
            const outsideWindow =
                companion?.lastWhatsAppInboundAt &&
                Date.now() - new Date(companion.lastWhatsAppInboundAt).getTime() >
                    24 * 60 * 60 * 1000;

            if (outsideWindow && process.env.WHATSAPP_TEMPLATE_MORNING_CARE) {
                await sendMetaWhatsAppTemplate({
                    to: payload.channelIdentifier,
                    templateName: process.env.WHATSAPP_TEMPLATE_MORNING_CARE,
                    bodyParameters: [payload.content.slice(0, 120)],
                });
            } else {
                const rich =
                    payload.whatsappPayloads ??
                    composeWhatsAppReply(payload.content, { kind: "schedule_missed" });
                await sendViaMetaWhatsApp(payload.channelIdentifier, payload.content, rich);
            }
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
