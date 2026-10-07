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
import { resolveRecipientWhatsAppPhone } from "./identityResolver.service";
import {
    isPlaceholderWhatsAppNumber,
    isWhatsAppPlaceholderRecipientError,
} from "./whatsappRecipientGuard.service";
import { isSmokeFixturePhone } from "./smokeFixtures.service";

export type OutboundDelivery = {
    channel: "whatsapp" | "phone" | "dashboard";
    channelIdentifier: string;
    delivered: boolean;
    /** Set when delivery was skipped/failed; "invalid_recipient" is terminal (placeholder number). */
    reason?: "invalid_recipient" | "send_failed" | "paused";
    /** WhatsApp message ids (wamid…) of what was sent, when the provider returned them. */
    messageIds?: string[];
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
        const recipientPhone = await resolveRecipientWhatsAppPhone(recipientUserId, familyId);
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

/**
 * Best effort: a voice note after the text for people who chose "always", in their language and dialect. The person
 * who reads the message decides (toUserId), not the person it is about. A failure never undoes the text.
 */
async function alsoSendVoice(payload: { recipientUserId: string; toUserId?: string; channelIdentifier: string; content: string }): Promise<void> {
    try {
        const { getVoiceMode, getSpeechProfile } = await import("./voicePreference.service");
        const listener = payload.toUserId || payload.recipientUserId;
        if ((await getVoiceMode(listener)) !== "always") return;
        const { textToSpeech } = await import("../channels/voicePipeline");
        const { voiceHint } = await import("./language.service");
        const spoken = await textToSpeech(payload.content, { languageHint: voiceHint(await getSpeechProfile(listener)) });
        if (!spoken.audioBuffer) return;
        const { sendMetaWhatsAppVoice } = await import("../clients/metaWhatsApp.client");
        await sendMetaWhatsAppVoice({ to: payload.channelIdentifier, audioBuffer: spoken.audioBuffer, mimeType: spoken.mimeType || "audio/mpeg" });
    } catch (err) {
        console.warn("Voice note after a proactive message failed (text was sent):", err instanceof Error ? err.message : err);
    }
}

export async function deliverOutboundMessage(payload: {
    familyId: string;
    recipientUserId: string;
    /** Who reads it, when that is not the person it is about (a caregiver getting news of the elder). */
    toUserId?: string;
    content: string;
    channel: "whatsapp" | "phone" | "dashboard";
    channelIdentifier: string;
    whatsappPayloads?: MetaWhatsAppPayload[];
    /** Send as a WhatsApp reply quoting this earlier message (Cloud API `context.message_id`). */
    replyToMessageId?: string;
    /** "proactive" = Saheli starts it (reminders, nudges, outreach): held back while the family is paused from the
     *  admin console. "alert" = caregiver alerts, never held back. */
    purpose?: "proactive" | "alert";
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

    if (payload.purpose === "proactive" && payload.channel !== "dashboard") {
        const { flagsLoadedAt, isSaheliPaused, refreshFlags } = await import("./featureFlags.service");
        // Right after a start the switches may not be loaded yet: load them once before deciding.
        if (!flagsLoadedAt()) await refreshFlags().catch(() => undefined);
        if (isSaheliPaused(payload.familyId)) {
            // Nothing was sent, so nothing is recorded as a send (and it never counts as a failed send).
            return { channel: "dashboard", channelIdentifier: "dashboard", delivered: false, reason: "paused" };
        }
    }

    if (payload.channel === "dashboard") {
        await OutboundMessage.create(record);
        return {
            channel: payload.channel,
            channelIdentifier: payload.channelIdentifier,
            delivered: true,
        };
    }

    // Synthetic smoke-test families (+999 fixtures): simulate the send (never reaches Meta)
    // so proactive flows (nudges, follow-ups) can be exercised end to end via the mock peek.
    if (payload.channel === "whatsapp" && isSmokeFixturePhone(payload.channelIdentifier)) {
        const simulatedId = `mock.wamid.${randomUUID()}`;
        const { recordSaheliOutbound } = await import("./whatsappMockPeek.service");
        recordSaheliOutbound(
            payload.channelIdentifier,
            payload.replyToMessageId ? `↩︎ [reply to ${payload.replyToMessageId}] ${payload.content}` : payload.content,
            `simulated:${simulatedId}`,
        );
        await OutboundMessage.create(record);
        return { channel: "whatsapp", channelIdentifier: payload.channelIdentifier, delivered: true, messageIds: [simulatedId] };
    }

    if (
        (payload.channel === "whatsapp" || payload.channel === "phone") &&
        (await isPlaceholderWhatsAppNumber(payload.channelIdentifier))
    ) {
        console.warn(
            `Outbound ${payload.channel} send skipped: placeholder recipient number for user ${payload.recipientUserId}`,
        );
        return {
            channel: "dashboard",
            channelIdentifier: "dashboard",
            delivered: false,
            reason: "invalid_recipient",
        };
    }

    const messageIds: string[] = [];
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
                const id = await sendMetaWhatsAppTemplate({
                    to: payload.channelIdentifier,
                    templateName: process.env.WHATSAPP_TEMPLATE_MORNING_CARE,
                    bodyParameters: [payload.content.slice(0, 120)],
                });
                if (id) messageIds.push(id);
            } else {
                // Proactive sends (nudges, outreach, reminders) go out as ONLY the message —
                // no trailing "Anything else I can help with?" quick-action bubble.
                const rich = payload.whatsappPayloads ?? composeWhatsAppReply(payload.content, { kind: "plain" });
                messageIds.push(
                    ...(await sendViaMetaWhatsApp(payload.channelIdentifier, payload.content, rich, {
                        contextMessageId: payload.replyToMessageId,
                    })),
                );
                // Someone who chose "always" voice notes also hears reminders and check-ins (after the text).
                await alsoSendVoice(payload);
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
            messageIds,
        };
    } catch (err) {
        if (isWhatsAppPlaceholderRecipientError(err)) {
            return {
                channel: "dashboard",
                channelIdentifier: "dashboard",
                delivered: false,
                reason: "invalid_recipient",
            };
        }
        console.warn("Outbound delivery failed, stored for dashboard:", err);
        await OutboundMessage.create({ ...record, deliveredAt: undefined });
        return {
            channel: "dashboard",
            channelIdentifier: "dashboard",
            delivered: false,
            reason: "send_failed",
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
