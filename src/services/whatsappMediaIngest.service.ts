import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { appendCareRecordEvent } from "./careRecord.service";
import {
    analyzeCareMedia,
    type VisionMediaResult,
} from "./saheliMediaVision.service";

export type MediaIngestResult = {
    /** Short reply if we should short-circuit (rare). Empty means continue. */
    reply: string;
    /** When set, routing should feed this into elder companion instead of dead-ending. */
    companionPrompt?: string;
    vision?: VisionMediaResult | null;
    storedUrl?: string;
};

function mimeToExt(mime: string): string {
    const m = mime.toLowerCase();
    if (m.includes("png")) return ".png";
    if (m.includes("webp")) return ".webp";
    if (m.includes("pdf")) return ".pdf";
    if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
    return ".bin";
}

async function tryDownloadAndStore(input: {
    familyId: string;
    mediaUrl?: string;
    mediaType: string;
}): Promise<{ buffer?: Buffer; mimeType?: string; storedUrl?: string; storageKey?: string }> {
    if (!input.mediaUrl?.trim()) return {};

    try {
        const { downloadMedia } = await import("../clients/metaWhatsApp.client");
        const media = await downloadMedia(input.mediaUrl);
        let storedUrl: string | undefined;
        let storageKey: string | undefined;

        try {
            const { isR2Configured, buildFamilyObjectKey, uploadFamilyFile, buildPublicFileUrl } =
                await import("./r2Storage.service");
            if (isR2Configured() && media.buffer.length) {
                const ext = mimeToExt(media.mimeType);
                storageKey = buildFamilyObjectKey(
                    input.familyId,
                    `wa-${input.mediaType}${ext}`,
                );
                await uploadFamilyFile(storageKey, media.buffer, media.mimeType);
                storedUrl = buildPublicFileUrl(storageKey);
            }
        } catch (err) {
            console.warn(
                "R2 store for WA media skipped:",
                err instanceof Error ? err.message : err,
            );
        }

        return {
            buffer: media.buffer,
            mimeType: media.mimeType,
            storedUrl,
            storageKey,
        };
    } catch (err) {
        console.warn(
            "Meta media download failed:",
            err instanceof Error ? err.message : err,
        );
        return {};
    }
}

async function persistVisionActions(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    vision: VisionMediaResult;
    storedUrl?: string;
    storageKey?: string;
    mediaType: string;
}): Promise<void> {
    const { vision } = input;

    if (vision.kind === "food" && vision.nutritionNote) {
        await appendCareRecordEvent({
            familyId: input.familyId,
            subjectUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            type: CareRecordEventType.CHECK_IN,
            source: CareRecordSource.WHATSAPP,
            channel: ChannelType.WHATSAPP,
            title: "Meal note",
            detail: vision.nutritionNote,
            status: "reported",
            payload: {
                kind: "nutrition",
                summary: vision.summary,
                mediaType: input.mediaType,
                mediaUrl: input.storedUrl,
                storageKey: input.storageKey,
            },
            skipSignalCheck: true,
        });
        return;
    }

    if (vision.kind === "prescription") {
        const meds = vision.medications || [];
        const medLines = meds
            .map((m) => {
                const bits = [m.name, m.dosage, m.time, m.frequency, m.instructions].filter(
                    Boolean,
                );
                return bits.join(" — ");
            })
            .filter(Boolean);

        await appendCareRecordEvent({
            familyId: input.familyId,
            subjectUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            type: CareRecordEventType.DOCUMENT,
            source: CareRecordSource.WHATSAPP,
            channel: ChannelType.WHATSAPP,
            title: "Prescription draft",
            detail:
                medLines.length > 0
                    ? `Draft meds (awaiting caregiver confirm):\n${medLines.join("\n")}`
                    : vision.summary,
            status: "draft",
            payload: {
                kind: "prescription_draft",
                summary: vision.summary,
                medications: meds,
                scheduleDraft: meds.map((m) => ({
                    type: "MEDICINE",
                    title: m.name,
                    time: m.time || "09:00",
                    dosage: m.dosage,
                    instructions: m.instructions || m.frequency,
                    active: false,
                    needsCaregiverConfirm: true,
                })),
                mediaType: input.mediaType,
                mediaUrl: input.storedUrl,
                storageKey: input.storageKey,
                confirmBeforeHardWrite: true,
            },
            skipSignalCheck: true,
        });

        try {
            const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
            const medSummary =
                medLines.length > 0
                    ? medLines.slice(0, 6).join("; ")
                    : vision.summary;
            await notifyCaregivers({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: `Prescription photo received — draft schedule (confirm before adding):\n${medSummary}`,
                urgency: "medium",
                kind: "prescription_draft",
            });
        } catch (err) {
            console.warn(
                "Caregiver notify for Rx draft failed:",
                err instanceof Error ? err.message : err,
            );
        }
    }
}

/**
 * Persist inbound WhatsApp media to the care record.
 * Voice/audio: log only and return empty reply so routing continues into elder AI.
 * Image/document: download Meta media, optional R2 store, Gemini vision for food/Rx,
 * then route into companion (no dead-end "Saved in your care record.").
 */
export async function ingestWhatsAppMediaMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    mediaType: string;
    mediaUrl?: string;
    caption?: string;
    transcript?: string;
}): Promise<MediaIngestResult> {
    const isVoice = input.mediaType === "voice" || input.mediaType === "audio";
    const isActionableMedia =
        input.mediaType === "document" || input.mediaType === "image";

    let downloaded: Awaited<ReturnType<typeof tryDownloadAndStore>> = {};
    let vision: VisionMediaResult | null = null;

    if (isActionableMedia && input.mediaUrl) {
        downloaded = await tryDownloadAndStore({
            familyId: input.familyId,
            mediaUrl: input.mediaUrl,
            mediaType: input.mediaType,
        });
        if (downloaded.buffer?.length) {
            try {
                vision = await analyzeCareMedia({
                    buffer: downloaded.buffer,
                    mimeType: downloaded.mimeType || "image/jpeg",
                    caption: input.caption,
                });
            } catch (err) {
                console.warn(
                    "Vision analyze failed:",
                    err instanceof Error ? err.message : err,
                );
            }
        }
    }

    const detail =
        input.transcript?.trim() ||
        input.caption?.trim() ||
        vision?.summary ||
        `Shared a ${input.mediaType}${input.mediaUrl ? ` (${input.mediaUrl.slice(0, 80)})` : ""}.`;

    const eventType =
        vision?.kind === "prescription" || input.mediaType === "document"
            ? CareRecordEventType.DOCUMENT
            : CareRecordEventType.MESSAGE;

    // Avoid duplicate DOCUMENT when prescription path already wrote a richer event.
    if (!(vision?.kind === "prescription" || vision?.kind === "food")) {
        await appendCareRecordEvent({
            familyId: input.familyId,
            subjectUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            type: eventType,
            source: CareRecordSource.WHATSAPP,
            channel: ChannelType.WHATSAPP,
            title: `WhatsApp ${input.mediaType}`,
            detail,
            status: "reported",
            payload: {
                mediaType: input.mediaType,
                mediaUrl: downloaded.storedUrl || input.mediaUrl,
                storageKey: downloaded.storageKey,
                transcript: input.transcript,
                visionKind: vision?.kind,
            },
            skipSignalCheck: true,
        });
    } else if (vision) {
        await persistVisionActions({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            vision,
            storedUrl: downloaded.storedUrl,
            storageKey: downloaded.storageKey,
            mediaType: input.mediaType,
        });
    }

    if (isVoice) {
        return { reply: "", vision };
    }

    if (isActionableMedia) {
        const captionBit = input.caption?.trim() ? ` Caption: ${input.caption.trim()}` : "";
        if (vision) {
            const kindLabel =
                vision.kind === "food"
                    ? "meal photo"
                    : vision.kind === "prescription"
                      ? "prescription photo"
                      : "photo";
            const companionPrompt = `[Shared ${kindLabel}] ${vision.summary}.${captionBit} Respond warmly as Saheli. Do not diagnose. Do not say only "saved in your care record." Context for you: ${vision.elderReplyHint}`;
            return {
                reply: vision.elderReplyHint,
                companionPrompt,
                vision,
                storedUrl: downloaded.storedUrl,
            };
        }
        const companionPrompt = input.caption?.trim()
            ? `[Shared a ${input.mediaType}]${captionBit}`
            : `[Shared a ${input.mediaType}] Please acknowledge warmly and ask what it is if unclear. Do not only say it was saved.`;
        return {
            reply: "Got it — tell me a little about what you sent?",
            companionPrompt,
            vision: null,
            storedUrl: downloaded.storedUrl,
        };
    }

    return { reply: "Noted.", vision };
}
