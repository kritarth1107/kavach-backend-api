/**
 * Family & membership types for Kavach care circles
 */

export enum FamilyRole {
    CARE_RECIPIENT = "CARE_RECIPIENT",
    CO_CAREGIVER = "CO_CAREGIVER",
    VIEW_ONLY = "VIEW_ONLY",
    FAMILY_DOCTOR = "FAMILY_DOCTOR",
    PRIMARY_CAREGIVER = "PRIMARY_CAREGIVER",
}

export enum FamilyMemberStatus {
    PENDING = "PENDING",
    JOINED = "JOINED",
    BLOCKED = "BLOCKED",
    REJECTED = "REJECTED",
    REMOVED = "REMOVED",
}

export enum FamilyInvitationStatus {
    PENDING = "PENDING",
    ACCEPTED = "ACCEPTED",
    DECLINED = "DECLINED",
    REVOKED = "REVOKED",
    EXPIRED = "EXPIRED",
}

export enum FamilyStatus {
    ACTIVE = "ACTIVE",
    ARCHIVED = "ARCHIVED",
}

export interface IFamilyMember {
    userId: string;
    role: FamilyRole;
    status: FamilyMemberStatus;
    joinedAt: Date;
    invitedBy?: string;
    invitedAt?: Date;
}

export interface IFamilyInvitation {
    inviteId: string;
    familyId: string;
    email: string;
    role: FamilyRole;
    invitedBy: string;
    status: FamilyInvitationStatus;
    tokenHash: string;
    expiresAt: Date;
    inviteeName?: string;
    namePrefix?: string;
    relationship?: string;
    phone?: string;
    phoneCountryCode?: string;
    location?: string;
    userId?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface IFamily {
    familyId: string;
    name: string;
    description?: string;
    members: IFamilyMember[];
    createdBy: string;
    status: FamilyStatus;
    createdAt: Date;
    updatedAt: Date;
}
