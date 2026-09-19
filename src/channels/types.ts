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
    /** Rich Meta WhatsApp payloads (interactive, media, text). */
    whatsappPayloads?: MetaWhatsAppPayload[];
};

export interface ChannelAdapter {
    readonly channelType: ChannelType;
    receive(inbound: InboundMessage): Promise<{ reply: OutboundMessage }>;
    send(outbound: OutboundMessage): Promise<void>;
}
