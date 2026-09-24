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

function slaFallback(from: string | undefined): OutboundMessage {
    const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(from ?? ""));
    return {
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: phone,
        modality: "text",
        content:
            "I'm still working on that (browser can be slow). " +
            "If you get an SMS OTP (Uber / commerce), paste it here. " +
            "For medicines / Vit C, tell me the pharmacy (*Apollo*, *PharmEasy*, or *Tata 1mg*). " +
            "For rides, reply *cancel* to drop the booking — nothing is booked until you confirm.",
    };
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
 * WhatsApp inbound with a hard reply SLA so typing indicators are never left forever
 * when Playwright / Gemini / partner APIs hang.
 *
 * Still-working fallback is suppressed while pharmacy OTP is pending or after cancel,
 * so we never spam "still working" + re-ask OTP loops.
 */
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
    const slaMs = replySlaMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    try {
        return await Promise.race([
            routeWhatsAppInbound(body).then((msg) => {
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
                        if (!settled) resolve(slaFallback(body.from));
                    })();
                }, slaMs);
            }),
        ]);
    } finally {
        settled = true;
        if (timer) clearTimeout(timer);
    }
}
