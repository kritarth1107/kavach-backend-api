import { ChannelAdapter, InboundMessage, OutboundMessage } from "./types";
import { ChannelType, CareRecordEventType, CareRecordSource } from "../types/careRecord.types";
import { resolveChannelIdentity } from "../services/identityResolver.service";
import { appendCareRecordEvent } from "../services/careRecord.service";
import { speechToText, textToSpeech } from "./voicePipeline";
import { FamilyRole } from "../types/family.types";

type TurnResult = {
    reply: string;
    orderFlow?: import("../services/orderOrchestrator.service").OrderFlowPayload;
};

/** Saheli's brain (engine /v2/turn) answers every channel; the old v1 chat is gone (trust plan A1, founder D9). When the
 *  brain cannot answer, the holding line (written ahead per language) goes back instead: never silence, never v1. */
async function handleTurn(
    familyId: string,
    userId: string,
    role: FamilyRole,
    _subjectUserId: string,
    text: string,
    _channel: ChannelType,
    _source: CareRecordSource,
    _phone: string,
): Promise<TurnResult> {
    const { runBrainV2 } = await import("../services/brainV2.service");
    const out = await runBrainV2({ identity: { familyId, userId, role }, text, mode: "live" }).catch((err) => {
        console.warn("[brain-v2] mock channel turn failed:", err instanceof Error ? err.message : err);
        return null;
    });
    if (out?.reply?.trim() && out.reply.trim() !== "none") return { reply: out.reply };
    const H = await import("../services/brainHold.service");
    return { reply: H.holdLines(await H.speechFor(familyId, userId)).holding };
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

        // WhatsApp routing (inbound._routing) synthesizes TTS itself after fallback checks —
        // skip here so each voice turn makes at most one ElevenLabs call.
        const voice =
            inbound.modality === "voice" && !inbound._routing
                ? await textToSpeech(turn.reply)
                : { text: turn.reply };

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
