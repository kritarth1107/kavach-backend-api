import { randomUUID } from "crypto";
import path from "path";
import { AppError } from "../middleware/error.middleware";
import LabDocument from "../models/labDocument.model";
import {
    buildFamilyObjectKey,
    deleteFamilyFile,
    extractTextFromUpload,
    getFamilyFileBuffer,
    isAllowedUpload,
    isR2Configured,
    uploadFamilyFile,
} from "./r2Storage.service";
import {
    analyzeUploadedDocument,
    syncDocumentToFamilyMemory,
} from "./documentMemorySync.service";
import { appendCareRecordEvent } from "./careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { getFamilyForActor, requirePermission, requireCareRecipient } from "./careRecordAuth.service";

async function assertRecipientAccess(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requireCareRecipient(family, recipientUserId);
    requirePermission(family, actorUserId, "upload_document");
    return family;
}

async function recordDocumentEvent(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    doc: { documentId: string; title: string; kind: string; rawText: string },
) {
    const eventType =
        doc.kind === "vitals"
            ? CareRecordEventType.VITAL
            : doc.kind === "symptom"
              ? CareRecordEventType.SYMPTOM
              : CareRecordEventType.DOCUMENT;

    await appendCareRecordEvent({
        familyId,
        subjectUserId: recipientUserId,
        actorUserId,
        type: eventType,
        source: CareRecordSource.DASHBOARD,
        channel: ChannelType.DASHBOARD,
        title: doc.title,
        detail: doc.rawText.slice(0, 500),
        payload: {
            documentId: doc.documentId,
            rawText: doc.rawText,
            kind: doc.kind,
        },
        status: "logged",
    });
}

function serializeDocument(doc: {
    documentId: string;
    title: string;
    kind: string;
    recordDate?: string;
    createdAt?: Date;
    rawText?: string;
    source?: string;
    storageKey?: string;
    fileUrl?: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    aiSummary?: string;
    tags?: string[];
    highlights?: string[];
    analysisStatus?: string;
}) {
    const text = doc.rawText?.replace(/\s+/g, " ").trim() ?? "";
    const snippet =
        doc.aiSummary?.slice(0, 220) ||
        text.slice(0, 220) ||
        (doc.fileName ? `Uploaded file: ${doc.fileName}` : "Uploaded document");

    return {
        document_id: doc.documentId,
        title: doc.title,
        kind: doc.kind,
        record_date: doc.recordDate ?? null,
        created_at: doc.createdAt ? doc.createdAt.toISOString() : null,
        snippet,
        source: doc.source ?? "text",
        file_url: doc.fileUrl ?? null,
        file_name: doc.fileName ?? null,
        mime_type: doc.mimeType ?? null,
        file_size: doc.fileSize ?? null,
        storage_key: doc.storageKey ?? null,
        ai_summary: doc.aiSummary ?? null,
        tags: doc.tags ?? [],
        highlights: doc.highlights ?? [],
        analysis_status: doc.analysisStatus ?? "pending",
    };
}

async function finalizeDocumentMemory(payload: {
    familyId: string;
    recipientUserId: string;
    documentId: string;
    title: string;
    rawText: string;
    fileName?: string;
    kind?: string;
    recordDate?: string;
}) {
    try {
        const { analysis } = await syncDocumentToFamilyMemory(payload);
        return analysis;
    } catch {
        return null;
    }
}

export async function ingestRecipientDocument(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    payload: { title?: string; rawText: string; kind?: string; recordDate?: string },
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const rawText = payload.rawText.trim();
    if (!rawText) throw new AppError("Report text is required", 400);

    const provisionalTitle =
        payload.title?.trim() ||
        rawText.split("\n").find((line) => line.trim())?.slice(0, 200) ||
        "Health record";

    const doc = await LabDocument.create({
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        title: provisionalTitle,
        rawText,
        kind: payload.kind || "lab",
        recordDate: payload.recordDate,
        createdBy: actorUserId,
        source: "text",
        analysisStatus: "pending",
    });

    const analysis = await finalizeDocumentMemory({
        familyId,
        recipientUserId,
        documentId: doc.documentId,
        title: provisionalTitle,
        rawText,
        kind: payload.kind,
        recordDate: payload.recordDate,
    });

    const updated = await LabDocument.findOne({ documentId: doc.documentId }).lean();

    await recordDocumentEvent(familyId, recipientUserId, actorUserId, {
        documentId: doc.documentId,
        title: updated?.title ?? provisionalTitle,
        kind: analysis?.kind ?? doc.kind,
        rawText,
    });

    return {
        document_id: doc.documentId,
        title: updated?.title ?? provisionalTitle,
        kind: analysis?.kind ?? doc.kind,
        ai_summary: analysis?.summary ?? null,
        tags: analysis?.tags ?? [],
        analysis_status: analysis ? "ready" : "pending",
    };
}

export async function ingestRecipientFile(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    file: Express.Multer.File,
    payload: { title?: string; kind?: string; recordDate?: string },
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    if (!isR2Configured()) {
        throw new AppError("File storage is not configured", 503);
    }
    if (!file?.buffer?.length) {
        throw new AppError("File is required", 400);
    }

    const mimeType = file.mimetype || "application/octet-stream";
    const originalName = file.originalname || "document";
    if (!isAllowedUpload(mimeType, originalName)) {
        throw new AppError(
            "Unsupported file type. Use PDF, Word, Excel, Markdown, text, CSV, or images.",
            400,
        );
    }

    const title = (payload.title?.trim() || path.basename(originalName, path.extname(originalName))).slice(0, 200);
    if (!title) throw new AppError("Title is required", 400);

    const storageKey = buildFamilyObjectKey(familyId, originalName);
    const fileUrl = await uploadFamilyFile(storageKey, file.buffer, mimeType);
    const extractedText = await extractTextFromUpload(file.buffer, mimeType, originalName);
    const rawText =
        extractedText ||
        `[Uploaded file: ${originalName}. View at ${fileUrl}]`;

    const doc = await LabDocument.create({
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        title,
        rawText,
        kind: payload.kind || "lab",
        recordDate: payload.recordDate,
        createdBy: actorUserId,
        source: "file",
        storageKey,
        fileUrl,
        fileName: originalName,
        mimeType,
        fileSize: file.size,
        analysisStatus: "pending",
    });

    const analysis = await finalizeDocumentMemory({
        familyId,
        recipientUserId,
        documentId: doc.documentId,
        title,
        rawText,
        fileName: originalName,
        kind: payload.kind,
        recordDate: payload.recordDate,
    });

    const updated = await LabDocument.findOne({ documentId: doc.documentId }).lean();

    await recordDocumentEvent(familyId, recipientUserId, actorUserId, {
        documentId: doc.documentId,
        title: updated?.title ?? title,
        kind: analysis?.kind ?? doc.kind,
        rawText,
    });

    return {
        document_id: doc.documentId,
        title: updated?.title ?? title,
        kind: analysis?.kind ?? updated?.kind ?? doc.kind,
        file_url: doc.fileUrl,
        storage_key: doc.storageKey,
        ai_summary: analysis?.summary ?? null,
        tags: analysis?.tags ?? [],
        analysis_status: analysis ? "ready" : "pending",
    };
}

export async function ingestRecipientFiles(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    files: Express.Multer.File[],
    payload: { kind?: string; recordDate?: string },
) {
    if (!files.length) throw new AppError("At least one file is required", 400);

    const uploaded: Awaited<ReturnType<typeof ingestRecipientFile>>[] = [];
    const failed: Array<{ file_name: string; error: string }> = [];

    for (const file of files) {
        try {
            const result = await ingestRecipientFile(
                familyId,
                recipientUserId,
                actorUserId,
                file,
                payload,
            );
            uploaded.push(result);
        } catch (err) {
            failed.push({
                file_name: file.originalname || "document",
                error: err instanceof AppError ? err.message : "Upload failed",
            });
        }
    }

    if (!uploaded.length && failed.length) {
        throw new AppError(failed[0]?.error || "All uploads failed", 400);
    }

    return { uploaded, failed, count: uploaded.length };
}

export async function listRecipientDocuments(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const docs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: -1 })
        .lean();

    return {
        documents: docs.map((d) => serializeDocument(d)),
    };
}

export async function getRecipientDocument(
    familyId: string,
    recipientUserId: string,
    documentId: string,
    actorUserId: string,
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const doc = await LabDocument.findOne({ familyId, recipientUserId, documentId }).lean();
    if (!doc) throw new AppError("Health record not found", 404);

    return {
        ...serializeDocument(doc),
        raw_text: doc.rawText,
    };
}

export async function deleteRecipientDocument(
    familyId: string,
    recipientUserId: string,
    documentId: string,
    actorUserId: string,
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const doc = await LabDocument.findOne({ familyId, recipientUserId, documentId }).lean();
    if (!doc) throw new AppError("Health record not found", 404);

    if (doc.storageKey) {
        try {
            await deleteFamilyFile(doc.storageKey);
        } catch {
            /* object may already be gone */
        }
    }

    await LabDocument.deleteOne({ familyId, recipientUserId, documentId });
    return { deleted: true };
}

export async function downloadRecipientDocument(
    familyId: string,
    recipientUserId: string,
    documentId: string,
    actorUserId: string,
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const doc = await LabDocument.findOne({ familyId, recipientUserId, documentId }).lean();
    if (!doc) throw new AppError("Health record not found", 404);

    if (doc.source !== "file" || (!doc.storageKey && !doc.fileUrl)) {
        throw new AppError("No original file available for this record", 404);
    }

    const fileName = doc.fileName || `${doc.title.replace(/[^a-zA-Z0-9._-]+/g, "-") || "report"}.bin`;

    if (doc.storageKey && isR2Configured()) {
        const { buffer, contentType } = await getFamilyFileBuffer(doc.storageKey);
        return { buffer, contentType, fileName };
    }

    if (doc.fileUrl) {
        const res = await fetch(doc.fileUrl);
        if (!res.ok) throw new AppError("Could not fetch original file", 502);
        const arrayBuffer = await res.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: doc.mimeType || res.headers.get("content-type") || "application/octet-stream",
            fileName,
        };
    }

    throw new AppError("No original file available for this record", 404);
}

export { analyzeUploadedDocument };
