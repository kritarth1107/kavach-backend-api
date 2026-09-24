import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { appendCareRecordEvent } from "./careRecord.service";

/**
 * Persist inbound WhatsApp media to the care record.
 * Voice/audio: log only and return "" so routing continues into the elder AI path
 * with the STT transcript (no "Got your voice message" short-circuit).
 */
export async function ingestWhatsAppMediaMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    mediaType: string;
    mediaUrl?: string;
    caption?: string;
    transcript?: string;
}): Promise<string> {
    const isVoice = input.mediaType === "voice" || input.mediaType === "audio";

    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type:
            input.mediaType === "document"
                ? CareRecordEventType.DOCUMENT
                : CareRecordEventType.MESSAGE,
        source: CareRecordSource.WHATSAPP,
        channel: ChannelType.WHATSAPP,
        title: `WhatsApp ${input.mediaType}`,
        detail:
            input.transcript?.trim() ||
            input.caption?.trim() ||
            `Shared a ${input.mediaType}${input.mediaUrl ? ` (${input.mediaUrl.slice(0, 80)})` : ""}.`,
        status: "reported",
        payload: {
            mediaType: input.mediaType,
            mediaUrl: input.mediaUrl,
            transcript: input.transcript,
        },
        skipSignalCheck: true,
    });

    // Voice continues into elder AI — do not short-circuit.
    if (isVoice) return "";

    if (input.mediaType === "document" || input.mediaType === "image") {
        return "Saved in your care record.";
    }
    return "Noted.";
}
