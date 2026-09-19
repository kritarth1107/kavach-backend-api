import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { appendCareRecordEvent } from "./careRecord.service";

export async function ingestWhatsAppMediaMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    mediaType: string;
    mediaUrl?: string;
    caption?: string;
}): Promise<string> {
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
            input.caption?.trim() ||
            `Shared a ${input.mediaType}${input.mediaUrl ? ` (${input.mediaUrl.slice(0, 80)})` : ""}.`,
        status: "reported",
        payload: { mediaType: input.mediaType, mediaUrl: input.mediaUrl },
        skipSignalCheck: true,
    });

    if (input.mediaType === "document" || input.mediaType === "image") {
        return "Saved in your care record.";
    }
    if (input.mediaType === "voice" || input.mediaType === "audio") {
        return "Got your voice message.";
    }
    return "Noted.";
}
