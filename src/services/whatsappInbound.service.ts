import type { OutboundMessage } from "../channels/types";
import { ChannelType } from "../types/careRecord.types";
import { handleWhatsAppInbound as routeWhatsAppInbound } from "./whatsappRouting.service";
import { normalizeChannelIdentifier } from "./identityResolver.service";

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
            "If you get an SMS OTP, paste it here. " +
            "For medicines / Vit C, tell me the pharmacy (*Apollo*, *PharmEasy*, or *Tata 1mg*) or reply *cancel*.",
    };
}

/**
 * WhatsApp inbound with a hard reply SLA so typing indicators are never left forever
 * when Playwright / Gemini / partner APIs hang.
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
    try {
        return await Promise.race([
            routeWhatsAppInbound(body),
            new Promise<OutboundMessage>((resolve) => {
                timer = setTimeout(() => {
                    console.warn(`WhatsApp reply SLA hit after ${slaMs}ms — sending progress fallback`);
                    resolve(slaFallback(body.from));
                }, slaMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
