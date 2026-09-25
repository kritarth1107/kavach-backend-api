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
import {
    VOICE_NOT_CAUGHT_REPLY,
    buildPresenceReply,
    isSaheliFallbackCopy,
    messageIsPresenceCheck,
} from "./saheliElderFacts.service";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function kavachWhatsAppLine(): string {
    return config.whatsapp.kavachNumber;
}

const GUEST_WELCOME = `👋 *Welcome to Saheli!*

Hi — I'm *Saheli*, Kavach's family companion on WhatsApp. No extra setup needed; just message me from your phone.

*Kavach* helps families stay connected — gentle check-ins, medicine reminders, and ordering (Instamart/Swiggy/Zepto *or any site* via private browser).

*What I can help with:*
💬 Warm conversations and daily check-ins
📋 Medicine and care reminders
🛒 Food, grocery, medicine, or any-site shop (confirm before pay; soft care tips when relevant)

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

async function withVoiceReply(out: OutboundMessage): Promise<OutboundMessage> {
    if (!out.content?.trim() || isSaheliFallbackCopy(out.content)) return out;
    try {
        const { textToSpeech } = await import("../channels/voicePipeline");
        const spoken = await textToSpeech(out.content);
        if (spoken.audioBuffer || spoken.audioBase64) {
            return {
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
    return out;
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

    // STT runs BEFORE emergency / language / intent checks so spoken emergencies escalate.
    // Voice/audio: download from Meta (or mock audioBase64) + STT, then continue with transcript.
    const isVoiceMedia =
        body.mediaType === "voice" ||
        body.mediaType === "audio" ||
        body.modality === "voice";
    let voiceTranscript: string | undefined;
    const hasVoiceAudio = Boolean(body.mediaUrl || body.audioBase64?.trim());
    const isVoicePlaceholder = (t: string) =>
        !t.trim() || /^\[(voice|audio) (message|shared)\]$/i.test(t.trim());
    if (isVoiceMedia && hasVoiceAudio) {
        const sttStarted = Date.now();
        try {
            const { speechToText } = await import("../channels/voicePipeline");
            let audioBuffer: Buffer | undefined;
            let mimeType: string | undefined;
            if (body.mediaUrl) {
                const { downloadMedia } = await import("../clients/metaWhatsApp.client");
                const media = await downloadMedia(body.mediaUrl);
                audioBuffer = media.buffer;
                mimeType = media.mimeType;
                console.log(
                    `WhatsApp voice media downloaded (${media.buffer.length} bytes, ${media.mimeType}) in ${Date.now() - sttStarted}ms`,
                );
            }
            voiceTranscript = await speechToText({
                audioBuffer,
                audioBase64: audioBuffer ? undefined : body.audioBase64,
                mimeType,
                fallbackText: isVoicePlaceholder(text) ? undefined : text,
            });
            if (voiceTranscript.trim() && !isVoicePlaceholder(voiceTranscript)) {
                text = voiceTranscript.trim();
                console.log(
                    `WhatsApp voice STT ok (${voiceTranscript.length} chars, ${Date.now() - sttStarted}ms) from ${phone.slice(0, 6)}…`,
                );
            } else {
                voiceTranscript = undefined;
                console.warn(
                    `WhatsApp voice STT returned empty transcript (${Date.now() - sttStarted}ms)`,
                );
            }
        } catch (err) {
            voiceTranscript = undefined;
            console.warn(
                `WhatsApp voice STT/download failed after ${Date.now() - sttStarted}ms:`,
                err instanceof Error ? err.message : err,
            );
        }
        // Never push "[voice message]" into the AI / intent router, and never answer with
        // generic error copy: ask warmly (text only — no TTS of a fallback).
        if (!voiceTranscript && isVoicePlaceholder(text)) {
            return outbound(phone, VOICE_NOT_CAUGHT_REPLY);
        }
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

    // "Sun sakte ho?" / "can you hear me" / "hello?" → warm conversational presence reply
    // (never a memory save, never an error). Voice gets a spoken reply too.
    if (messageIsPresenceCheck(text)) {
        const presence = await stampCompanionVoice(buildPresenceReply(), {
            familyId: identity.familyId,
            recipientUserId: identity.userId,
        });
        let presenceOut = outbound(phone, presence);
        if (isVoiceMedia) {
            presenceOut = await withVoiceReply(presenceOut);
        }
        return presenceOut;
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
            return outbound(phone, VOICE_NOT_CAUGHT_REPLY);
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

    // Pharmacy / browser-commerce mid-flow short controls BEFORE dashboard parity —
    // else bare "status" steals and claims *Latest Instamart order* while an Apollo
    // SKU list or grocery awaiting_sku_confirm / browser order is open.
    {
        const waPharmEarly = await WhatsappSession.findOne({ phone }).lean();
        const pd = (waPharmEarly as { pharmacyDraft?: { phase?: string } } | null)?.pharmacyDraft;
        const bd = (
            waPharmEarly as {
                browserTaskDraft?: { phase?: string; lastMessage?: string; partner?: string };
            } | null
        )?.browserTaskDraft;
        const pharmActive =
            Boolean(pd?.phase) && pd!.phase !== "idle" && pd!.phase !== "done";
        const browserActive =
            Boolean(bd?.phase) &&
            bd!.phase !== "idle" &&
            bd!.phase !== "done" &&
            (bd!.phase === "awaiting_sku_confirm" ||
                bd!.phase === "running" ||
                bd!.phase === "awaiting_otp" ||
                bd!.phase === "awaiting_confirm");
        const shortCtrl =
            /^(status|order\s*status|ok|okay|okk|k|confirm|place|yes|haan|[123]|cancel|stop)$/i.test(
                text.trim(),
            );
        if (pharmActive && shortCtrl) {
            const { handlePharmacyWhatsAppTurn } = await import("./pharmacyOrderFlow.service");
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
        if (browserActive && shortCtrl) {
            const { handleBrowserTaskWhatsAppTurn } = await import(
                "./commerceAutomation/browserTaskWhatsApp.service"
            );
            const browserReply = await handleBrowserTaskWhatsAppTurn({
                phone,
                text,
                familyId: identity.familyId,
                actorUserId: identity.userId,
                recipientUserId: subjectUserId,
                actorRole: identity.role,
            });
            if (browserReply) {
                return outbound(phone, browserReply.text);
            }
            // Bare "status" with no handler reply — restating last browser message beats Instamart steal
            if (/^(status|order\s*status)$/i.test(text.trim()) && bd?.lastMessage) {
                return outbound(
                    phone,
                    `Still working on your *${bd.partner || "order"}*…\n\n${bd.lastMessage}`,
                );
            }
        }
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

    // Ride booking (Uber web) — slot-fill, location pin, OTP, confirm-before-book.
    {
        const {
            handleRideWhatsAppTurn,
            messageLooksLikeRideIntent,
        } = await import("./rideBooking/rideWhatsApp.service");
        const waForRide = await WhatsappSession.findOne({ phone }).lean();
        const rideDraft = (waForRide as { rideDraft?: { phase?: string } } | null)?.rideDraft;
        const rideActive =
            rideDraft &&
            rideDraft.phase &&
            rideDraft.phase !== "idle" &&
            rideDraft.phase !== "done";
        if (
            rideActive ||
            messageLooksLikeRideIntent(text) ||
            /^(yeah|yes|yep|haan|ha|ok|okay|sure)$/i.test(text.trim())
        ) {
            // Bare yeah only starts a ride when no pharmacy/browser/order draft is mid-flight.
            const busyElsewhere = Boolean(
                (waForRide as { browserTaskDraft?: unknown } | null)?.browserTaskDraft ||
                    (waForRide as { pharmacyDraft?: unknown } | null)?.pharmacyDraft ||
                    (waForRide as { pendingCommerceOtp?: unknown } | null)?.pendingCommerceOtp ||
                    (waForRide as { orderSessionId?: string } | null)?.orderSessionId,
            );
            if (rideActive || messageLooksLikeRideIntent(text) || ( !busyElsewhere && /^(yeah|yes|yep|haan|ha|ok|okay|sure)$/i.test(text.trim()))) {
                const rideReply = await handleRideWhatsAppTurn({
                    phone,
                    text,
                    familyId: identity.familyId,
                    actorUserId: identity.userId,
                    recipientUserId: subjectUserId,
                    actorRole: identity.role,
                });
                if (rideReply) {
                    return outbound(phone, rideReply.text);
                }
            }
        }
    }

    // Private browser + pharmacy (Apollo / Instamart browse) — elder & caregiver.
    {
        const {
            handleBrowserTaskWhatsAppTurn,
            messageLooksLikeBrowserTask,
        } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        const { handlePharmacyWhatsAppTurn, messageLooksLikePharmacyOrder } = await import(
            "./pharmacyOrderFlow.service"
        );
        const { getCommerceAdapter } = await import("./commerceAutomation");
        const waForCommerce = await WhatsappSession.findOne({ phone }).lean();
        const browserDraft = (waForCommerce as { browserTaskDraft?: { phase?: string } } | null)
            ?.browserTaskDraft;
        const pendingOtp = (waForCommerce as { pendingCommerceOtp?: { partner: string; challengeId?: string } } | null)
            ?.pendingCommerceOtp;

        // Prefer browser-task OTP/confirm state machine when a draft is active.
        if (
            browserDraft &&
            (browserDraft.phase === "awaiting_otp" ||
                browserDraft.phase === "awaiting_confirm" ||
                browserDraft.phase === "awaiting_sku_confirm" ||
                browserDraft.phase === "running")
        ) {
            const browserReply = await handleBrowserTaskWhatsAppTurn({
                phone,
                text,
                familyId: identity.familyId,
                actorUserId: identity.userId,
                recipientUserId: subjectUserId,
                actorRole: identity.role,
            });
            if (browserReply) {
                return outbound(phone, browserReply.text);
            }
        }

        if (pendingOtp && /^\d{4,8}$/.test(text.trim()) && !browserDraft) {
            try {
                const adapter = getCommerceAdapter(
                    pendingOtp.partner as import("./commerceAutomation").CommercePartnerKey,
                );
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

        // Pharmacy conversational path FIRST (Vit C / medicines) — never block WA on Playwright.
        if (
            messageLooksLikePharmacyOrder(text) ||
            (waForCommerce as { pharmacyDraft?: unknown } | null)?.pharmacyDraft
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

        // New browser / browse-help intents (elder + caregiver personal assistant).
        if (
            messageLooksLikeBrowserTask(text) ||
            (waForCommerce as { browserTaskDraft?: unknown } | null)?.browserTaskDraft
        ) {
            const browserReply = await handleBrowserTaskWhatsAppTurn({
                phone,
                text,
                familyId: identity.familyId,
                actorUserId: identity.userId,
                recipientUserId: subjectUserId,
                actorRole: identity.role,
            });
            if (browserReply) {
                return outbound(phone, browserReply.text);
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
        audioBase64: voiceTranscript ? undefined : body.audioBase64,
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
    // Error/fallback copy is never spoken.
    if (isVoiceMedia && out.content?.trim() && !isSaheliFallbackCopy(out.content)) {
        out = await withVoiceReply(out);
    }

    return out;
}
