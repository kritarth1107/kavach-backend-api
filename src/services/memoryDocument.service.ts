import { randomUUID } from "crypto";
import path from "path";
import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";
import {
    ALLOWED_UPLOAD_MIME_TYPES,
    buildFamilyObjectKey,
    deleteFamilyFile,
    extractTextFromUpload,
    isR2Configured,
    uploadFamilyFile,
} from "./r2Storage.service";

async function assertRecipientAccess(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }
    const member = family.members.find((m) => m.userId === recipientUserId);
    if (!member || member.status !== FamilyMemberStatus.JOINED) {
        throw new AppError("Care recipient not found", 404);
    }
    if (member.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Member is not a care recipient", 400);
    }
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
}) {
    const text = doc.rawText?.replace(/\s+/g, " ").trim() ?? "";
    const snippet =
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
    };
}

export async function ingestRecipientDocument(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    payload: { title: string; rawText: string; kind?: string; recordDate?: string },
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const title = payload.title.trim();
    const rawText = payload.rawText.trim();
    if (!title) throw new AppError("Title is required", 400);
    if (!rawText) throw new AppError("Report text is required", 400);

    const doc = await LabDocument.create({
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        title,
        rawText,
        kind: payload.kind || "lab",
        recordDate: payload.recordDate,
        createdBy: actorUserId,
        source: "text",
    });

    return {
        document_id: doc.documentId,
        title: doc.title,
        kind: doc.kind,
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
        throw new AppError("Cloudflare R2 is not configured", 503);
    }
    if (!file?.buffer?.length) {
        throw new AppError("File is required", 400);
    }

    const mimeType = file.mimetype || "application/octet-stream";
    if (!ALLOWED_UPLOAD_MIME_TYPES.has(mimeType)) {
        throw new AppError("Unsupported file type. Use PDF, TXT, JPG, PNG, or WEBP.", 400);
    }

    const originalName = file.originalname || "document";
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
    });

    return {
        document_id: doc.documentId,
        title: doc.title,
        kind: doc.kind,
        file_url: doc.fileUrl,
        storage_key: doc.storageKey,
    };
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
