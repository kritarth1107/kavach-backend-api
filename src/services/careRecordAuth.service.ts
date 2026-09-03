import Family, { IFamilyDocument } from "../models/family.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import {
    CareRecordPermission,
    isPhase1InviteRole,
    roleHasPermission,
} from "../types/careRecord.types";

export async function getFamilyForActor(
    familyId: string,
    actorUserId: string,
): Promise<IFamilyDocument> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }
    return family;
}

export function getMemberRole(family: IFamilyDocument, userId: string): FamilyRole | null {
    const member = family.members.find(
        (m) => m.userId === userId && m.status === FamilyMemberStatus.JOINED,
    );
    return member?.role ?? null;
}

export function requirePermission(
    family: IFamilyDocument,
    actorUserId: string,
    permission: CareRecordPermission,
): FamilyRole {
    const role = getMemberRole(family, actorUserId);
    if (!role || !roleHasPermission(role, permission)) {
        throw new AppError("You do not have permission for this action", 403);
    }
    return role;
}

export function requireCareRecipient(
    family: IFamilyDocument,
    recipientUserId: string,
): void {
    const member = family.members.find((m) => m.userId === recipientUserId);
    if (!member || member.status !== FamilyMemberStatus.JOINED) {
        throw new AppError("Care recipient not found", 404);
    }
    if (member.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Member is not a care recipient", 400);
    }
}

export function assertSameTenant(
    familyId: string,
    resourceFamilyId: string,
): void {
    if (familyId !== resourceFamilyId) {
        throw new AppError("Cross-tenant access denied", 403);
    }
}

export function validateInviteRole(role: FamilyRole): void {
    if (!isPhase1InviteRole(role)) {
        throw new AppError(
            "This role is not available in Phase 1. Choose care recipient, co-caregiver, or view only.",
            400,
        );
    }
}

export function canRemoveMember(actorRole: FamilyRole, targetRole: FamilyRole): boolean {
    if (targetRole === FamilyRole.PRIMARY_CAREGIVER) {
        return false;
    }
    if (actorRole === FamilyRole.PRIMARY_CAREGIVER) {
        return true;
    }
    if (actorRole === FamilyRole.CO_CAREGIVER) {
        return true;
    }
    return false;
}
