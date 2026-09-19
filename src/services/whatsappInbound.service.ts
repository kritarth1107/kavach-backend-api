import type { OutboundMessage } from "../channels/types";
import { handleWhatsAppInbound as routeWhatsAppInbound } from "./whatsappRouting.service";

export async function handleWhatsAppInbound(body: {
    from?: string;
    text?: string;
    modality?: "text" | "voice";
    audioBase64?: string;
    mediaUrl?: string;
    mediaType?: string;
    mediaCaption?: string;
}): Promise<OutboundMessage> {
    return routeWhatsAppInbound(body);
}
