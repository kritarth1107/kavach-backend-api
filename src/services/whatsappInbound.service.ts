import type { OutboundMessage } from "../channels/types";
import { ChannelType } from "../types/careRecord.types";
import { handleWhatsAppInbound as routeWhatsAppInbound } from "./whatsappRouting.service";
import { normalizeChannelIdentifier } from "./identityResolver.service";
import WhatsappSession from "../models/whatsappSession.model";
import { shouldSuppressStillWorkingFallback } from "./commerceAutomation/parkedOtpSession.service";

const DEFAULT_SLA_MS = 35_000;

function replySlaMs(): number {
    const n = Number(process.env.WHATSAPP_REPLY_SLA_MS);
    if (!Number.isFinite(n)) return DEFAULT_SLA_MS;
    return Math.min(Math.max(n, 8_000), 90_000);
}

async function slaFallback(from: string | undefined): Promise<OutboundMessage> {
    const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(from ?? ""));
    let content = "One moment, still on it 🙏";
    try {
        const { stillWorkingLine } = await import("./stillWorkingCopy");
        const { lastRouteFor } = await import("./saheliRouter.service");
        const row = (await WhatsappSession.findOne({ phone }).lean()) as Record<string, unknown> | null;
        content = stillWorkingLine(row, lastRouteFor(phone)?.route?.language);
    } catch {
        /* keep the plain line */
    }
    return { channelType: ChannelType.WHATSAPP, channelIdentifier: phone, modality: "text", content };
}

async function shouldSkipStillWorking(from: string | undefined): Promise<boolean> {
    const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(from ?? ""));
    if (!phone) return false;
    try {
        const row = await WhatsappSession.findOne({ phone }).lean();
        const draft = (row as { browserTaskDraft?: { phase?: string } } | null)?.browserTaskDraft;
        const pharmacy = (row as { pharmacyDraft?: unknown } | null)?.pharmacyDraft;
        const pending = (row as { pendingCommerceOtp?: unknown } | null)?.pendingCommerceOtp;
        return shouldSuppressStillWorkingFallback({
            phone,
            familyId: (row as { familyId?: string } | null)?.familyId,
            userId: (row as { userId?: string } | null)?.userId,
            browserTaskPhase: draft?.phase,
            hasPendingCommerceOtp: Boolean(pending),
            hasPharmacyDraft: Boolean(pharmacy),
        });
    } catch (err) {
        console.warn(
            "still-working suppress check failed:",
            err instanceof Error ? err.message : err,
        );
        return false;
    }
}

/**
 * The real answer finished after the "still on it" line already went out: send it now instead of dropping it
 * (live 2026-10-09 15:47: the model was rate-limited, the reply came after 75 s and Maa never got it).
 */
async function deliverLate(msg: OutboundMessage | undefined): Promise<void> {
    if (!msg || !msg.channelIdentifier || !(msg.content || msg.audioBuffer || msg.audioBase64)) return;
    try {
        const meta = await import("../clients/metaWhatsApp.client");
        if (!meta.isMetaWhatsAppEnabled()) return;
        if (msg.audioBuffer || msg.audioBase64) {
            await meta.sendMetaWhatsAppVoice({
                to: msg.channelIdentifier,
                audioBuffer: msg.audioBuffer || Buffer.from(msg.audioBase64 || "", "base64"),
                mimeType: msg.audioMimeType || "audio/mpeg",
                caption: msg.content,
                payloads: msg.whatsappPayloads,
            });
        } else {
            await meta.sendViaMetaWhatsApp(msg.channelIdentifier, msg.content, msg.whatsappPayloads);
        }
        console.log(`Meta WhatsApp late reply sent to ${msg.channelIdentifier.slice(0, 6)}…`);
    } catch (err) {
        console.error("late WhatsApp reply failed:", err instanceof Error ? err.message : err);
    }
}

/**
 * WhatsApp inbound with a hard reply SLA so typing indicators are never left forever
 * when Playwright / Gemini / partner APIs hang. If the SLA line went out, the real answer
 * is still sent when it arrives.
 *
 * Still-working fallback is suppressed while pharmacy OTP is pending or after cancel,
 * so we never spam "still working" + re-ask OTP loops.
 */
export async function handleWhatsAppInbound(body: {
    from?: string;
    text?: string;
    messageId?: string;
    interactiveId?: string;
    modality?: "text" | "voice";
    audioBase64?: string;
    mediaUrl?: string;
    mediaType?: string;
    mediaCaption?: string;
}): Promise<OutboundMessage> {
    const slaMs = replySlaMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let fellBack = false;
    const real = routeWhatsAppInbound(body);
    // After the SLA line was sent, the real answer goes out on its own when it is ready.
    real.then((msg) => (fellBack ? deliverLate(msg) : undefined)).catch(() => undefined);
    try {
        return await Promise.race([
            real.then((msg) => {
                settled = true;
                return msg;
            }),
            new Promise<OutboundMessage>((resolve) => {
                timer = setTimeout(() => {
                    void (async () => {
                        if (settled) return;
                        if (await shouldSkipStillWorking(body.from)) {
                            console.warn(
                                `WhatsApp reply SLA hit after ${slaMs}ms — suppressed still-working (OTP pending or cancelled)`,
                            );
                            // Do not resolve — let the real route finish (or hang without spam).
                            return;
                        }
                        console.warn(
                            `WhatsApp reply SLA hit after ${slaMs}ms — sending progress fallback`,
                        );
                        const fb = await slaFallback(body.from);
                        if (!settled) {
                            fellBack = true;
                            resolve(fb);
                        }
                    })();
                }, slaMs);
            }),
        ]);
    } finally {
        settled = true;
        if (timer) clearTimeout(timer);
    }
}
