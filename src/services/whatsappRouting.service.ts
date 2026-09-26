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
import { routeSaheliTurn, rememberTurn, type SaheliRoute } from "./saheliRouter.service";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function kavachWhatsAppLine(): string {
    return config.whatsapp.kavachNumber;
}

const GUEST_WELCOME = `👋 *Hi, I'm Saheli* — Kavach's family companion on WhatsApp.

I can chat and check in, send medicine reminders, and order medicines (Apollo, PharmEasy), groceries & food (Instamart, Swiggy, Zepto, Blinkit, Zomato) or book an Uber — always confirming first, Cash on Delivery.

I don't recognise this number yet. ✨ Sign up at *app.kavach.care*, or ask your caregiver to invite this same number. Our line: *${kavachWhatsAppLine()}*`;

const GUEST_FOLLOWUP = `I don't recognise this number yet 🙏 Sign up at *app.kavach.care*, or ask your caregiver to invite this same WhatsApp number — then I can help right here. 💚`;

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

type FlowDoc = {
    browserTaskDraft?: { phase?: string } & Record<string, unknown>;
    pharmacyDraft?: { phase?: string; partner?: string; searchQuery?: string; items?: Array<{ name?: string }>; catalogOptions?: Array<{ name?: string }> };
    rideDraft?: { phase?: string; pickup?: unknown; drop?: unknown };
    pendingCommerceOtp?: { partner?: string };
    orderSessionId?: string;
    pendingPlaceName?: { addressId: string; familyId: string; at: Date };
    orderChat?: { updatedAt?: number; turns?: Array<{ who: string; text: string }> } & Record<string, unknown>;
} | null;

function liveFlow(d: { phase?: string } | undefined | null): boolean {
    return Boolean(d?.phase) && d!.phase !== "idle" && d!.phase !== "done";
}

/** One-line summaries of this phone's active flows for the router (never another phone's). */
async function buildFlowState(phone: string, doc: FlowDoc, who?: { familyId: string; memberUserId?: string }): Promise<string[]> {
    const { browserDraftSummary, pendingAskSummary } = await import("./commerceAutomation/browserTaskWhatsApp.service");
    const lines: string[] = [];
    const b = browserDraftSummary(doc?.browserTaskDraft as never);
    if (b) lines.push(b);
    const pd = doc?.pharmacyDraft;
    if (liveFlow(pd)) {
        const opts = pd!.catalogOptions?.length ? ` options shown: ${pd!.catalogOptions.slice(0, 5).map((o, i) => `${i + 1}.${o.name}`).join(", ")}` : "";
        lines.push(`pharmacy order phase=${pd!.phase}${pd!.partner ? ` platform=${pd!.partner}` : ""}${pd!.searchQuery ? ` product=${pd!.searchQuery}` : ""}${opts}`);
    }
    if (liveFlow(doc?.rideDraft)) lines.push(`ride booking phase=${doc!.rideDraft!.phase} (collecting pickup/drop/confirm)`);
    if (doc?.pendingCommerceOtp?.partner) lines.push(`waiting for ${doc.pendingCommerceOtp.partner} login SMS OTP`);
    if (doc?.orderSessionId) lines.push("app order session open");
    const ask = pendingAskSummary(phone);
    if (ask) lines.push(ask);
    const oc = doc?.orderChat;
    if (oc?.updatedAt && Date.now() - oc.updatedAt < 25 * 60_000) {
        const lastQ = [...(oc.turns || [])].reverse().find((t) => t.who === "saheli")?.text || "";
        lines.push(
            `ORDER CHAT OPEN (Saheli is helping choose what to order; she last asked: "${lastQ.slice(0, 200)}") — short answers like "snack", "meetha", "veg", "under 200", a number or an item name are intent=order_modify replies to it`,
        );
    }
    if (who?.familyId) {
        const { placesSummary } = await import("./familyAddressBook.service");
        const places = await placesSummary(who.familyId, who.memberUserId).catch(() => null);
        if (places) lines.push(places);
        const pn = doc?.pendingPlaceName;
        if (pn && pn.familyId === who.familyId && Date.now() - new Date(pn.at).getTime() < 30 * 60_000) {
            lines.push("ASKED FOR PLACE NAME (what to call the newly saved place)");
        }
    }
    return lines;
}

const MEDIA_PLACEHOLDER = /^\[(image|document|video|audio|voice|sticker) (message|shared)\]$/i;

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

type WhatsAppInboundBody = {
    from?: string;
    text?: string;
    interactiveId?: string;
    modality?: "text" | "voice";
    audioBase64?: string;
    mediaUrl?: string;
    mediaType?: string;
    mediaCaption?: string;
};

/**
 * Entry point. Wraps the router so every care-recipient reply lands in the caregiver
 * activity feed (inbound is logged inside, after STT, so voice notes carry the transcript).
 */
export async function handleWhatsAppInbound(body: WhatsAppInboundBody): Promise<OutboundMessage> {
    const out = await handleWhatsAppInboundCore(body);
    if (out?.content) rememberTurn(String(body.from ?? ""), "saheli", out.content);
    void (async () => {
        try {
            const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(body.from ?? ""));
            const who = await resolveWhatsAppSender(phone).catch(() => null);
            if (!who || who.role !== FamilyRole.CARE_RECIPIENT || !out?.content?.trim()) return;
            const { logActivity } = await import("./activityLog.service");
            await logActivity({
                familyId: who.familyId,
                recipientUserId: who.userId,
                actorUserId: who.userId,
                kind: "message_out",
                title: out.modality === "voice" ? "Saheli replied (voice)" : "Saheli replied",
                detail: out.content,
            });
        } catch {
            /* never block */
        }
    })();
    return out;
}

async function handleWhatsAppInboundCore(body: WhatsAppInboundBody): Promise<OutboundMessage> {
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

    if (identity.role === FamilyRole.CARE_RECIPIENT) {
        const recipientId = identity.userId;
        const familyId = identity.familyId;
        // Any elder message (even one we can't parse) ends the nudge silence streak right away.
        await import("./saheliCompanion.service")
            .then(({ touchWhatsAppInbound }) => touchWhatsAppInbound(familyId, recipientId))
            .catch(() => undefined);
        void import("./activityLog.service").then(({ logActivity }) =>
            logActivity({
                familyId,
                recipientUserId: recipientId,
                actorUserId: recipientId,
                kind: isVoiceMedia ? "voice_note" : "message_in",
                title: isVoiceMedia ? "Voice note to Saheli" : body.mediaType ? `Shared ${body.mediaType}` : "Message to Saheli",
                detail: text,
            }),
        );
        // Health red flags → caregiver WhatsApp (keyword net immediately, Gemini screen async).
        if (!messageLooksLikeEmergency(text)) {
            void (async () => {
                const { screenElderMessageForRedFlags } = await import("./saheliHealthRedFlag.service");
                const elderName = await getFamilyMembersList(familyId, recipientId)
                    .then((p) => p.members.find((m) => m.userId === recipientId)?.name)
                    .catch(() => undefined);
                await screenElderMessageForRedFlags({
                    familyId,
                    recipientUserId: recipientId,
                    elderName: elderName || undefined,
                    text,
                });
            })().catch(() => undefined);
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

    // ── Understanding: ONE Gemini structured-output call per turn (message + recent turns +
    // this phone's active flows). Regex gates below run only when this returns null.
    let route: SaheliRoute | null = null;
    if (!body.interactiveId && text && !MEDIA_PLACEHOLDER.test(text)) {
        const flowDoc = (await WhatsappSession.findOne({ phone }).lean()) as FlowDoc;
        route = await routeSaheliTurn({
            phone,
            text,
            role: isCaregiver(identity.role) ? "caregiver" : "elder",
            state: await buildFlowState(phone, flowDoc, {
                familyId: identity.familyId,
                memberUserId: isCaregiver(identity.role) ? undefined : identity.userId,
            }),
        }).catch((err) => {
            console.warn("[saheli-router] failed:", err instanceof Error ? err.message : err);
            return null;
        });
        console.log(
            `[saheli-router] ${route ? `${route.intent}/${route.control} cat=${route.category ?? "-"} p=${route.partners.join("+") || "-"} q=${route.productQuery ? "y" : "n"} conf=${route.confidence} ${route.latencyMs}ms` : "null → regex fallback"}`,
        );
    }
    rememberTurn(phone, "user", text);
    if (!route && !body.interactiveId) {
        // Fallback only (model unavailable): spoken ordinals → the digit the rule gates understand.
        const ord = text.trim().toLowerCase().replace(/[.!]+$/, "");
        const ORD: Record<string, string> = {
            pehla: "1", pahla: "1", first: "1", "1st": "1",
            dusra: "2", doosra: "2", second: "2", "2nd": "2",
            teesra: "3", tisra: "3", third: "3", "3rd": "3",
            chautha: "4", fourth: "4", "4th": "4", panchva: "5", fifth: "5", "5th": "5",
        };
        const m = ord.match(/^(?:the\s+)?([a-z0-9]+)(?:\s+(?:wala|wali|vala|vali|one|option))?(?:\s+please)?$/);
        if (m && ORD[m[1]!]) text = ORD[m[1]!]!;
    }

    // AI red-flag layer ON TOP of the keyword net (the net above always runs first).
    if (identity.role === FamilyRole.CARE_RECIPIENT && route?.intent === "emergency" && route.confidence >= 0.75) {
        const { triggerEmergencyEscalation, elderEmergencyReply } = await import("./saheliEmergency.service");
        const membersPayload = await getFamilyMembersList(identity.familyId, identity.userId);
        const displayName = membersPayload.members.find((m) => m.userId === identity!.userId)?.name?.trim() || "there";
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
        setOwnPreferredLanguage,
    } = await import("./saheliCompanion.service");
    if (identity.role === FamilyRole.CARE_RECIPIENT) {
        await touchWhatsAppInbound(identity.familyId, identity.userId);

        let langChange = route ? null : parseLanguageChangeMessage(text);
        if (route?.intent === "language_change") {
            langChange =
                parseLanguageChangeMessage(`speak ${route.newLanguage || ""}`) || parseLanguageChangeMessage(text);
            if (!langChange) {
                return outbound(
                    phone,
                    "I can talk in English, Hindi, Hinglish, Tamil or Kannada 🙂 Which one would you like?",
                );
            }
        }
        if (langChange) {
            // Elder's own setting (updateCompanionProfile is caregiver-only and threw 403 here).
            await setOwnPreferredLanguage(identity.familyId, identity.userId, langChange);
            return outbound(phone, languageChangeConfirmation(langChange));
        }
    }

    // "Sun sakte ho?" / "can you hear me" / "hello?" → warm conversational presence reply
    // (never a memory save, never an error). Voice gets a spoken reply too.
    if (route ? route.intent === "presence_check" : messageIsPresenceCheck(text)) {
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

    // ── Routed dispatch (Gemini understood the turn). legacyGates = regex fallback. ──
    let legacyGates = true;
    let allowDashboard = true;
    if (route) {
        const routedOut = await dispatchRoutedTurn({
            route,
            text,
            phone,
            familyId: identity.familyId,
            actorUserId: identity.userId,
            recipientUserId: subjectUserId,
            actorRole: identity.role,
            mediaUrl: body.mediaUrl,
            isRxPhoto: body.mediaType === "image" || body.mediaType === "document",
        });
        if (routedOut.reply) {
            const { recordWhatsAppAiDebug } = await import("./whatsappWebhookLog.service");
            recordWhatsAppAiDebug({
                familyId: identity.familyId,
                recipientUserId: subjectUserId,
                actorUserId: identity.userId,
                replySource: "saheliRouter",
                fallbackUsed: `router:${route.intent}`,
            });
            return outbound(phone, routedOut.reply);
        }
        legacyGates = routedOut.legacyGates;
        allowDashboard = routedOut.allowDashboard;
    }

    // Pharmacy / browser-commerce mid-flow short controls BEFORE dashboard parity —
    // else bare "status" steals and claims *Latest Instamart order* while an Apollo
    // SKU list or grocery awaiting_sku_confirm / browser order is open.
    if (legacyGates) {
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
                bd!.phase === "awaiting_restaurant_pick" ||
                bd!.phase === "running" ||
                bd!.phase === "awaiting_otp" ||
                bd!.phase === "awaiting_confirm");
        const shortCtrl =
            /^(status|order\s*status|ok|okay|okk|k|confirm|place|place\s*order|yes|haan|[1-9]|cancel|stop|order\s*again|re-?order)$/i.test(
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

    const dashboardAction = !allowDashboard
        ? { handled: false as const, reply: undefined, interactiveButtons: undefined }
        : await tryHandleWhatsAppDashboardAction({
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
    if (legacyGates) {
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
    if (legacyGates) {
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
                browserDraft.phase === "awaiting_address" ||
                browserDraft.phase === "awaiting_address_confirm" ||
                browserDraft.phase === "awaiting_confirm" ||
                browserDraft.phase === "awaiting_sku_confirm" ||
                browserDraft.phase === "awaiting_restaurant_pick" ||
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

    const orderFlowReply = !legacyGates
        ? null
        : await tryHandleWhatsAppOrderTurn({
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
        return handleWhatsAppInboundCore({
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

    if (legacyGates && isCaregiver(identity.role)) {
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

const COMMERCE_INTENTS = new Set(["order_new", "order_modify", "order_control", "restaurant_list", "otp_code"]);
/** Intents that are never a reply to an open order/ride/pharmacy step. */
const NOT_A_FLOW_REPLY = new Set([
    "emergency",
    "health_concern",
    "language_change",
    "presence_check",
    "caregiver_share",
    "account_info",
    "order_status_history",
    "reminder_or_meds",
]);
/** Non-commerce intents whose slots the dashboard-parity executor fills (reminders, approvals, DND, briefs…). */
const DASHBOARD_INTENTS = new Set(["reminder_or_meds", "caregiver_share", "account_info", "order_status_history"]);

/** The usual's health check + search + card, pushed as a follow-up (the ack already went out). */
async function runUsualInBackground(
    input: { phone: string; familyId: string; actorUserId: string; recipientUserId: string; actorRole: FamilyRole },
    route: SaheliRoute,
    text: string,
    u: import("../models/elderUsuals.model").UsualItem,
): Promise<void> {
    const { pushWhatsAppBrowserFollowUp } = await import("./commerceAutomation/browserProgressNotify.service");
    const push = (t: string) =>
        t.trim()
            ? pushWhatsAppBrowserFollowUp({ phone: input.phone, familyId: input.familyId, recipientUserId: input.recipientUserId, text: t }).catch(() => false)
            : Promise.resolve(false);
    try {
        // Health check still runs on a usual (e.g. mithai with diabetes) — same order chat, same rules.
        const { loadHealthProfile } = await import("./commerceAutomation/orderChat/healthProfile");
        const hp = await loadHealthProfile(input.familyId, input.recipientUserId).catch(() => null);
        if (hp && (hp.notes.length || hp.medicines.length || hp.profileMd.trim())) {
            const { orderChatTurn } = await import("./commerceAutomation/orderChat/orderChat.service");
            const d = await orderChatTurn({
                ...input,
                text: `${text} (her usual: ${u.name})`,
                language: route.language,
                routeHint: { category: u.category, productQuery: u.name, partners: [u.partner], restaurantName: u.restaurantName || null, addressNickname: u.placeNickname || null, intent: "order_new" },
                state: null,
            });
            if (d.action === "reply") {
                const { clearUsualCtx } = await import("./commerceAutomation/usuals/usuals.service");
                clearUsualCtx(input.phone);
                await push(d.text);
                return;
            }
            if (d.action === "search" && conceptKeyDiffers(d.query, u)) {
                // The model steered to something else (e.g. a health-guided swap) → normal search.
                const { clearUsualCtx } = await import("./commerceAutomation/usuals/usuals.service");
                clearUsualCtx(input.phone);
                const { handleRoutedCommerceTurn } = await import("./commerceAutomation/browserTaskWhatsApp.service");
                const r = await handleRoutedCommerceTurn(input, { ...route, productQuery: d.query, category: d.category, partners: d.partner ? [d.partner] : [], blockedItem: null }, text);
                if (r?.text && !r.deferred) await push(r.text);
                return;
            }
        }
        const r2: SaheliRoute = {
            ...route,
            intent: "order_new",
            control: "none",
            pickIndex: null,
            partnerOnly: false,
            productQuery: u.name,
            category: u.category,
            partners: [u.partner],
            restaurantName: u.restaurantName || null,
            addressNickname: route.addressNickname || u.placeNickname || null,
            blockedItem: null,
        };
        const { handleRoutedCommerceTurn } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        const r = await handleRoutedCommerceTurn(input, r2, text);
        if (r?.delegatePharmacyText) {
            const { handlePharmacyWhatsAppTurn } = await import("./pharmacyOrderFlow.service");
            const pr = await handlePharmacyWhatsAppTurn({ ...input, text: r.delegatePharmacyText });
            if (pr) await push(r.lead ? `${r.lead}\n\n${pr.text}` : pr.text);
        } else if (r?.text && !r.deferred) await push(r.text);
        else if (r?.deferred && r.lead) await push(r.lead);
    } catch (err) {
        console.warn("[usuals] background failed:", err instanceof Error ? err.message : err);
        await push("That didn't load for me just now 🙏 Please ask me again in a minute.");
    }
}
function conceptKeyDiffers(q: string, u: { name: string }): boolean {
    const n = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
    return !n(u.name).includes(n(q)) && !n(q).includes(n(u.name));
}

/**
 * Executes a Gemini route. Returns a reply, or tells the caller whether the regex gates
 * may still run (only for commerce intents the executors couldn't place).
 */
async function dispatchRoutedTurn(a: {
    route: SaheliRoute;
    text: string;
    phone: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole;
    mediaUrl?: string;
    isRxPhoto: boolean;
}): Promise<{ reply?: string; legacyGates: boolean; allowDashboard: boolean }> {
    const { route, text } = a;
    const doc = (await WhatsappSession.findOne({ phone: a.phone }).lean()) as FlowDoc;
    const bd = doc?.browserTaskDraft;
    const pd = doc?.pharmacyDraft;
    const rd = doc?.rideDraft;
    const input = {
        phone: a.phone,
        familyId: a.familyId,
        actorUserId: a.actorUserId,
        recipientUserId: a.recipientUserId,
        actorRole: a.actorRole,
    };
    const commerce = COMMERCE_INTENTS.has(route.intent);
    const flowReply = !NOT_A_FLOW_REPLY.has(route.intent);
    // Care guardrail: tobacco / gutka / vapes / alcohol are refused BEFORE any search, on every
    // store and path (MCP, browser, Apollo). Router decides; keyword backstop under it.
    {
        const { detectBlockedItem, blockedReply, logBlockedRequest, isBlockedCategory } = await import(
            "./commerceAutomation/blockedItems"
        );
        const buying = route.intent === "order_new" || route.intent === "order_modify" || route.intent === "restaurant_list";
        const kw = buying ? detectBlockedItem(route.productQuery) || detectBlockedItem(text) : null;
        const cat = buying && isBlockedCategory(route.blockedItem) ? route.blockedItem : kw?.cat;
        if (cat) {
            await logBlockedRequest({
                ...input,
                cat,
                text,
                stage: "router",
                source: route.blockedItem ? "gemini_router" : "keywords",
            });
            return { reply: blockedReply(cat, text, route.language), legacyGates: false, allowDashboard: false };
        }
    }
    // Instinct: she turned down the single item on a card / swapped it → remember why.
    if (liveFlow(bd) && (bd!.phase === "awaiting_sku_confirm" || bd!.phase === "awaiting_mcp_confirm" || bd!.phase === "awaiting_confirm")) {
        const b = bd as unknown as { selectedSku?: { name: string; partner?: string }; catalogOptions?: Array<{ name: string; partner?: string }>; partner?: string };
        const one = b.selectedSku || (b.catalogOptions?.length === 1 ? b.catalogOptions[0] : null);
        const swap = (route.intent === "order_modify" || route.intent === "order_new") && route.productQuery && one && !one.name.toLowerCase().includes(route.productQuery.toLowerCase());
        if (one?.name && (route.control === "cancel" || swap)) {
            void import("./commerceAutomation/usuals/usuals.service").then(({ noteDecline }) =>
                noteDecline(
                    { familyId: a.familyId, recipientUserId: a.recipientUserId },
                    { item: one.name, partner: String(one.partner || b.partner || ""), reason: text.slice(0, 160), replacedWith: swap ? route.productQuery : null },
                ),
            );
        }
    }
    // Instinct: a familiar ask ("doodh mangwa do") → her usual. Instant ack now; the store work
    // (health check → live search → one confirm card) runs in the background and is pushed.
    if (route.intent === "order_new" && !a.mediaUrl && !a.isRxPhoto && !liveFlow(bd)) {
        const { orderChatActive } = await import("./commerceAutomation/orderChat/orderChat.service");
        if (!orderChatActive(doc?.orderChat)) {
            const U = await import("./commerceAutomation/usuals/usuals.service");
            const hit = await U.resolveUsual(
                { familyId: a.familyId, recipientUserId: a.recipientUserId },
                { query: route.productQuery, text, category: route.category, partners: route.partners },
            ).catch(() => null);
            if (hit?.usual) {
                const u = hit.usual;
                U.setUsualCtx(a.phone, { usual: u, rejections: hit.rejections, query: route.productQuery || text, ackSent: true });
                void runUsualInBackground(input, route, text, u);
                return { reply: U.usualAck(u), legacyGates: false, allowDashboard: false };
            }
        }
    }
    // Conversational ordering (product rule): a vague ask never jumps to a store search — Gemini
    // chats (one question, 2–3 suggestions) until it's specific, and checks the item against her
    // health profile first. A clear specific ask goes straight to the search below.
    {
        const { orderChatActive, orderChatTurn } = await import("./commerceAutomation/orderChat/orderChat.service");
        const oc = orderChatActive(doc?.orderChat) ? (doc!.orderChat as never) : null;
        const media = Boolean(a.mediaUrl || a.isRxPhoto);
        const newAsk = (route.intent === "order_new" || route.intent === "restaurant_list") && !media;
        const chatReply = Boolean(oc) && !media && !NOT_A_FLOW_REPLY.has(route.intent) && route.intent !== "ride" && route.intent !== "otp_code";
        if (newAsk || chatReply) {
            // No long silences: if the order chat is slow, a short ack goes out first.
            let slowAck: NodeJS.Timeout | null = null;
            if (newAsk && !oc) {
                slowAck = setTimeout(() => {
                    void import("./commerceAutomation/browserProgressNotify.service").then(({ pushWhatsAppBrowserFollowUp }) =>
                        pushWhatsAppBrowserFollowUp({ phone: a.phone, familyId: a.familyId, recipientUserId: a.recipientUserId, text: route.language === "en" ? "On it 👍" : "Dekh rahi hoon 👍" }).catch(() => false),
                    );
                }, 2500);
            }
            const d = await orderChatTurn({
                phone: a.phone,
                familyId: a.familyId,
                recipientUserId: a.recipientUserId,
                actorUserId: a.actorUserId,
                text,
                language: route.language,
                routeHint: {
                    category: route.category,
                    productQuery: route.productQuery,
                    partners: route.partners,
                    restaurantName: route.restaurantName,
                    addressNickname: route.addressNickname,
                    intent: route.intent,
                },
                state: oc,
            }).finally(() => slowAck && clearTimeout(slowAck));
            if (d.action === "reply") return { reply: d.text, legacyGates: false, allowDashboard: false };
            if (d.action === "search" || d.action === "restaurants") {
                const r2: SaheliRoute =
                    d.action === "search"
                        ? {
                              ...route,
                              intent: "order_new",
                              control: "none",
                              pickIndex: null,
                              partnerOnly: false,
                              productQuery: d.query,
                              category: d.category,
                              partners: d.partner ? [d.partner] : [],
                              restaurantName: d.restaurantName,
                              addressNickname: d.addressNickname ?? route.addressNickname,
                              blockedItem: null,
                          }
                        : {
                              ...route,
                              intent: "restaurant_list",
                              control: "none",
                              pickIndex: null,
                              partnerOnly: false,
                              productQuery: null,
                              category: "food",
                              partners: ["swiggy"],
                              restaurantName: null,
                              addressNickname: d.addressNickname ?? route.addressNickname,
                              blockedItem: null,
                          };
                const { handleRoutedCommerceTurn } = await import("./commerceAutomation/browserTaskWhatsApp.service");
                const r = await handleRoutedCommerceTurn(input, r2, text);
                if (r?.delegatePharmacyText) {
                    const { handlePharmacyWhatsAppTurn } = await import("./pharmacyOrderFlow.service");
                    const pr = await handlePharmacyWhatsAppTurn({ ...input, text: r.delegatePharmacyText });
                    if (pr) return { reply: r.lead ? `${r.lead}\n\n${pr.text}` : pr.text, legacyGates: false, allowDashboard: false };
                } else if (r?.text) return { reply: r.text, legacyGates: false, allowDashboard: false };
            }
            // "pass" (not about the order) → normal handling below.
        }
    }
    const pharmacyTurn = async (t: string) => {
        const { handlePharmacyWhatsAppTurn } = await import("./pharmacyOrderFlow.service");
        return handlePharmacyWhatsAppTurn({ ...input, text: t, mediaUrl: a.mediaUrl, isRxPhoto: a.isRxPhoto });
    };
    const rideTurn = async (t: string) => {
        const { handleRideWhatsAppTurn } = await import("./rideBooking/rideWhatsApp.service");
        return handleRideWhatsAppTurn({ ...input, text: t });
    };
    /** Canonical control text for flows that parse short replies. Money guardrail: confirm stays verbatim. */
    const canonical = (): string | null => {
        if (route.intent === "otp_code") {
            const code = (route.otpCode || text).replace(/\D/g, "");
            return /^\d{4,8}$/.test(code) ? code : null; // strict numeric check after the model
        }
        switch (route.control) {
            case "pick":
                return route.pickIndex ? String(route.pickIndex) : text;
            case "cancel":
                return "cancel";
            case "status":
                return "status";
            case "retry":
                return "retry";
            case "order_again":
                return "order again";
            default:
                return text; // confirm + everything else verbatim
        }
    };

    // "What should I call this place?" is asked once — any other reply moves on.
    if (doc?.pendingPlaceName && !route.placeName) {
        await WhatsappSession.updateOne({ phone: a.phone }, { $unset: { pendingPlaceName: 1 } }).catch(() => undefined);
    }
    // Saved places offered for an order: answers go to the address step; unrelated chat doesn't.
    if (
        liveFlow(bd) &&
        bd!.phase === "awaiting_address_confirm" &&
        flowReply &&
        (commerce || route.control !== "none" || route.addressNickname || route.addressText)
    ) {
        const { handleRoutedCommerceTurn } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        const r = await handleRoutedCommerceTurn(input, route, text);
        if (r?.delegatePharmacyText) {
            const pr = await pharmacyTurn(r.delegatePharmacyText);
            if (pr) return { reply: r.lead ? `${r.lead}\n\n${pr.text}` : pr.text, legacyGates: false, allowDashboard: false };
        } else if (r?.text) return { reply: r.text, legacyGates: false, allowDashboard: false };
    }
    // Name for a newly saved place.
    if (route.placeName && doc?.pendingPlaceName) {
        const { handleRoutedCommerceTurn } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        const r = await handleRoutedCommerceTurn(input, route, text);
        if (r?.text) return { reply: r.text, legacyGates: false, allowDashboard: false };
    }
    // 1) Slot-filling steps get the raw message unless it's clearly something else.
    if (liveFlow(bd) && bd!.phase === "awaiting_address" && flowReply) {
        const { handleBrowserTaskWhatsAppTurn, handleRoutedCommerceTurn } = await import(
            "./commerceAutomation/browserTaskWhatsApp.service"
        );
        const r = commerce
            ? await handleRoutedCommerceTurn(input, route, text)
            : await handleBrowserTaskWhatsAppTurn({ ...input, text, routed: true });
        if (r) return { reply: r.text, legacyGates: false, allowDashboard: false };
    }
    const newOrder = route.intent === "order_new" || route.intent === "restaurant_list";
    // Ride slots the model extracted → the "from X to Y" form the ride slot-filler parses.
    // Places are resolved near THIS elder's own saved address ("station" → "station, Bhopal";
    // "home"/"ghar" → their saved address) — otherwise the geocoder picks another country.
    let rideText = text;
    if (route.ridePickup || route.rideDrop) {
        // Saved family places first ("clinic se ghar" → Clinic → Home), then "near my city".
        const { listPlaces, matchPlace, pickDefault } = await import("./familyAddressBook.service");
        const { cityOf } = await import("./commerceAutomation/kavachAddress");
        const places = await listPlaces(a.familyId, { memberUserId: a.recipientUserId }).catch(() => []);
        const home = pickDefault(places, a.recipientUserId);
        const city = home ? home.city || cityOf(home.full) || "" : "";
        const place = (p: string) => {
            const saved = matchPlace(places, p, a.recipientUserId);
            if (saved) return saved.full;
            return city && !new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(p) ? `${p}, ${city}` : p;
        };
        rideText = [route.ridePickup ? `from ${place(route.ridePickup)}` : "", route.rideDrop ? `to ${place(route.rideDrop)}` : ""]
            .filter(Boolean)
            .join(" ");
    }
    if (liveFlow(rd) && (route.intent === "ride" || (flowReply && !newOrder && !liveFlow(bd) && !liveFlow(pd)))) {
        const t = route.intent === "otp_code" || route.intent === "order_control" ? canonical() ?? text : rideText;
        const r = await rideTurn(t);
        if (r) return { reply: r.text, legacyGates: false, allowDashboard: false };
    }
    if (route.intent === "ride") {
        const r = await rideTurn(liveFlow(rd) ? rideText : route.ridePickup || route.rideDrop ? `book a cab ${rideText}` : text);
        if (r) return { reply: r.text, legacyGates: false, allowDashboard: false };
        return { legacyGates: true, allowDashboard: false };
    }

    if (commerce) {
        const browserLive = liveFlow(bd);
        // Pharmacy draft owns controls when no browser order is open.
        if (liveFlow(pd) && !browserLive && (route.intent === "order_control" || route.intent === "otp_code" || a.isRxPhoto)) {
            const t = canonical();
            if (t) {
                const r = await pharmacyTurn(t);
                if (r) return { reply: r.text, legacyGates: false, allowDashboard: false };
            }
        }
        const { handleRoutedCommerceTurn } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        const r = await handleRoutedCommerceTurn(input, route, text);
        if (r?.delegatePharmacyText) {
            const pr = await pharmacyTurn(r.delegatePharmacyText);
            if (pr) return { reply: r.lead ? `${r.lead}\n\n${pr.text}` : pr.text, legacyGates: false, allowDashboard: false };
        } else if (r?.text) {
            return { reply: r.text, legacyGates: false, allowDashboard: false };
        }
        if (liveFlow(pd) && route.intent !== "order_new") {
            const t = canonical();
            if (t) {
                const pr = await pharmacyTurn(t);
                if (pr) return { reply: pr.text, legacyGates: false, allowDashboard: false };
            }
        }
        // Digits with nothing waiting for a code → just chat (never an order lookup).
        if (route.intent === "otp_code" && !doc?.pendingCommerceOtp && !liveFlow(bd) && !liveFlow(pd) && !liveFlow(rd)) {
            return { legacyGates: false, allowDashboard: false };
        }
        // Couldn't place it (e.g. "confirm" for an app order session / caregiver approval) → rule executors.
        return { legacyGates: true, allowDashboard: true };
    }

    // Pharmacy step that expects free text (e.g. Rx photo) while the model saw chat.
    if (a.isRxPhoto && liveFlow(pd)) {
        const r = await pharmacyTurn(text);
        if (r) return { reply: r.text, legacyGates: false, allowDashboard: false };
    }
    return { legacyGates: false, allowDashboard: DASHBOARD_INTENTS.has(route.intent) };
}
