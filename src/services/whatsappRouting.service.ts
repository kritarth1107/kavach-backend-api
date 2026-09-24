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
    buildQuickOrderConfirmMessages,
    buildInteractiveButtonMessages,
} from "./whatsappMessageComposer.service";
import type { WhatsAppReplyContext } from "../types/whatsappMessage.types";
import { messageLooksLikeEmergency } from "./saheliEmergency.service";
import { tryHandleWhatsAppDashboardAction } from "./whatsappDashboardParity.service";
import { stampCompanionVoice } from "./saheliCompanionVoice.service";

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
🛒 Food, grocery, and medicine orders (family gets a notify)

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
    interactiveId?: string;
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

    // Voice/audio: download from Meta + STT, then continue into elder AI with transcript.
    const isVoiceMedia =
        body.mediaType === "voice" ||
        body.mediaType === "audio" ||
        body.modality === "voice";
    let voiceTranscript: string | undefined;
    if (isVoiceMedia && body.mediaUrl && identity.role === FamilyRole.CARE_RECIPIENT) {
        try {
            const { downloadMedia } = await import("../clients/metaWhatsApp.client");
            const { speechToText } = await import("../channels/voicePipeline");
            const media = await downloadMedia(body.mediaUrl);
            voiceTranscript = await speechToText({
                audioBuffer: media.buffer,
                mimeType: media.mimeType,
                fallbackText:
                    text && !/^\[(voice|audio) (message|shared)\]$/i.test(text)
                        ? text
                        : undefined,
            });
            if (voiceTranscript.trim()) {
                text = voiceTranscript.trim();
                console.log(
                    `WhatsApp voice STT ok (${voiceTranscript.length} chars) from ${phone.slice(0, 6)}…`,
                );
            } else {
                console.warn("WhatsApp voice STT returned empty transcript");
            }
        } catch (err) {
            console.warn(
                "WhatsApp voice STT failed:",
                err instanceof Error ? err.message : err,
            );
        }
    }

    if (
        body.mediaType &&
        identity.role === FamilyRole.CARE_RECIPIENT &&
        !messageLooksLikeEmergency(text)
    ) {
        const { ingestWhatsAppMediaMessage } = await import("./whatsappMediaIngest.service");
        const mediaResult = await ingestWhatsAppMediaMessage({
            familyId: identity.familyId,
            recipientUserId: identity.userId,
            actorUserId: identity.userId,
            mediaType: body.mediaType,
            mediaUrl: body.mediaUrl,
            caption: body.mediaCaption ?? (text.startsWith("[") ? undefined : text),
            transcript: voiceTranscript,
        });
        const isVoice = body.mediaType === "voice" || body.mediaType === "audio";
        const isMediaOnly =
            !text ||
            /^\[(image|document|voice|audio|video) (message|shared)\]$/i.test(text);
        // Image/document: vision pipeline → companion prompt (no dead-end "Saved in your care record.").
        if (!isVoice && mediaResult.companionPrompt) {
            text = mediaResult.companionPrompt;
        } else if (isMediaOnly && !isVoice && mediaResult.reply) {
            return outbound(phone, mediaResult.reply);
        }
        // Voice with transcript continues to elder AI.
        if (isMediaOnly && isVoice && !text) {
            return outbound(
                phone,
                "I couldn't catch that voice note clearly — could you type it or try again?",
            );
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

    const quickConfirmMatch = body.interactiveId?.match(/^quick_confirm:(.+)$/);
    const quickChangeAddrMatch = body.interactiveId?.match(/^quick_change_addr:(.+)$/);
    
    if (quickConfirmMatch) {
        const sessionId = quickConfirmMatch[1];
        const { confirmAndPlaceOrder } = await import("./orderKernel.service");
        const result = await confirmAndPlaceOrder({
            sessionId,
            familyId: identity.familyId,
            actorUserId: identity.userId,
            recipientUserId: subjectUserId,
        });
        const { recordWhatsAppAiDebug } = await import("./whatsappWebhookLog.service");
        recordWhatsAppAiDebug({
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
            actorUserId: identity.userId,
            replySource: "quickOrder",
            fallbackUsed: "confirmAndPlaceOrder",
        });
        const stampedConfirm = await stampCompanionVoice(result.message, {
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
        });
        return outbound(phone, stampedConfirm, {
            kind: result.orderFlow ? "order_flow" : "plain",
            orderFlow: result.orderFlow,
        });
    }

    if (quickChangeAddrMatch) {
        const sessionId = quickChangeAddrMatch[1];
        const { getOrderFlowSession } = await import("./orderOrchestrator.service");
        const OrderSession = (await import("../models/orderSession.model")).default;
        await OrderSession.updateOne(
            { sessionId, familyId: identity.familyId },
            { $set: { phase: "select_address" }, $unset: { selectedAddressId: "" } },
        );
        const flow = await getOrderFlowSession({
            sessionId,
            familyId: identity.familyId,
            actorUserId: identity.userId,
        });
        return outbound(phone, "Pick a different delivery address:", {
            kind: "order_flow",
            orderFlow: flow,
        });
    }

    const dashboardAction = await tryHandleWhatsAppDashboardAction({
        familyId: identity.familyId,
        recipientUserId: subjectUserId,
        actorUserId: identity.userId,
        text,
        interactiveId: body.interactiveId,
        role: isCaregiver(identity.role) ? "caregiver" : "elder",
        recipientName: (await getFamilyMembersList(identity.familyId, identity.userId))
            .members.find(m => m.userId === subjectUserId)?.name,
    });
    if (dashboardAction.handled && dashboardAction.reply) {
        const stampedParityReply = await stampCompanionVoice(dashboardAction.reply, {
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
        });
        const { recordWhatsAppAiDebug } = await import("./whatsappWebhookLog.service");
        recordWhatsAppAiDebug({
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
            actorUserId: identity.userId,
            replySource: "dashboardParity",
            fallbackUsed: "tryHandleWhatsAppDashboardAction",
        });
        
        if (dashboardAction.interactiveButtons?.length) {
            const payloads = buildInteractiveButtonMessages(
                stampedParityReply,
                dashboardAction.interactiveButtons,
            );
            return {
                channelType: ChannelType.WHATSAPP,
                channelIdentifier: phone,
                modality: "text",
                content: flattenWhatsAppPayloads(payloads),
                whatsappPayloads: payloads,
            };
        }
        
        return outbound(phone, stampedParityReply);
    }

    // Pharmacy (Apollo / PharmEasy / Tata 1mg) — elder places, caregivers notify-only.
    {
        const { handlePharmacyWhatsAppTurn, messageLooksLikePharmacyOrder } = await import(
            "./pharmacyOrderFlow.service"
        );
        const { getCommerceAdapter } = await import("./commerceAutomation");
        const waForPharmacy = await WhatsappSession.findOne({ phone }).lean();
        const pendingOtp = (waForPharmacy as { pendingCommerceOtp?: { partner: string; challengeId?: string } } | null)
            ?.pendingCommerceOtp;
        if (pendingOtp && /^\d{4,8}$/.test(text.trim())) {
            try {
                const adapter = getCommerceAdapter(pendingOtp.partner as import("./commerceAutomation").CommercePartnerKey);
                const result = await adapter.submitOtp({
                    userId: identity.userId,
                    familyId: identity.familyId,
                    otp: text.trim(),
                    otpChallengeId: pendingOtp.challengeId,
                });
                await WhatsappSession.findOneAndUpdate(
                    { phone },
                    { $unset: { pendingCommerceOtp: 1 } },
                );
                if (result.status === "connected") {
                    return outbound(
                        phone,
                        `Connected ${pendingOtp.partner.replace("_", " ")} on your number. Tell me what to order.`,
                    );
                }
            } catch (err) {
                console.warn("Commerce OTP submit failed:", err);
            }
        }
        if (
            identity.role === FamilyRole.CARE_RECIPIENT &&
            (messageLooksLikePharmacyOrder(text) ||
                (waForPharmacy as { pharmacyDraft?: unknown } | null)?.pharmacyDraft)
        ) {
            const pharmacyReply = await handlePharmacyWhatsAppTurn({
                phone,
                text,
                familyId: identity.familyId,
                actorUserId: identity.userId,
                recipientUserId: subjectUserId,
                actorRole: identity.role,
                mediaUrl: body.mediaUrl,
                isRxPhoto: body.mediaType === "image" || body.mediaType === "document",
            });
            if (pharmacyReply) {
                return outbound(phone, pharmacyReply.text);
            }
        }
    }

    const orderFlowReply = await tryHandleWhatsAppOrderTurn({
        phone,
        familyId: identity.familyId,
        recipientUserId: subjectUserId,
        actorUserId: identity.userId,
        text,
        interactiveId: body.interactiveId,
        saheliSessionId: waSession?.saheliSessionId,
    });
    if (orderFlowReply?.reprocessText) {
        const { recordWhatsAppAiDebug } = await import("./whatsappWebhookLog.service");
        recordWhatsAppAiDebug({
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
            actorUserId: identity.userId,
            replySource: "orderSession",
            fallbackUsed: "cancelAndSwitchReprocess",
        });
        return handleWhatsAppInbound({
            ...body,
            text: orderFlowReply.reprocessText,
            interactiveId: undefined,
        });
    }
    if (orderFlowReply) {
        const { recordWhatsAppAiDebug } = await import("./whatsappWebhookLog.service");
        recordWhatsAppAiDebug({
            familyId: identity.familyId,
            recipientUserId: subjectUserId,
            actorUserId: identity.userId,
            replySource: orderFlowReply.quickConfirm ? "quickOrder" : "orderSession",
            fallbackUsed: "tryHandleWhatsAppOrderTurn",
        });

        if (orderFlowReply.quickConfirm) {
            const payloads = buildQuickOrderConfirmMessages({
                sessionId: orderFlowReply.quickConfirm.sessionId,
                partner: orderFlowReply.quickConfirm.partner,
                partnerLabel: orderFlowReply.quickConfirm.partnerLabel,
                items: orderFlowReply.quickConfirm.items,
                totalPaise: orderFlowReply.quickConfirm.totalPaise,
                address: orderFlowReply.quickConfirm.address,
            });
            return {
                channelType: ChannelType.WHATSAPP,
                channelIdentifier: phone,
                modality: "text",
                content: flattenWhatsAppPayloads(payloads),
                whatsappPayloads: payloads,
            };
        }

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

    let out: ReturnType<typeof outbound>;
    if (reply.orderFlow?.sessionId) {
        out = outbound(phone, reply.content, {
            kind: "order_flow",
            orderFlow: reply.orderFlow,
        });
    } else {
        out = outbound(phone, reply.content, { kind: "plain" });
    }

    // Voice replies: synthesize ElevenLabs audio when key present (else text-only).
    if (isVoiceMedia && out.content?.trim()) {
        try {
            const { textToSpeech } = await import("../channels/voicePipeline");
            const spoken = await textToSpeech(out.content);
            if (spoken.audioBuffer || spoken.audioBase64) {
                out = {
                    ...out,
                    modality: "voice",
                    audioBuffer: spoken.audioBuffer,
                    audioBase64: spoken.audioBase64,
                    audioMimeType: spoken.mimeType || "audio/mpeg",
                };
            }
        } catch (err) {
            console.warn(
                "WhatsApp reply TTS failed (sending text only):",
                err instanceof Error ? err.message : err,
            );
        }
    }

    return out;
}
