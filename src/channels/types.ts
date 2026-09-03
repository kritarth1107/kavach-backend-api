import { ChannelType } from "../types/careRecord.types";

export type MessageModality = "voice" | "text";

export type InboundMessage = {
    channelType: ChannelType;
    channelIdentifier: string;
    modality: MessageModality;
    content: string;
    audioBase64?: string;
    timestamp?: Date;
};

export type OutboundMessage = {
    channelType: ChannelType;
    channelIdentifier: string;
    modality: MessageModality;
    content: string;
    audioBase64?: string;
};

export interface ChannelAdapter {
    readonly channelType: ChannelType;
    receive(inbound: InboundMessage): Promise<{ reply: OutboundMessage }>;
    send(outbound: OutboundMessage): Promise<void>;
}
