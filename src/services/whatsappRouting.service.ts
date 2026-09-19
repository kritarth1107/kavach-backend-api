import type { OutboundMessage } from "../channels/types";
import { whatsAppMockAdapter } from "../channels/whatsappMock.adapter";
import { ChannelType, CareRecordSource } from "../types/careRecord.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import WhatsappSession from "../models/whatsappSession.model";
import {
    normalizeChannelIdentifier,
    resolveWhatsAppSender,
} from "./identityResolver.service";
import config from "../config/app.config";
import { tryHandleCaregiverWhatsAppOrderCommand } from "./whatsappOrder.service";
import { tryHandleWhatsAppOrderTurn } from "./whatsappOrderFlow.service";
import { getFamilyMembersList } from "./familyMember.service";
import {
    composeWhatsAppReply,
    flattenWhatsAppPayloads,
} from "./whatsappMessageComposer.service";
import type { WhatsAppReplyContext } from "../types/whatsappMessage.types";
import { messageLooksLikeEmergency } from "./saheliEmergency.service";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function kavachWhatsAppLine(): string {
    return config.whatsapp.kavachNumber;
}

const GUEST_WELCOME = `👋 *Welcome to Saheli!*

Hi — I'm *Saheli*, Kavach's family companion on WhatsApp. No extra setup needed; just message me from your phone.

*Kavach* helps families stay connected — gentle check-ins, medicine reminders, and ordering from *Swiggy*, *Instamart*, or *Zepto*.

*What I can help with:*
💬 Warm conversations and daily check-ins
📋 Medicine and care reminders
🛒 Food and grocery orders (with family approval when needed)

Our WhatsApp line: *${kavachWhatsAppLine()}*

Not on Kavach yet?
✨ *Sign up at app.kavach.care*
👨‍👩‍👧 Or ask your caregiver to invite you with the *same mobile number* you use on WhatsApp

How can I help you today? 💚`;

const GUEST_FOLLOWUP = `👋 *Welcome to Saheli!*

Thanks for messaging me. I don't recognise this number yet.

✨ *Sign up at app.kavach.care*

👨‍👩‍👧 Or ask your caregiver to invite you using the *same mobile number* you use on WhatsApp

Once you're on the family, I can help from right here. 💚`;

function isCaregiver(role: FamilyRole): boolean {
    return role === FamilyRole.PRIMARY_CAREGIVER || role === FamilyRole.CO_CAREGIVER;
}

function outbound(phone: string, text: string, context: WhatsAppReplyContext = {}): OutboundMessage {
    const whatsappPayloads = composeWhatsAppReply(text, context);
    const content =
        whatsappPayloads.length > 1 || whatsappPayloads[0]?.type !== "text"
            ? flattenWhatsAppPayloads(whatsappPayloads)
            : text;
    return {
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: phone,
        modality: "text",
        content,
        whatsappPayloads,
    };
}

async function touchGuestSession(phone: string) {
    const existing = await WhatsappSession.findOne({ phone }).lean();
    const guestTurns = (existing?.guestTurns ?? 0) + 1;
    await WhatsappSession.findOneAndUpdate(
        { phone },
        {
            $set: {
                guestTurns,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
            $unset: { familyId: "", userId: "", pendingRecipientUserId: "", awaitingRecipientPick: "", recipientOptions: "" },
        },
        { upsert: true },
    );
    return guestTurns;
}

async function handleGuestMessage(phone: string): Promise<OutboundMessage> {
    const turns = await touchGuestSession(phone);
    return outbound(phone, turns <= 1 ? GUEST_WELCOME : GUEST_FOLLOWUP, {
        kind: turns <= 1 ? "guest_welcome" : "guest_followup",
    });
}

async function listFamilyRecipients(familyId: string, actorUserId: string) {
    const payload = await getFamilyMembersList(familyId, actorUserId);
    return payload.members
        .filter(
            (m) =>
                m.userId &&
                m.role === FamilyRole.CARE_RECIPIENT &&
                m.status === FamilyMemberStatus.JOINED,
        )
        .map((m) => ({ userId: m.userId as string, name: m.name?.trim() || "Care recipient" }));
}

function matchRecipientByText(
    text: string,
    recipients: Array<{ userId: string; name: string }>,
): string | null {
    const lower = text.toLowerCase();
    const directId = recipients.find((r) => r.userId === text.trim());
    if (directId) return directId.userId;

    const numbered = lower.match(/^\s*([1-9])\s*$/);
    if (numbered) {
        const idx = Number(numbered[1]) - 1;
        return recipients[idx]?.userId ?? null;
    }
    for (const r of recipients) {
        const name = r.name.toLowerCase();
        if (name.length >= 2 && lower.includes(name)) return r.userId;
    }
    return null;
}

async function resolveCaregiverSubject(input: {
    phone: string;
    familyId: string;
    userId: string;
    text: string;
}): Promise<
    | { subjectUserId: string }
    | { prompt: string; recipientOptions?: Array<{ userId: string; name: string }> }
> {
    const recipients = await listFamilyRecipients(input.familyId, input.userId);
    if (!recipients.length) {
        return { prompt: "Your family doesn't have a care recipient profile yet. Add one in the Kavach dashboard first." };
    }
    if (recipients.length === 1) {
        return { subjectUserId: recipients[0]!.userId };
    }

    const session = await WhatsappSession.findOne({ phone: input.phone }).lean();
    const options = recipients;

    const matched = matchRecipientByText(input.text, options);
    if (matched) {
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $set: {
                    familyId: input.familyId,
                    userId: input.userId,
                    pendingRecipientUserId: matched,
                    awaitingRecipientPick: false,
                    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
                },
            },
            { upsert: true },
        );
        return { subjectUserId: matched };
    }

    if (session?.pendingRecipientUserId && !session.awaitingRecipientPick) {
        return { subjectUserId: session.pendingRecipientUserId };
    }

    const lines = options.map((r, i) => `${i + 1}. ${r.name}`).join("\n");
    await WhatsappSession.findOneAndUpdate(
        { phone: input.phone },
        {
            $set: {
                familyId: input.familyId,
                userId: input.userId,
                awaitingRecipientPick: true,
                recipientOptions: options,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
        },
        { upsert: true },
    );

    return {
        prompt: `Who are you asking about?\n${lines}\n\nReply with a number or name, and I'll answer about them.`,
        recipientOptions: options,
    };
}

export async function handleWhatsAppInbound(body: {
    from?: string;
    text?: string;
    modality?: "text" | "voice";
    audioBase64?: string;
    mediaUrl?: string;
    mediaType?: string;
    mediaCaption?: string;
}): Promise<OutboundMessage> {
    const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(body.from ?? ""));
    let text = String(body.text ?? "").trim();

    if (!text && body.mediaUrl && body.mediaType) {
        text = `[${body.mediaType} shared]`;
    }

    let identity: Awaited<ReturnType<typeof resolveWhatsAppSender>> | null = null;
    try {
        identity = await resolveWhatsAppSender(phone);
    } catch {
        return handleGuestMessage(phone);
    }

    if (identity.role === FamilyRole.CARE_RECIPIENT && messageLooksLikeEmergency(text)) {
        const { triggerEmergencyEscalation, elderEmergencyReply } = await import(
            "./saheliEmergency.service"
        );
        const membersPayload = await getFamilyMembersList(identity.familyId, identity.userId);
        const displayName =
            membersPayload.members.find((m) => m.userId === identity!.userId)?.name?.trim() ||
            "there";
        await triggerEmergencyEscalation({
            familyId: identity.familyId,
            recipientUserId: identity.userId,
            actorUserId: identity.userId,
            message: text,
            channel: "whatsapp",
        });
        return outbound(phone, elderEmergencyReply(displayName));
    }

    const {
        touchWhatsAppInbound,
        parseLanguageChangeMessage,
        languageChangeConfirmation,
        updateCompanionProfile,
    } = await import("./saheliCompanion.service");
    if (identity.role === FamilyRole.CARE_RECIPIENT) {
        await touchWhatsAppInbound(identity.familyId, identity.userId);

        const langChange = parseLanguageChangeMessage(text);
        if (langChange) {
            await updateCompanionProfile(
                identity.familyId,
                identity.userId,
                identity.userId,
                { preferredLanguage: langChange },
            );
            return outbound(phone, languageChangeConfirmation(langChange));
        }
    }

    if (
        body.mediaType &&
        identity.role === FamilyRole.CARE_RECIPIENT &&
        !messageLooksLikeEmergency(text)
    ) {
        const { ingestWhatsAppMediaMessage } = await import("./whatsappMediaIngest.service");
        const mediaReply = await ingestWhatsAppMediaMessage({
            familyId: identity.familyId,
            recipientUserId: identity.userId,
            actorUserId: identity.userId,
            mediaType: body.mediaType,
            mediaUrl: body.mediaUrl,
            caption: body.mediaCaption ?? (text.startsWith("[") ? undefined : text),
        });
        const isMediaOnly =
            !text ||
            /^\[(image|document|voice|audio|video) (message|shared)\]$/i.test(text);
        if (isMediaOnly) {
            return outbound(phone, mediaReply);
        }
    }

    let subjectUserId = identity.userId;
    if (isCaregiver(identity.role)) {
        const subject = await resolveCaregiverSubject({
            phone,
            familyId: identity.familyId,
            userId: identity.userId,
            text,
        });
        if ("prompt" in subject) {
            return outbound(phone, subject.prompt, {
                kind: subject.recipientOptions?.length ? "recipient_pick" : "plain",
                recipientOptions: subject.recipientOptions,
            });
        }
        subjectUserId = subject.subjectUserId;
    }

    const waSession = await WhatsappSession.findOne({ phone }).lean();
    const orderFlowReply = await tryHandleWhatsAppOrderTurn({
        phone,
        familyId: identity.familyId,
        recipientUserId: subjectUserId,
        actorUserId: identity.userId,
        text,
        saheliSessionId: waSession?.saheliSessionId,
    });
    if (orderFlowReply) {
        const { recordWhatsAppAiDebug } = await import("./whatsappWebhookLog.service");
        recordWhatsAppAiDebug({
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
            actorUserId: identity.userId,
            replySource: "orderSession",
            fallbackUsed: "tryHandleWhatsAppOrderTurn",
        });
        return outbound(phone, orderFlowReply.text, {
            kind: "order_flow",
            orderFlow: orderFlowReply.orderFlow,
        });
    }

    if (isCaregiver(identity.role)) {
        const orderReply = await tryHandleCaregiverWhatsAppOrderCommand({
            familyId: identity.familyId,
            actorUserId: identity.userId,
            role: identity.role,
            text,
        });
        if (orderReply) {
            const pendingMatch = orderReply.match(
                /pending (\S+) basket \((.+), (₹[\d,.]+)\)/i,
            );
            return outbound(phone, orderReply, {
                kind: pendingMatch ? "order_pending_approval" : "plain",
                pendingOrder: pendingMatch
                    ? {
                          partner: pendingMatch[1]!,
                          itemList: pendingMatch[2]!,
                          amount: pendingMatch[3]!,
                      }
                    : undefined,
            });
        }
    }

    const { reply } = await whatsAppMockAdapter.receive({
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: phone,
        modality: body.modality ?? "text",
        content: text,
        audioBase64: body.audioBase64,
        timestamp: new Date(),
        _routing: {
            familyId: identity.familyId,
            userId: identity.userId,
            role: identity.role,
            subjectUserId,
        },
    });

    if (reply.orderFlow?.sessionId) {
        return outbound(phone, reply.content, {
            kind: "order_flow",
            orderFlow: reply.orderFlow,
        });
    }

    return outbound(phone, reply.content, { kind: "plain" });
}
