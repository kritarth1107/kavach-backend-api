import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import Family from "../models/family.model";
import { ensureAiContext } from "./aiTenant.service";
import { getFamilyMembersList } from "./familyMember.service";
import { aiIngestDocument, aiListDocuments } from "../clients/aiEngine.client";

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

function resolveName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
) {
    const found = members.find((m) => m.userId === recipientUserId);
    return found?.name?.trim() || "Care recipient";
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

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);

    const result = await aiIngestDocument({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
        title,
        rawText,
        kind: payload.kind || "lab",
        recordDate: payload.recordDate,
    });

    return result;
}

export async function listRecipientDocuments(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    await assertRecipientAccess(familyId, recipientUserId, actorUserId);
    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName = resolveName(membersPayload.members, recipientUserId);
    const ctx = await ensureAiContext(familyId, recipientUserId, displayName);

    const result = await aiListDocuments({
        aiFamilyId: ctx.aiFamilyId,
        aiElderId: ctx.aiElderId,
    });

    return result;
}
