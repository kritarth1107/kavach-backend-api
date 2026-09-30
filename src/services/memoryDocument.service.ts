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
import { enrichLabStructuredValues } from "./labTrends.service";
import { createFamilyNotification } from "./notification.service";
import { appendCareRecordEvent } from "./careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { getFamilyForActor, requirePermission, requireCareRecipient } from "./careRecordAuth.service";
import {
    applyExtraction,
    contentHash,
    extractMedicalRecord,
    isSameSavedFile,
    medicalUploadProblem,
    type SavedExtraction,
} from "./medicalRecordExtract.service";

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
    patientName?: string;
    provider?: string;
    medicines?: Array<{ name: string; dose?: string }>;
    unreadParts?: string[];
    extractionStatus?: string;
    structuredValues?: Array<{ name: string; value: string; unit?: string }>;
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
        patient_name: doc.patientName ?? null,
        provider: doc.provider ?? null,
        medicines: (doc.medicines ?? []).map((m) => ({ name: m.name, dose: m.dose ?? null })),
        lab_values: (doc.structuredValues ?? []).map((v) => ({
            name: v.name,
            value: v.value,
            unit: v.unit ?? null,
        })),
        unread: doc.unreadParts ?? [],
        extraction_status: doc.extractionStatus ?? null,
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

    void enrichLabStructuredValues(doc.documentId);
    void createFamilyNotification(familyId, {
        kind: "lab_new",
        title: "New report uploaded",
        body: updated?.title ?? provisionalTitle,
        actionUrl: "/dashboard/reports",
        recipientUserId,
        dedupeKey: `lab:${doc.documentId}`,
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
    const mimeType = file?.mimetype || "application/octet-stream";
    const originalName = file?.originalname || "document";
    const problem = medicalUploadProblem({
        size: file?.buffer?.length || file?.size || 0,
        mimeType,
        name: originalName,
    });
    if (problem) throw new AppError(problem, 400);
    if (!isAllowedUpload(mimeType, originalName) && problem === null) {
        throw new AppError("This is not a document we can read. Use a photo (JPG, PNG, HEIC) or a PDF.", 400);
    }

    const hash = contentHash(file.buffer);
    const existing = await LabDocument.findOne({ familyId, recipientUserId, contentHash: hash }).lean();
    if (existing && isSameSavedFile(hash, existing.contentHash)) {
        return { ...serializeDocument(existing), already_on_file: true };
    }

    const fallbackTitle = (payload.title?.trim() || path.basename(originalName, path.extname(originalName))).slice(0, 200);
    if (!fallbackTitle) throw new AppError("Title is required", 400);

    const storageKey = buildFamilyObjectKey(familyId, originalName);
    const fileUrl = await uploadFamilyFile(storageKey, file.buffer, mimeType);
    const saved = await readUpload(file.buffer, mimeType, originalName);

    const title = (saved.status === "failed" ? fallbackTitle : titleFromExtract(saved, fallbackTitle)).slice(0, 200);
    const fields = {
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        title,
        rawText: saved.rawText.slice(0, 48_000),
        kind: payload.kind || saved.extract.kind || "lab",
        recordDate: payload.recordDate || saved.extract.recordDate || undefined,
        createdBy: actorUserId,
        source: "file" as const,
        storageKey,
        fileUrl,
        fileName: originalName,
        mimeType,
        fileSize: file.size,
        contentHash: hash,
        patientName: saved.extract.patientName || undefined,
        provider: saved.extract.provider || undefined,
        medicines: saved.extract.medicines.map((m) => ({ name: m.name, dose: m.dose || undefined })),
        unreadParts: saved.extract.unread,
        extractionStatus: saved.status,
        structuredValues: saved.extract.labs.map((l) => ({
            name: l.name,
            value: l.value,
            unit: l.unit || undefined,
            date: saved.extract.recordDate || undefined,
        })),
        aiSummary: saved.extract.summary.slice(0, 500),
        analysisStatus: saved.status === "failed" ? ("failed" as const) : ("ready" as const),
    };

    let doc;
    try {
        doc = await LabDocument.create(fields);
    } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : 0;
        if (code === 11000) {
            const again = await LabDocument.findOne({ familyId, recipientUserId, contentHash: hash }).lean();
            if (again) return { ...serializeDocument(again), already_on_file: true };
        }
        throw err;
    }

    // Memory sync can take a long time. The file and the printed fields are already saved.
    void syncDocumentToFamilyMemory({
        familyId,
        recipientUserId,
        documentId: doc.documentId,
        title,
        rawText: saved.rawText,
        fileName: originalName,
        kind: doc.kind,
        recordDate: doc.recordDate,
        keepExtracted: true,
    }).catch(() => null);

    await recordDocumentEvent(familyId, recipientUserId, actorUserId, {
        documentId: doc.documentId,
        title,
        kind: doc.kind,
        rawText: saved.rawText,
    });

    return { ...serializeDocument(doc.toObject()), already_on_file: false };
}

async function readUpload(buffer: Buffer, mimeType: string, originalName: string): Promise<SavedExtraction> {
    let text = "";
    try {
        text = await extractTextFromUpload(buffer, mimeType, originalName);
    } catch {
        text = "";
    }
    const printed = extractMedicalRecord(text);
    const useful = Boolean(
        printed.patientName || printed.recordDate || printed.provider || printed.medicines.length || printed.labs.length,
    );
    const image = mimeType.startsWith("image/");
    let vision = null;
    if (!useful && (image || mimeType === "application/pdf" || originalName.toLowerCase().endsWith(".pdf"))) {
        const { readMedicalPage } = await import("./medicalRecordVision.service");
        vision = await readMedicalPage(buffer, image ? mimeType : "application/pdf");
    }
    return applyExtraction({ text, vision, pageWasImage: image || !text.trim() });
}

function titleFromExtract(saved: SavedExtraction, fallback: string): string {
    const ex = saved.extract;
    if (ex.kind === "prescription" && ex.medicines[0]) return `Prescription — ${ex.medicines[0].name}`;
    if (ex.kind === "lab" && ex.provider) return `Lab — ${ex.provider}`;
    if (ex.kind === "discharge") return ex.patientName ? `Discharge — ${ex.patientName}` : "Discharge summary";
    return fallback;
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
