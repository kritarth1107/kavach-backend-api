import { randomUUID } from "crypto";
import OutboundMessage from "../models/outboundMessage.model";
import { ChannelType } from "../types/careRecord.types";
import {
    isMetaWhatsAppEnabled,
    sendViaMetaWhatsApp,
    sendMetaWhatsAppTemplate,
} from "../clients/metaWhatsApp.client";
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
    /** Set when delivery was skipped/failed; "invalid_recipient" is terminal (placeholder number); "outside_window": their
     *  WhatsApp chat is closed (24 hours since they last wrote) and no approved template fits this message. */
    reason?: "invalid_recipient" | "send_failed" | "paused" | "outside_window";
    /** WhatsApp message ids (wamid…) of what was sent, when the provider returned them. */
    messageIds?: string[];
    /** The chat was closed: a template went instead of the message. */
    via?: "template";
    /** The message itself waits and goes to Saheli's next turn with them. */
    waiting?: boolean;
};

/**
 * What to send instead when the person's 24-hour WhatsApp window is closed (whatsappTemplates.service). Without one, a
 * message to a closed chat is not sent (it would fail quietly).
 */
export type OutboundTemplate = {
    purpose: import("./whatsappTemplates.service").TemplatePurpose;
    params: string[];
    /** The reader's language code; else their saved one. */
    lang?: string;
    /** Quick reply payloads, in order (a reminder's Done). */
    quickReplyPayloads?: string[];
    /** The message waits for their next message (default: yes, except a reminder, which the template already is). */
    keepWaiting?: boolean;
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
 * who reads the message decides (toUserId), not the person it is about. It follows the text (mark = the chat right
 * after it) and is dropped if a newer message reaches the chat first. A failure never undoes the text.
 */
async function alsoSendVoice(payload: { recipientUserId: string; toUserId?: string; channelIdentifier: string; content: string }, mark: number): Promise<void> {
    try {
        const { getVoiceMode } = await import("./voicePreference.service");
        const listener = payload.toUserId || payload.recipientUserId;
        if ((await getVoiceMode(listener)) !== "always") return;
        const { sendVoiceAfterText } = await import("./voiceAfterText.service");
        await sendVoiceAfterText({ to: payload.channelIdentifier, text: payload.content, listenerUserId: listener, mark });
    } catch (err) {
        console.warn("Voice note after a proactive message failed (text was sent):", err instanceof Error ? err.message : err);
    }
}

/** What a send is for, for the delivery ledger (trust plan B1.1): the kind, the slot or nudge it belongs to. */
export type OutboundDeliveryInfo = {
    kind: import("../models/messageDelivery.model").DeliveryKind;
    refId?: string;
    nudgeId?: string;
    dueAt?: Date;
    attempt?: number;
    critical?: boolean;
};

export async function deliverOutboundMessage(payload: Parameters<typeof deliverOutboundMessageNow>[0] & { delivery?: OutboundDeliveryInfo }): Promise<OutboundDelivery> {
    const { withDelivery } = await import("./deliveryLedger.service");
    const info = payload.delivery;
    return withDelivery({
        kind: info?.kind ?? (payload.purpose === "alert" ? "alert" : "message"),
        ...(info?.refId ? { refId: info.refId } : {}),
        ...(info?.nudgeId ? { nudgeId: info.nudgeId } : {}),
        ...(info?.dueAt ? { dueAt: info.dueAt } : {}),
        ...(info?.attempt ? { attempt: info.attempt } : {}),
        ...(info?.critical ? { critical: true } : {}),
        familyId: payload.familyId,
        toUserId: payload.toUserId || payload.recipientUserId,
        aboutUserId: payload.recipientUserId,
    }, () => deliverOutboundMessageNow(payload));
}

async function deliverOutboundMessageNow(payload: {
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
    /** Sent instead when their WhatsApp window is closed. */
    template?: OutboundTemplate;
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
        const { recordNotSent } = await import("./deliveryLedger.service");
        await recordNotSent({ phone: payload.channelIdentifier, reason: "invalid_recipient" });
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
            // The reader's own window (the caregiver's, for news about the elder), kept from every inbound message.
            const { windowOpen } = await import("./whatsappWindow.service");
            if (!(await windowOpen(payload.channelIdentifier).catch(() => true))) {
                // closed: a template, or the message waits; never free text (B3.2)
                return await deliverOutsideWindow(payload, record);
            }
            // Proactive sends (nudges, outreach, reminders) go out as ONLY the message —
            // no trailing "Anything else I can help with?" quick-action bubble.
            const rich = payload.whatsappPayloads ?? composeWhatsAppReply(payload.content, { kind: "plain" });
            messageIds.push(
                ...(await sendViaMetaWhatsApp(payload.channelIdentifier, payload.content, rich, {
                    contextMessageId: payload.replyToMessageId,
                })),
            );
            // Someone who chose "always" voice notes also hears reminders and check-ins (after the text, never
            // holding up the next send).
            const { chatMark } = await import("../clients/metaWhatsApp.client");
            void alsoSendVoice(payload, chatMark(payload.channelIdentifier));
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
        if (payload.channel === "whatsapp" && !(err as { ledgerRecorded?: boolean } | null)?.ledgerRecorded) {
            const { recordNotSent } = await import("./deliveryLedger.service");
            await recordNotSent({
                phone: payload.channelIdentifier,
                reason: isWhatsAppPlaceholderRecipientError(err) ? "invalid_recipient" : `send_failed: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
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

/** Only a template notice (the caller keeps the message itself, e.g. the engine's nightly brief); nothing else is sent. */
export async function sendTemplateNotice(input: {
    familyId: string;
    recipientUserId: string;
    toUserId: string;
    phone: string;
    template: OutboundTemplate;
}): Promise<{ sent: boolean; reason?: string; template?: string; wamid?: string }> {
    const T = await import("./whatsappTemplates.service");
    const speech = await import("./voicePreference.service").then((V) => V.getSpeechProfile(input.toUserId)).catch(() => null);
    const lang = input.template.lang || speech?.language;
    const chosen = await T.pickTemplate(input.template.purpose, lang, speech?.dialect);
    if (!chosen) {
        const { recordNotSent } = await import("./deliveryLedger.service");
        await recordNotSent({ phone: input.phone, reason: "no_template" });
        return { sent: false, reason: "no approved template" };
    }
    const params = Array.from({ length: T.TEMPLATE_PARAMS[input.template.purpose] }, (_, i) => T.templateParam(input.template.params[i] ?? ""));
    try {
        const wamid = await sendMetaWhatsAppTemplate({ to: input.phone, templateName: chosen.name, languageCode: chosen.language, bodyParameters: params });
        await OutboundMessage.create({ messageId: randomUUID(), familyId: input.familyId, recipientUserId: input.recipientUserId, channel: "whatsapp",
            channelIdentifier: input.phone, content: `[${chosen.name} ${chosen.language}] ${params.join(" | ")}`, direction: "outbound", deliveredAt: new Date() });
        return { sent: true, template: chosen.name, ...(wamid ? { wamid } : {}) };
    } catch (err) {
        console.warn(`WhatsApp template ${chosen.name} failed:`, err instanceof Error ? err.message : err);
        return { sent: false, reason: "send failed" };
    }
}

/**
 * Their WhatsApp chat is closed (no message from them in 24 hours): a free message would fail quietly, so it is never
 * sent (trust plan B3.2). In order:
 *   1. its own approved template in their language (a reminder, an alert), and the message itself waits for their next
 *      message (a reminder's template is the reminder: nothing waits);
 *   2. else the general opener ("Saheli has a message for you"), at most once a day for nudges and check-ins and never
 *      twice before they answer; the message waits;
 *   3. else (no template approved, the opener already went, or the template send failed) the message only waits, the
 *      ledger records it as not sent, and a dose or an alert tells the Kavach team.
 */
async function deliverOutsideWindow(
    payload: Parameters<typeof deliverOutboundMessage>[0],
    record: Record<string, unknown>,
): Promise<OutboundDelivery> {
    const L = await import("./deliveryLedger.service");
    const kind = L.currentDelivery()?.kind ?? (payload.purpose === "alert" ? "alert" : "message");
    const t = payload.template;
    const phone = payload.channelIdentifier;
    const reader = payload.toUserId || payload.recipientUserId;
    const T = await import("./whatsappTemplates.service");
    const speech = await import("./voicePreference.service").then((V) => V.getSpeechProfile(reader)).catch(() => null);
    const lang = t?.lang || speech?.language;
    let chosen = t ? await T.pickTemplate(t.purpose, lang, speech?.dialect) : null;
    let purpose = t?.purpose;
    let params = t?.params ?? [];
    let quickReplyPayloads = t?.quickReplyPayloads;
    let waiting = t ? (t.keepWaiting ?? t.purpose !== "reminder") : true;
    let skipped = "";
    // A daily nudge stays on purpose "update" (the notice, then kavach_saheli_update). It does not fall through, and only one a day.
    const pinned = t?.purpose === "update";
    if (chosen && pinned && (kind === "nudge" || kind === "checkin")) {
        const why = await openerHeldBack(phone, kind);
        if (why) {
            chosen = null;
            skipped = why;
        }
    }
    if (!chosen && !pinned) {
        const why = await openerHeldBack(phone, kind);
        if (why) skipped = why;
        else {
            chosen = await T.pickTemplate("message", lang, speech?.dialect);
            purpose = "message";
            params = [await readerName(reader)];
            quickReplyPayloads = ["open:waiting"];
            waiting = true;
        }
    }
    const { keepWaiting } = await import("./whatsappWindow.service");
    const queue = () =>
        keepWaiting({ phone, familyId: payload.familyId, toUserId: reader, purpose: purpose ?? (kind === "alert" ? "alert" : "message"), kind, text: payload.content })
            .catch((err) => console.warn("Keeping a message for a closed WhatsApp chat failed:", err instanceof Error ? err.message : err));
    if ((purpose === "update" || purpose === "message") && !quickReplyPayloads?.length) quickReplyPayloads = ["open:waiting"];
    if (purpose === "reminder" && chosen) quickReplyPayloads = (quickReplyPayloads ?? []).slice(0, T.reminderButtonCount(chosen.name));
    if (chosen && purpose) {
        const sent = params.length || T.TEMPLATE_PARAMS[purpose] ? Array.from({ length: T.TEMPLATE_PARAMS[purpose] }, (_, i) => T.templateParam(params[i] ?? "")) : [];
        try {
            const id = await sendMetaWhatsAppTemplate({
                to: phone, templateName: chosen.name, languageCode: chosen.language, bodyParameters: sent,
                ...(quickReplyPayloads?.length ? { quickReplyPayloads } : {}),
            });
            await OutboundMessage.create({ ...record, content: `[${chosen.name} ${chosen.language}] ${sent.join(" | ")}` });
            if (waiting) await queue();
            return { channel: "whatsapp", channelIdentifier: phone, delivered: true, via: "template", waiting, messageIds: id ? [id] : [] };
        } catch (err) {
            // Meta refused the template (the client recorded it as failed): the message waits, never goes as free text
            console.warn(`WhatsApp template ${chosen.name} failed:`, err instanceof Error ? err.message : err);
            skipped = `the ${chosen.name} template failed`;
        }
    } else if (!skipped) {
        skipped = "no approved template in their language";
    }
    await queue();
    await L.recordNotSent({ phone, reason: `outside_window: waiting for their next message (${skipped})` });
    if (kind === "alert") {
        // a caregiver alert that could not reach them now: the team hears (B3.2 → B1.5)
        const { noteTeamDigest } = await import("./opsAlert.service");
        const text = `A caregiver alert for family ${payload.familyId.slice(0, 8)} could not be sent now: their WhatsApp chat is closed and ${skipped}. ` +
            "It waits and goes on their next message. If it is urgent, call them.";
        await noteTeamDigest("template", "A caregiver alert is waiting (WhatsApp chat closed)", text,
            [{ family: payload.familyId.slice(0, 8), reason: skipped }]);
    }
    return { channel: "dashboard", channelIdentifier: "dashboard", delivered: false, reason: "outside_window", waiting: true };
}

/** Why the general opener must not go now, or "" (B3.3: once a day for nudges and check-ins; never twice before they answer). */
async function openerHeldBack(phone: string, kind: string): Promise<string> {
    const { default: MessageDelivery } = await import("../models/messageDelivery.model");
    const { default: WhatsAppWindow } = await import("../models/whatsappWindow.model");
    const { phoneKey } = await import("./whatsappWindow.service");
    const { clockNow } = await import("../utils/clock.util");
    const key = phoneKey(phone);
    const win = await WhatsAppWindow.findOne({ phone: key }).lean<{ lastInboundAt?: Date }>().catch(() => null);
    const since = win?.lastInboundAt ? new Date(win.lastInboundAt) : new Date(0);
    const opener = { phone: key, template: { $regex: "^kavach_saheli_(message|update|care)" }, status: { $ne: "failed" } };
    if (kind === "alert") {
        // A caregiver alert never waits unseen behind an earlier opener (founder 15 Oct: "nothing should feel missed");
        // it only waits if an opener went in the last 30 minutes, which their tap or reply opens anyway.
        const recent = new Date(clockNow().getTime() - 30 * 60_000);
        return (await MessageDelivery.exists({ ...opener, sentAt: { $gt: recent > since ? recent : since } })) ? "an opener went in the last 30 minutes" : "";
    }
    // A nudge or check-in keeps going each morning until they reply (founder 2026-10-15). Anything else still waits
    // for a reply before a second opener.
    if (kind !== "nudge" && kind !== "checkin" && (await MessageDelivery.exists({ ...opener, sentAt: { $gt: since } }))) {
        return "the opener already went and they have not written since";
    }
    if (kind === "nudge" || kind === "checkin") {
        const now = clockNow();
        const dayStart = new Date(`${new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00+05:30`);
        if (await MessageDelivery.exists({ ...opener, kind: { $in: ["nudge", "checkin"] }, sentAt: { $gte: dayStart } })) return "a nudge already used the opener today";
    }
    return "";
}

/** The opener's {{1}}: the reader's first name (a non-member, like an emergency contact, is greeted plainly). */
async function readerName(userId: string): Promise<string> {
    if (!userId || userId.startsWith("contact:")) return "Namaste";
    const { default: User } = await import("../models/users.model");
    const u = await User.findOne({ userId }, { firstName: 1 }).lean<{ firstName?: string }>().catch(() => null);
    return (u?.firstName || "").trim().split(/\s+/)[0] || "Namaste";
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
