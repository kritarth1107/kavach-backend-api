import { randomUUID } from "crypto";
import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";

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
    if (!rawText) throw new AppError("Lab text is required", 400);

    const doc = await LabDocument.create({
        documentId: randomUUID(),
        familyId,
        recipientUserId,
        title,
        rawText,
        kind: payload.kind || "lab",
        recordDate: payload.recordDate,
        createdBy: actorUserId,
    });

    return {
        document_id: doc.documentId,
        title: doc.title,
        kind: doc.kind,
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
        documents: docs.map((d) => ({
            document_id: d.documentId,
            title: d.title,
            kind: d.kind,
            record_date: d.recordDate ?? null,
            created_at: d.createdAt ? d.createdAt.toISOString() : null,
            snippet: d.rawText.replace(/\s+/g, " ").trim().slice(0, 220),
        })),
    };
}
