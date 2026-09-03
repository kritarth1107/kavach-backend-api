import { ChannelAdapter, InboundMessage, OutboundMessage } from "./types";
import { ChannelType, CareRecordEventType, CareRecordSource } from "../types/careRecord.types";
import { resolveChannelIdentity } from "../services/identityResolver.service";
import { appendCareRecordEvent } from "../services/careRecord.service";
import { speechToText, textToSpeech } from "./voicePipeline";
import {
    sendSaheliMessage,
    sendCaregiverSaheliMessage,
} from "../services/saheli.service";
import { FamilyRole } from "../types/family.types";

async function handleTurn(
    familyId: string,
    userId: string,
    role: FamilyRole,
    subjectUserId: string,
    text: string,
    channel: ChannelType,
    source: CareRecordSource,
): Promise<string> {
    const channelOpts = { skipInboundCareRecord: true, channel, source };
    if (role === FamilyRole.CARE_RECIPIENT) {
        const result = await sendSaheliMessage(familyId, userId, userId, text, channelOpts);
        return result.reply;
    }

    const result = await sendCaregiverSaheliMessage(
        familyId,
        subjectUserId,
        userId,
        text,
        channelOpts,
    );
    return result.reply;
}

export class ChannelMockAdapter implements ChannelAdapter {
    constructor(public readonly channelType: ChannelType) {}

    async receive(inbound: InboundMessage): Promise<{ reply: OutboundMessage }> {
        const identity = await resolveChannelIdentity(
            this.channelType,
            inbound.channelIdentifier,
        );

        let text = inbound.content;
        if (inbound.modality === "voice") {
            text = await speechToText({
                audioBase64: inbound.audioBase64,
                fallbackText: inbound.content,
            });
        }

        const subjectUserId =
            identity.role === FamilyRole.CARE_RECIPIENT
                ? identity.userId
                : await this.resolveSubjectForCaregiver(identity.familyId);

        await appendCareRecordEvent({
            familyId: identity.familyId,
            subjectUserId,
            actorUserId: identity.userId,
            type: CareRecordEventType.MESSAGE,
            source: this.mapSource(),
            channel: this.channelType,
            title: identity.role === FamilyRole.CARE_RECIPIENT ? "Care subject" : "Caregiver",
            detail: text,
            payload: { modality: inbound.modality },
            status: "reported",
        });

        const replyText = await handleTurn(
            identity.familyId,
            identity.userId,
            identity.role,
            subjectUserId,
            text,
            this.channelType,
            this.mapSource(),
        );

        const voice = inbound.modality === "voice" ? await textToSpeech(replyText) : { text: replyText };

        const outbound: OutboundMessage = {
            channelType: this.channelType,
            channelIdentifier: inbound.channelIdentifier,
            modality: inbound.modality,
            content: voice.text,
            audioBase64: voice.audioBase64,
        };

        return { reply: outbound };
    }

    async send(outbound: OutboundMessage): Promise<void> {
        void outbound;
    }

    private mapSource(): CareRecordSource {
        if (this.channelType === ChannelType.WHATSAPP) return CareRecordSource.WHATSAPP;
        if (this.channelType === ChannelType.PHONE) return CareRecordSource.PHONE;
        if (this.channelType === ChannelType.SMART_SPEAKER) return CareRecordSource.SMART_SPEAKER;
        return CareRecordSource.DASHBOARD;
    }

    private async resolveSubjectForCaregiver(familyId: string): Promise<string> {
        const Family = (await import("../models/family.model")).default;
        const { FamilyRole: FR, FamilyMemberStatus } = await import("../types/family.types");
        const family = await Family.findOne({ familyId, status: "ACTIVE" }).lean();
        const recipient = family?.members.find(
            (m) => m.role === FR.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
        );
        if (!recipient?.userId) {
            throw new Error("No care recipient in family");
        }
        return recipient.userId;
    }
}

export class WhatsAppMockAdapter extends ChannelMockAdapter {
    constructor() {
        super(ChannelType.WHATSAPP);
    }
}

export class PhoneMockAdapter extends ChannelMockAdapter {
    constructor() {
        super(ChannelType.PHONE);
    }
}

export class SmartSpeakerMockAdapter extends ChannelMockAdapter {
    constructor() {
        super(ChannelType.SMART_SPEAKER);
    }
}

export const whatsAppMockAdapter = new WhatsAppMockAdapter();
export const phoneMockAdapter = new PhoneMockAdapter();
export const smartSpeakerMockAdapter = new SmartSpeakerMockAdapter();
