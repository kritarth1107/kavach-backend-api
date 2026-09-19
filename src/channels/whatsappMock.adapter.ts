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

type TurnResult = {
    reply: string;
    orderFlow?: import("../services/orderOrchestrator.service").OrderFlowPayload;
};

async function handleTurn(
    familyId: string,
    userId: string,
    role: FamilyRole,
    subjectUserId: string,
    text: string,
    channel: ChannelType,
    source: CareRecordSource,
    phone: string,
): Promise<TurnResult> {
    const { resolveWhatsAppSaheliSession } = await import("../services/saheliSession.service");
    const thread = role === FamilyRole.CARE_RECIPIENT ? "elder" : "caregiver";
    const sessionId = await resolveWhatsAppSaheliSession({
        phone,
        familyId,
        recipientUserId: subjectUserId,
        actorUserId: userId,
        thread,
    });

    const channelOpts = {
        skipInboundCareRecord: true,
        channel,
        source,
        sessionId,
        whatsappPhone: channel === ChannelType.WHATSAPP ? phone : undefined,
    };
    if (role === FamilyRole.CARE_RECIPIENT) {
        const result = await sendSaheliMessage(familyId, userId, userId, text, channelOpts);
        return { reply: result.reply, orderFlow: result.orderFlow };
    }

    const result = await sendCaregiverSaheliMessage(
        familyId,
        subjectUserId,
        userId,
        text,
        channelOpts,
    );
    return { reply: result.reply };
}

export class ChannelMockAdapter implements ChannelAdapter {
    constructor(public readonly channelType: ChannelType) {}

    async receive(inbound: InboundMessage): Promise<{ reply: OutboundMessage }> {
        const identity = inbound._routing
            ? {
                  familyId: inbound._routing.familyId,
                  userId: inbound._routing.userId,
                  role: inbound._routing.role,
                  channelIdentifier: inbound.channelIdentifier,
              }
            : await resolveChannelIdentity(this.channelType, inbound.channelIdentifier);

        let text = inbound.content;
        if (inbound.modality === "voice") {
            text = await speechToText({
                audioBase64: inbound.audioBase64,
                fallbackText: inbound.content,
            });
        }

        const subjectUserId =
            inbound._routing?.subjectUserId ??
            (identity.role === FamilyRole.CARE_RECIPIENT
                ? identity.userId
                : await this.resolveSubjectForCaregiver(identity.familyId));

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

        const turn = await handleTurn(
            identity.familyId,
            identity.userId,
            identity.role,
            subjectUserId,
            text,
            this.channelType,
            this.mapSource(),
            inbound.channelIdentifier,
        );

        const voice =
            inbound.modality === "voice" ? await textToSpeech(turn.reply) : { text: turn.reply };

        const outbound: OutboundMessage = {
            channelType: this.channelType,
            channelIdentifier: inbound.channelIdentifier,
            modality: inbound.modality,
            content: voice.text,
            audioBase64: voice.audioBase64,
            orderFlow: turn.orderFlow,
        };

        return { reply: outbound };
    }

    async send(outbound: OutboundMessage): Promise<void> {
        const { default: OutboundMessageModel } = await import("../models/outboundMessage.model");
        const { randomUUID } = await import("crypto");
        await OutboundMessageModel.create({
            messageId: randomUUID(),
            familyId: "mock",
            recipientUserId: "mock",
            channel: this.channelType === ChannelType.PHONE ? "phone" : "whatsapp",
            channelIdentifier: outbound.channelIdentifier,
            content: outbound.content,
            direction: "outbound",
            deliveredAt: new Date(),
        });
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
