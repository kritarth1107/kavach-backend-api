import { randomUUID } from "crypto";
import path from "path";
import { AppError } from "../middleware/error.middleware";
import LabDocument from "../models/labDocument.model";
import {
    buildFamilyObjectKey,
    extractTextFromUpload,
    getFamilyFileBuffer,
    isAllowedUpload,
    isR2Configured,
    uploadFamilyFile,
} from "./r2Storage.service";
import { analyzeUploadedDocument } from "./documentMemorySync.service";
import { getFamilyForActor, requirePermission, requireCareSubject } from "./careRecordAuth.service";
import { contentHash, isSameSavedFile, medicalUploadProblem } from "./medicalRecordExtract.service";

async function assertRecipientAccess(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requireCareSubject(family, recipientUserId, actorUserId);
    requirePermission(family, actorUserId, "upload_document");
    return family;
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
    structuredValues?: Array<{ name: string; value: string; unit?: string; refRange?: string; flag?: string; date?: string }>;
    reviewStatus?: string;
    via?: string;
    reading?: Record<string, unknown>;
    personCheck?: Record<string, unknown>;
    decision?: Record<string, unknown>;
    readError?: string;
    recipientUserId?: string;
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
            range: v.refRange ?? null,
            flag: v.flag ?? null,
            date: v.date ?? null,
        })),
        unread: doc.unreadParts ?? [],
        extraction_status: doc.extractionStatus ?? null,
        // Records from before the review step count as saved.
        review_status: doc.reviewStatus ?? "saved",
        via: doc.via ?? "dashboard",
        reading: doc.reviewStatus === "needs_review" ? doc.reading ?? null : null,
        person_check: doc.personCheck ?? null,
        decision: doc.decision ?? null,
        read_error: doc.readError ?? null,
        recipient_user_id: doc.recipientUserId ?? null,
    };
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

    // Read it, show it, ask: nothing reaches Saheli, schedules or trends before the person chooses.
    const { readHealthRecord } = await import("./healthRecordReader.service");
    const { buildDraft, draftFields } = await import("./healthRecordReview.service");
    const read = await readHealthRecord({ text: rawText });
    const draft = await buildDraft(familyId, recipientUserId, read);
    // Every record carries a fingerprint: the store's unique index treats a missing one as a duplicate of every other.
    const hash = contentHash(Buffer.from(`text:${rawText}`));
    const same = await LabDocument.findOne({ familyId, recipientUserId, contentHash: hash }).lean();
    if (same) return { ...serializeDocument(same), already_on_file: true };
    const doc = await LabDocument.create({
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        rawText,
        createdBy: actorUserId,
        source: "text",
        via: "dashboard",
        contentHash: hash,
        ...draftFields(read, draft, provisionalTitle),
        ...(payload.kind && read.status === "failed" ? { kind: payload.kind } : {}),
        ...(payload.recordDate && !draft.reading.recordDate ? { recordDate: payload.recordDate } : {}),
    });
    return serializeDocument(doc.toObject());
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
    const { doc, existing: again } = await createDraftFromFile({
        familyId, recipientUserId, actorUserId, buffer: file.buffer, mimeType, originalName, storageKey, fileUrl, hash,
        fileSize: file.size, fallbackTitle, via: "dashboard",
    });
    if (again) return { ...serializeDocument(again), already_on_file: true };
    return { ...serializeDocument(doc!), already_on_file: false };
}

/** Read a stored file and keep it as a draft waiting for the person's choice (dashboard upload and WhatsApp). */
export async function createDraftFromFile(input: {
    familyId: string; recipientUserId: string; actorUserId: string; buffer: Buffer; mimeType: string; originalName: string;
    storageKey: string; fileUrl?: string; hash: string; fileSize?: number; fallbackTitle: string; via: "dashboard" | "whatsapp";
}): Promise<{ doc?: Parameters<typeof serializeDocument>[0]; existing?: Parameters<typeof serializeDocument>[0] }> {
    const { readHealthRecord } = await import("./healthRecordReader.service");
    const { buildDraft, draftFields } = await import("./healthRecordReview.service");
    let text = "";
    if (!input.mimeType.startsWith("image/") && input.mimeType !== "application/pdf") {
        text = await extractTextFromUpload(input.buffer, input.mimeType, input.originalName).catch(() => "");
    }
    const read = await readHealthRecord(text ? { text, fileName: input.originalName } : { buffer: input.buffer, mimeType: input.mimeType, fileName: input.originalName });
    const draft = await buildDraft(input.familyId, input.recipientUserId, read);
    try {
        const doc = await LabDocument.create({
            documentId: randomUUID(),
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            rawText: text.slice(0, 48_000),
            createdBy: input.actorUserId,
            source: "file" as const,
            via: input.via,
            storageKey: input.storageKey,
            fileUrl: input.fileUrl,
            fileName: input.originalName,
            mimeType: input.mimeType,
            fileSize: input.fileSize,
            contentHash: input.hash,
            ...draftFields(read, draft, input.fallbackTitle),
        });
        return { doc: doc.toObject() };
    } catch (err) {
        const code = err && typeof err === "object" && "code" in err ? (err as { code?: number }).code : 0;
        if (code === 11000) {
            const existing = await LabDocument.findOne({ familyId: input.familyId, recipientUserId: input.recipientUserId, contentHash: input.hash }).lean();
            if (existing) return { existing };
        }
        throw err;
    }
}

/** Read a record again (after a failed read, or to refresh a draft). Saved records are not re-read. */
export async function rereadRecipientDocument(familyId: string, recipientUserId: string, documentId: string, actorUserId: string) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    return rereadDocument(familyId, recipientUserId, documentId);
}

/** Read again without an access check (WhatsApp: the sender is already known to own this record's family). */
export async function rereadDocument(familyId: string, recipientUserId: string, documentId: string) {
    const doc = await LabDocument.findOne({ familyId, recipientUserId, documentId });
    if (!doc) throw new AppError("Health record not found", 404);
    if (doc.reviewStatus === "saved" && doc.extractionStatus !== "failed") throw new AppError("This record is already saved", 409);
    const { readHealthRecord } = await import("./healthRecordReader.service");
    const { buildDraft, draftFields } = await import("./healthRecordReview.service");
    let read;
    if (doc.storageKey && (doc.mimeType?.startsWith("image/") || doc.mimeType === "application/pdf")) {
        const { buffer } = await getFamilyFileBuffer(doc.storageKey);
        read = await readHealthRecord({ buffer, mimeType: doc.mimeType, fileName: doc.fileName });
    } else {
        read = await readHealthRecord({ text: doc.rawText, fileName: doc.fileName });
    }
    const draft = await buildDraft(familyId, recipientUserId, read, documentId);
    Object.assign(doc, draftFields(read, draft, doc.title));
    if (!doc.contentHash) doc.contentHash = contentHash(Buffer.from(`text:${doc.documentId}:${doc.rawText}`));
    await doc.save();
    return serializeDocument(doc.toObject());
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
    const { default: User } = await import("../models/users.model");
    const uploaders = new Map(
        (await User.find({ userId: { $in: [...new Set(docs.map((d) => d.createdBy).filter(Boolean))] } }, { userId: 1, firstName: 1 }).lean<Array<{ userId: string; firstName?: string }>>())
            .map((u) => [u.userId, u.firstName || "family"]),
    );

    return {
        documents: docs.map((d) => ({
            ...serializeDocument(d),
            uploaded_by_you: d.createdBy === actorUserId,
            uploaded_by_name: uploaders.get(d.createdBy) ?? null,
        })),
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

    const { removeRecord } = await import("./healthRecordReview.service");
    await removeRecord(doc);
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

/* ── review before save ─────────────────────────────────────────────────── */

async function actorName(userId: string): Promise<string> {
    const { default: User } = await import("../models/users.model");
    const u = await User.findOne({ userId }, { firstName: 1, lastName: 1 }).lean<{ firstName?: string; lastName?: string }>();
    return [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "Family";
}

/** The person's choice for a record waiting for review: save (with what to do), keep only the file, or discard. */
export async function decideRecipientDocument(familyId: string, recipientUserId: string, documentId: string, actorUserId: string, body: unknown) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const action = b.action === "save" || b.action === "file_only" || b.action === "discard" ? b.action : null;
    if (!action) throw new AppError("Choose save, file_only or discard", 400);
    const { applyDecision } = await import("./healthRecordReview.service");
    const result = await applyDecision(familyId, recipientUserId, documentId, { id: actorUserId, name: await actorName(actorUserId) }, {
        action, reading: b.reading, saveValues: b.saveValues !== false, remember: b.remember === true, addMedicines: b.addMedicines !== false,
        nextVisitReminder: b.nextVisitReminder === true, notifyFamily: b.notifyFamily === true,
    });
    const doc = result.deleted ? null : await LabDocument.findOne({ familyId, recipientUserId, documentId }).lean();
    return { ...result, document: doc ? serializeDocument(doc) : null };
}

/** "It is hers" / "it's for someone else in the family" for a record whose name did not match. */
export async function personRecipientDocument(familyId: string, recipientUserId: string, documentId: string, actorUserId: string, body: unknown) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const action = b.action === "theirs" || b.action === "move" ? b.action : null;
    if (!action) throw new AppError("Choose theirs or move", 400);
    const { resolvePerson } = await import("./healthRecordReview.service");
    const moved = await resolvePerson(familyId, recipientUserId, documentId, actorUserId, { action, toUserId: b.toUserId ? String(b.toUserId) : undefined });
    const doc = await LabDocument.findOne({ familyId, recipientUserId: moved.recipientUserId, documentId }).lean();
    return { recipient_user_id: moved.recipientUserId, document: doc ? serializeDocument(doc) : null };
}

/** The important numbers from this person's saved reports (cards chosen from what they have, not a fixed list). */
export async function highlightsForRecipient(familyId: string, recipientUserId: string, actorUserId: string) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const { recordHighlights } = await import("./healthRecordReview.service");
    return recordHighlights(familyId, recipientUserId);
}
