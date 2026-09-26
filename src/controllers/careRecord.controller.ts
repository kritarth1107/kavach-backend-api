import { createHmac, timingSafeEqual } from "crypto";
import { Request, Response } from "express";
import config from "../config/app.config";
import { ChannelType } from "../types/careRecord.types";
import { whatsAppMockAdapter, phoneMockAdapter, smartSpeakerMockAdapter } from "../channels/whatsappMock.adapter";
import {
    listCareRecordEvents,
    getCareRecordTimeline,
    getWeeklyMetrics,
} from "../services/careRecord.service";
import { generateCareBrief, generateDoctorBrief } from "../services/careBrief.service";
import {
    suggestOrder,
    listPendingApprovals,
    approveOrder,
    payOrder,
    rejectOrder,
    listOrderHistory,
} from "../services/order.service";
import { upsertChannelIdentity, listChannelIdentities } from "../services/identityResolver.service";
import { getFamilyIntegrations } from "../services/integration.service";
import { getFamilyForActor, requirePermission } from "../services/careRecordAuth.service";
import { partnerLabel } from "../services/saheliOrder.service";

export async function getCareRecordEventsHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const typeFilter = req.query.type as string | undefined;
    const types = typeFilter ? [typeFilter as never] : undefined;

    const events = await listCareRecordEvents({
        familyId,
        subjectUserId,
        types,
        limit: Number(req.query.limit ?? 50),
    });

    res.json({ success: true, data: { events } });
}

export async function getCareRecordTimelineHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const events = await getCareRecordTimeline({
        familyId,
        subjectUserId,
        limit: Number(req.query.limit ?? 100),
    });

    res.json({ success: true, data: { events } });
}

export async function getCareRecordMetricsHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    const metrics = await getWeeklyMetrics(familyId, subjectUserId);
    res.json({ success: true, data: metrics });
}

export async function getCareBriefHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const brief = await generateCareBrief(familyId, subjectUserId, req.user!.userId);
    res.json({ success: true, data: brief });
}

export async function getDoctorBriefHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const brief = await generateDoctorBrief(familyId, subjectUserId, req.user!.userId);
    res.json({ success: true, data: brief });
}

export async function getPendingApprovalsHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const orders = await listPendingApprovals(familyId, req.user!.userId);
    res.json({
        success: true,
        data: {
            orders: orders.map((o) => ({
                order_id: o.orderId,
                status: o.status,
                partner: o.partner,
                partner_label: partnerLabel(o.partner),
                partner_address_id: o.partnerAddressId ?? null,
                total_paise: o.totalPaise,
                items: o.items,
                deep_link: o.deepLink,
                subject_user_id: o.subjectUserId,
                created_at: o.createdAt?.toISOString() ?? null,
            })),
        },
    });
}

export async function postApproveOrderHandler(req: Request, res: Response) {
    const { familyId, orderId } = req.params;
    const order = await approveOrder(familyId, orderId, req.user!.userId);
    res.json({ success: true, data: { order_id: order.orderId, status: order.status } });
}

export async function postPayOrderHandler(req: Request, res: Response) {
    const { familyId, orderId } = req.params;
    const partnerAddressId = String(req.body?.partnerAddressId ?? req.body?.addressId ?? "").trim() || undefined;
    const deliveryAddress = String(req.body?.deliveryAddress ?? "").trim() || undefined;
    const result = await payOrder(familyId, orderId, req.user!.userId, {
        partnerAddressId,
        deliveryAddress,
    });
    res.json({
        success: true,
        data: {
            order_id: result.order.orderId,
            status: result.order.status,
            payment_id: result.payment.paymentId,
            payment_link: result.payment.paymentLink ?? result.payment.deepLink ?? null,
            provider: result.payment.provider,
        },
    });
}

export async function postRejectOrderHandler(req: Request, res: Response) {
    const { familyId, orderId } = req.params;
    const order = await rejectOrder(familyId, orderId, req.user!.userId);
    res.json({ success: true, data: { order_id: order.orderId, status: order.status } });
}

export async function getOrderHistoryHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const orders = await listOrderHistory(familyId, req.user!.userId);
    res.json({
        success: true,
        data: {
            orders: orders.map((o) => ({
                order_id: o.orderId,
                status: o.status,
                partner: o.partner,
                partner_label: partnerLabel(o.partner),
                partner_address_id: o.partnerAddressId ?? null,
                total_paise: o.totalPaise,
                items: o.items,
                deep_link: o.deepLink,
                subject_user_id: o.subjectUserId,
                suggested_by: o.suggestedBy ?? null,
                created_at: o.createdAt?.toISOString() ?? null,
            })),
        },
    });
}

export async function getIntegrationsHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const data = await getFamilyIntegrations(familyId, req.user!.userId);
    res.json({ success: true, data });
}

export async function postSuggestOrderHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = req.params;
    const items = req.body?.items ?? [];
    const order = await suggestOrder({
        familyId,
        subjectUserId,
        actorUserId: req.user!.userId,
        items,
        partner: req.body?.partner,
        notes: req.body?.notes,
        deliveryAddress: req.body?.deliveryAddress,
    });
    res.status(201).json({
        success: true,
        data: {
            order_id: order.orderId,
            status: order.status,
            total_paise: order.totalPaise,
            deep_link: order.deepLink,
        },
    });
}

export async function postChannelIdentityHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "manage_schedule");

    const row = await upsertChannelIdentity({
        channelType: req.body.channelType,
        channelIdentifier: req.body.channelIdentifier,
        familyId,
        userId: req.body.userId,
        role: req.body.role,
        label: req.body.label,
    });

    res.status(201).json({ success: true, data: row });
}

export async function getChannelIdentitiesHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    await getFamilyForActor(familyId, actorUserId);
    const rows = await listChannelIdentities(familyId);
    res.json({ success: true, data: { identities: rows } });
}

/**
 * Mock channel endpoints impersonate any phone and (peek) read that person's messages, so in
 * production they need the mock secret header. Unauthorized → 404 (don't advertise the route).
 */
function isMockAuthorized(req: Request): boolean {
    if (process.env.NODE_ENV !== "production" && process.env.WHATSAPP_MOCK_OPEN === "1") return true;
    const expected = process.env.WHATSAPP_MOCK_SECRET?.trim();
    const provided = String(req.get("x-kavach-mock-secret") ?? "");
    if (!expected || !provided || provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function postPrivacyAudit(req: Request, res: Response) {
    if (!isMockAuthorized(req)) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
    }
    const { runAddressLeakAudit } = await import("../services/privacyAudit.service");
    const data = await runAddressLeakAudit({
        ownerPhone: String(req.body?.ownerPhone || ""),
        since: typeof req.body?.since === "string" ? req.body.since : undefined,
        cleanup: req.body?.cleanup === true,
    });
    res.json({ success: true, data });
}

export async function postSmokeFixtures(req: Request, res: Response) {
    if (!isMockAuthorized(req)) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
    }
    const { manageSmokeFixtures } = await import("../services/smokeFixtures.service");
    const data = await manageSmokeFixtures(req.body?.action === "delete" ? "delete" : "create");
    res.json({ success: true, data });
}

export async function postWhatsAppMockWebhook(req: Request, res: Response) {
    if (!isMockAuthorized(req)) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
    }
    const { buildWhatsAppMockPeek } = await import("../services/whatsappMockPeek.service");
    // {"from":"91…","peek":true} → read-only: latest Saheli outbound messages (incl. the async
    // confirm-before-pay card) + draft summary. Does NOT route any message.
    if (req.body?.peek === true || req.body?.peek === "screenshot") {
        const from = typeof req.body?.from === "string" ? req.body.from : "";
        if (!from.replace(/\D/g, "")) {
            res.status(400).json({ success: false, message: "from is required" });
            return;
        }
        res.json({
            success: true,
            data: {
                peek: await buildWhatsAppMockPeek(from, { includeScreenshot: req.body?.peek === "screenshot" }),
                guestDebug: (await import("../services/commerceAutomation/browserTaskWhatsApp.service")).lastGuestDebugFor(
                    (await import("../services/identityResolver.service")).normalizeChannelIdentifier(ChannelType.WHATSAPP, from),
                ),
            },
        });
        return;
    }
    const { handleWhatsAppInbound } = await import("../services/whatsappInbound.service");
    const mockMessageId =
        typeof req.body?.messageId === "string" ? req.body.messageId.trim() : "";
    if (mockMessageId) {
        const { claimWhatsAppInboundMessage } = await import(
            "../services/whatsappInboundDedupe.service"
        );
        if (!(await claimWhatsAppInboundMessage(`mock:${mockMessageId}`, req.body?.from))) {
            res.json({ success: true, data: { duplicate: true, reply: null } });
            return;
        }
    }
    let reply: Awaited<ReturnType<typeof handleWhatsAppInbound>>;
    try {
        reply = await handleWhatsAppInbound(req.body);
    } catch (err) {
        console.warn("mock WhatsApp inbound failed:", err instanceof Error ? err.message : err);
        res.status(500).json({ success: false, message: err instanceof Error ? err.message.slice(0, 200) : "failed" });
        return;
    }
    const saheli =
        typeof req.body?.from === "string" ? await buildWhatsAppMockPeek(req.body.from).catch(() => null) : null;
    const { lastRouteFor } = await import("../services/saheliRouter.service");
    const route = typeof req.body?.from === "string" ? lastRouteFor(req.body.from) : null;
    const { lastGuestDebugFor } = await import("../services/commerceAutomation/browserTaskWhatsApp.service");
    const { normalizeChannelIdentifier } = await import("../services/identityResolver.service");
    const guestDebug =
        typeof req.body?.from === "string" ? lastGuestDebugFor(normalizeChannelIdentifier(ChannelType.WHATSAPP, req.body.from)) : null;
    res.json({ success: true, data: { reply, saheli, route, guestDebug } });
}

export async function getWhatsAppMetaWebhook(req: Request, res: Response) {
    const { getMetaWebhookVerifyToken } = await import("../clients/metaWhatsApp.client");
    const mode = String(req.query["hub.mode"] ?? "");
    const token = String(req.query["hub.verify_token"] ?? "");
    const challenge = String(req.query["hub.challenge"] ?? "");

    if (mode === "subscribe" && token === getMetaWebhookVerifyToken()) {
        res.status(200).type("text/plain").send(challenge);
        return;
    }

    res.status(403).json({ success: false, message: "Webhook verification failed" });
}

function isValidHealthSecret(provided: unknown): boolean {
    const expected = config.health.secret;
    if (!expected || typeof provided !== "string" || !provided) return false;
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function isValidWebhookDebugAuth(req: Request): boolean {
    if (isValidHealthSecret(req.query.HEALTH_SECRET)) return true;
    // The old verify token was committed to a public repo; accept it only once it's rotated
    // (WHATSAPP_META_VERIFY_TOKEN_ROTATED=1 set together with a new secret token).
    if (process.env.WHATSAPP_META_VERIFY_TOKEN_ROTATED !== "1") return false;

    const provided = String(req.query.verify_token ?? "");
    const expected = config.whatsapp.meta.webhookVerifyToken;
    if (!provided || !expected || provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export async function getWhatsAppMetaWebhookDebug(req: Request, res: Response) {
    const {
        getWhatsAppWebhookDebugSnapshot,
        listWhatsAppWebhookEvents,
    } = await import("../services/whatsappWebhookLog.service");

    if (!isValidWebhookDebugAuth(req)) {
        res.status(401).json({
            success: false,
            message:
                "Unauthorized — pass ?verify_token=YOUR_META_VERIFY_TOKEN or ?HEALTH_SECRET=...",
        });
        return;
    }

    const { probeMetaWhatsAppCredentials } = await import("../clients/metaWhatsApp.client");
    const { getTtsDebugSnapshot } = await import("../channels/voicePipeline");

    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const snapshot = getWhatsAppWebhookDebugSnapshot();
    const events = listWhatsAppWebhookEvents(limit);
    const realEvents = events.filter((e) => !e.likelySynthetic && !e.metaConsoleTest);

    res.json({
        success: true,
        data: {
            ...snapshot,
            realEventCount: realEvents.length,
            latestRealEventAt: realEvents[0]?.receivedAt ?? null,
            credentialProbe: await probeMetaWhatsAppCredentials(),
            tts: getTtsDebugSnapshot(),
            events,
        },
    });
}

export async function postWhatsAppMetaSetup(req: Request, res: Response) {
    if (!isValidWebhookDebugAuth(req)) {
        res.status(401).json({
            success: false,
            message:
                "Unauthorized — pass ?verify_token=YOUR_META_VERIFY_TOKEN or ?HEALTH_SECRET=...",
        });
        return;
    }

    try {
        const { setupMetaWhatsAppWebhooks, probeMetaWhatsAppCredentials } = await import(
            "../clients/metaWhatsApp.client"
        );
        const setup = await setupMetaWhatsAppWebhooks();
        const probe = await probeMetaWhatsAppCredentials();
        res.json({
            success: true,
            data: {
                setup,
                credentialProbe: probe,
            },
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            message: err instanceof Error ? err.message : "WhatsApp Meta setup failed",
        });
    }
}

export async function postWhatsAppMetaSubscribeWaba(req: Request, res: Response) {
    return postWhatsAppMetaSetup(req, res);
}

/**
 * Meta signs every webhook POST with the app secret (X-Hub-Signature-256). Without this check
 * anyone could forge an inbound message "from" any elder's number. Mode via
 * WHATSAPP_META_SIGNATURE=enforce|log (default log until verified against live traffic).
 */
function metaSignatureStatus(req: Request): "ok" | "bad" | "missing" | "no_secret" {
    const secret = config.whatsapp.meta.appSecret;
    if (!secret) return "no_secret";
    const header = String(req.get("x-hub-signature-256") ?? "");
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!header.startsWith("sha256=") || !raw) return "missing";
    const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    if (expected.length !== header.length) return "bad";
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header)) ? "ok" : "bad";
}

export async function postWhatsAppMetaWebhook(req: Request, res: Response) {
    const sig = metaSignatureStatus(req);
    if (sig !== "ok") {
        console.warn(`Meta WhatsApp webhook: signature ${sig}`);
        if (process.env.WHATSAPP_META_SIGNATURE === "enforce" && sig !== "no_secret") {
            res.status(401).json({ success: false });
            return;
        }
    }
    const { handleWhatsAppInbound } = await import("../services/whatsappInbound.service");
    const {
        formatMetaSendError,
        isMetaWhatsAppEnabled,
        markMetaWhatsAppInboundSeen,
        parseMetaWebhookMessages,
        sendViaMetaWhatsApp,
        startMetaWhatsAppTypingRefresh,
    } = await import("../clients/metaWhatsApp.client");
    const { recordWhatsAppWebhookEvent } = await import("../services/whatsappWebhookLog.service");

    const messages = parseMetaWebhookMessages(req.body);
    if (!messages.length) {
        const objectType =
            req.body && typeof req.body === "object"
                ? String((req.body as Record<string, unknown>).object ?? "unknown")
                : "unknown";
        console.log(`Meta WhatsApp webhook: 0 messages parsed (object=${objectType})`);
        recordWhatsAppWebhookEvent({
            body: req.body,
            messagesParsed: 0,
            processed: 0,
        });
        res.status(200).json({ success: true, data: { processed: 0 } });
        return;
    }

    console.log(`Meta WhatsApp webhook: ${messages.length} message(s), enabled=${isMetaWhatsAppEnabled()}`);

    // Dedupe by WhatsApp message id (cross-instance) so Meta retries never cause a
    // second reply, then ACK immediately — Meta retries slow webhooks, and a voice turn
    // (download + STT + agent + TTS) can take far longer than its patience.
    const { claimWhatsAppInboundMessage } = await import("../services/whatsappInboundDedupe.service");
    const fresh: typeof messages = [];
    for (const inbound of messages) {
        if (await claimWhatsAppInboundMessage(inbound.messageId, inbound.from)) {
            fresh.push(inbound);
        } else {
            console.log(
                `Meta WhatsApp webhook: duplicate delivery ignored (msg=${String(inbound.messageId).slice(-10)})`,
            );
        }
    }
    res.status(200).json({
        success: true,
        data: { processed: fresh.length, duplicates: messages.length - fresh.length },
    });
    if (!fresh.length) return;

    // CPU stays allocated after the response (--no-cpu-throttling on Cloud Run).
    void processMetaInboundMessages(req.body, messages.length, fresh).catch((err) => {
        console.error(
            "Meta WhatsApp background processing crashed:",
            err instanceof Error ? err.message : err,
        );
    });
}

async function processMetaInboundMessages(
    rawBody: unknown,
    parsedCount: number,
    messages: import("../clients/metaWhatsApp.client").MetaInboundMessage[],
) {
    const { handleWhatsAppInbound } = await import("../services/whatsappInbound.service");
    const {
        formatMetaSendError,
        isMetaWhatsAppEnabled,
        markMetaWhatsAppInboundSeen,
        sendViaMetaWhatsApp,
        startMetaWhatsAppTypingRefresh,
    } = await import("../clients/metaWhatsApp.client");
    const { recordWhatsAppWebhookEvent } = await import("../services/whatsappWebhookLog.service");
    const { VOICE_NOT_CAUGHT_REPLY, WARM_NEUTRAL_REPLY } = await import(
        "../services/saheliElderFacts.service"
    );

    for (const inbound of messages) {
        let replySent = false;
        let replyPreview: string | undefined;
        let error: string | undefined;
        let sendError: string | undefined;
        let markedRead = false;
        let typingShown = false;

        let stopTypingRefresh: (() => void) | undefined;
        if (isMetaWhatsAppEnabled() && inbound.messageId) {
            try {
                markedRead = await markMetaWhatsAppInboundSeen({
                    messageId: inbound.messageId,
                    showTyping: true,
                });
                typingShown = markedRead;
                if (typingShown) {
                    stopTypingRefresh = startMetaWhatsAppTypingRefresh(inbound.messageId);
                }
            } catch (readErr) {
                console.warn(
                    "Meta WhatsApp mark-read/typing failed:",
                    readErr instanceof Error ? readErr.message : readErr,
                );
            }
        }

        try {
            const reply = await handleWhatsAppInbound({
                from: inbound.from,
                text: inbound.text,
                interactiveId: inbound.interactiveId,
                modality: inbound.mediaType === "voice" || inbound.mediaType === "audio" ? "voice" : "text",
                mediaType: inbound.mediaType,
                mediaUrl: inbound.mediaId,
                mediaCaption: inbound.mediaCaption,
            });
            replyPreview = reply.content?.slice(0, 200);
            if (isMetaWhatsAppEnabled() && (reply.content || reply.audioBuffer || reply.audioBase64)) {
                if (reply.audioBuffer || reply.audioBase64) {
                    const { sendMetaWhatsAppVoice } = await import("../clients/metaWhatsApp.client");
                    const audioBuffer =
                        reply.audioBuffer ||
                        Buffer.from(reply.audioBase64 || "", "base64");
                    await sendMetaWhatsAppVoice({
                        to: reply.channelIdentifier,
                        audioBuffer,
                        mimeType: reply.audioMimeType || "audio/mpeg",
                        caption: reply.content,
                    });
                } else {
                    await sendViaMetaWhatsApp(
                        reply.channelIdentifier,
                        reply.content,
                        reply.whatsappPayloads,
                    );
                }
                replySent = true;
                console.log(`Meta WhatsApp reply sent to ${inbound.from.slice(0, 6)}…`);
            } else if (!isMetaWhatsAppEnabled()) {
                error = "Meta WhatsApp provider not fully configured on server";
                console.error("Meta WhatsApp inbound received but provider is not fully configured");
            }
        } catch (err) {
            error = err instanceof Error ? err.message : String(err);
            console.error("Meta WhatsApp inbound failed:", error);
            if (isMetaWhatsAppEnabled()) {
                const isVoiceIn = inbound.mediaType === "voice" || inbound.mediaType === "audio";
                const fallbackText = isVoiceIn ? VOICE_NOT_CAUGHT_REPLY : WARM_NEUTRAL_REPLY;
                try {
                    await sendViaMetaWhatsApp(inbound.from, fallbackText);
                    replySent = true;
                    replyPreview = fallbackText;
                } catch (sendErr) {
                    sendError =
                        sendErr instanceof Error
                            ? sendErr.message
                            : formatMetaSendError(500, String(sendErr));
                    console.error("Meta WhatsApp fallback send failed:", sendError);
                }
            }
        } finally {
            stopTypingRefresh?.();
        }

        recordWhatsAppWebhookEvent({
            body: rawBody,
            messagesParsed: parsedCount,
            processed: 1,
            replySent,
            replyPreview,
            replyTo: inbound.from,
            error,
            sendError,
            markedRead,
            typingShown,
        });
    }
}

export async function postPhoneMockWebhook(req: Request, res: Response) {
    if (!isMockAuthorized(req)) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
    }
    const { reply } = await phoneMockAdapter.receive({
        channelType: ChannelType.PHONE,
        channelIdentifier: req.body.from,
        modality: "voice",
        content: req.body.text ?? "",
        audioBase64: req.body.audioBase64,
    });
    res.json({ success: true, data: { reply } });
}

export async function postSpeakerMockWebhook(req: Request, res: Response) {
    if (!isMockAuthorized(req)) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
    }
    const { reply } = await smartSpeakerMockAdapter.receive({
        channelType: ChannelType.SMART_SPEAKER,
        channelIdentifier: req.body.deviceId,
        modality: "voice",
        content: req.body.text ?? "",
        audioBase64: req.body.audioBase64,
    });
    res.json({ success: true, data: { reply } });
}
