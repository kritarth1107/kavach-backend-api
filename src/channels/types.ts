import { ChannelType } from "../types/careRecord.types";
import { FamilyRole } from "../types/family.types";
import type { MetaWhatsAppPayload } from "../types/whatsappMessage.types";

export type MessageModality = "voice" | "text";

export type InboundRoutingContext = {
    familyId: string;
    userId: string;
    role: FamilyRole;
    subjectUserId: string;
};

export type InboundMessage = {
    channelType: ChannelType;
    channelIdentifier: string;
    modality: MessageModality;
    content: string;
    audioBase64?: string;
    timestamp?: Date;
    _routing?: InboundRoutingContext;
};

export type OutboundMessage = {
    channelType: ChannelType;
    channelIdentifier: string;
    modality: MessageModality;
    content: string;
    audioBase64?: string;
    audioBuffer?: Buffer;
    audioMimeType?: string;
    /** Active WhatsApp order flow started by Saheli AI tools. */
    orderFlow?: import("../services/orderOrchestrator.service").OrderFlowPayload;
    /** Rich Meta WhatsApp payloads (interactive, media, text). */
    whatsappPayloads?: MetaWhatsAppPayload[];
    /** Also speak it: the text goes out first, and the voice note (in this listener's language) follows unless
     *  something newer reached the chat meanwhile (services/voiceAfterText). */
    voiceLater?: { listenerUserId?: string };
};

export interface ChannelAdapter {
    readonly channelType: ChannelType;
    receive(inbound: InboundMessage): Promise<{ reply: OutboundMessage }>;
    send(outbound: OutboundMessage): Promise<void>;
}
