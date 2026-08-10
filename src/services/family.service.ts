import Family, { IFamilyDocument } from "../models/family.model";
import User, { IUserDocument } from "../models/users.model";
import {
    FamilyMemberStatus,
    FamilyRole,
    FamilyStatus,
    IFamilyMember,
} from "../types/family.types";

const ROLE_LABELS: Record<FamilyRole, { label: string; badge: string }> = {
    [FamilyRole.PRIMARY_CAREGIVER]: {
        label: "Primary Caregiver",
        badge: "PRIMARY CAREGIVER",
    },
    [FamilyRole.CO_CAREGIVER]: {
        label: "Co-Caregiver",
        badge: "CO-CAREGIVER",
    },
    [FamilyRole.CARE_RECIPIENT]: {
        label: "Care Recipient",
        badge: "CARE RECIPIENT",
    },
    [FamilyRole.VIEW_ONLY]: {
        label: "View Only",
        badge: "VIEW ONLY",
    },
    [FamilyRole.FAMILY_DOCTOR]: {
        label: "Family Doctor",
        badge: "FAMILY DOCTOR",
    },
};

export function buildDefaultFamilyName(firstName?: string, email?: string): string {
    const base = firstName?.trim() || email?.split("@")[0] || "My";
    return `${base}'s Family`;
}

export function getUserInitials(
    firstName?: string,
    lastName?: string,
    email?: string,
): string {
    const first = firstName?.charAt(0)?.toUpperCase() ?? "";
    const last = lastName?.charAt(0)?.toUpperCase() ?? "";

    if (first && last) return `${first}${last}`;
    if (first) return first.slice(0, 2);
    return email?.charAt(0)?.toUpperCase() ?? "U";
}

export function getFamilyInitial(name: string): string {
    const withoutSuffix = name.replace(/'s family$/i, "").trim();
    const firstWord = withoutSuffix.split(/\s+/)[0] || name;
    return firstWord.charAt(0).toUpperCase() || "F";
}

export function getSwitcherRoleBadge(role: FamilyRole): string {
    return role === FamilyRole.PRIMARY_CAREGIVER ? "PRIMARY CAREGIVER" : "MEMBER";
}

export function getRoleLabel(role: FamilyRole, format: "label" | "badge" = "label"): string {
    return ROLE_LABELS[role][format === "badge" ? "badge" : "label"];
}

async function updateActiveFamilyId(userId: string, familyId: string): Promise<void> {
    await User.updateOne({ userId }, { activeFamilyId: familyId });
}

export async function createDefaultFamilyForUser(user: IUserDocument): Promise<IFamilyDocument> {
    const family = await Family.create({
        name: buildDefaultFamilyName(user.firstName, user.email),
        createdBy: user.userId,
        members: [
            {
                userId: user.userId,
                role: FamilyRole.PRIMARY_CAREGIVER,
                status: FamilyMemberStatus.JOINED,
                joinedAt: new Date(),
            },
        ],
    });

    await updateActiveFamilyId(user.userId, family.familyId);
    user.activeFamilyId = family.familyId;

    if (!user.primaryFamilyId) {
        await User.updateOne(
            { userId: user.userId },
            { primaryFamilyId: family.familyId },
        );
        user.primaryFamilyId = family.familyId;
    }

    return family;
}

export type FamilyAccessAlert = {
    type: "removed" | "blocked";
    familyId: string;
    familyName: string;
};

export async function reconcileUserAfterFamilyRemoval(
    userId: string,
    removedFromFamilyId: string,
): Promise<void> {
    const user = await User.findOne({ userId });
    if (!user) {
        return;
    }

    let families = await getFamiliesForUser(userId);

    if (families.length === 0) {
        await createDefaultFamilyForUser(user);
        families = await getFamiliesForUser(userId);
    }

    if (
        user.activeFamilyId === removedFromFamilyId ||
        !families.some((family) => family.familyId === user.activeFamilyId)
    ) {
        const nextId = getPrimaryFamilyId(user, families) ?? families[0]?.familyId;
        if (nextId) {
            await updateActiveFamilyId(userId, nextId);
        }
    }

    if (
        user.primaryFamilyId === removedFromFamilyId ||
        (user.primaryFamilyId &&
            !families.some((family) => family.familyId === user.primaryFamilyId))
    ) {
        const refreshed = await User.findOne({ userId });
        const nextPrimary =
            getPrimaryFamilyId(refreshed ?? user, families) ?? families[0]?.familyId;
        if (nextPrimary) {
            await User.updateOne({ userId }, { primaryFamilyId: nextPrimary });
        }
    }
}

export async function ensureValidActiveFamily(
    user: IUserDocument,
): Promise<FamilyAccessAlert | null> {
    const previousActiveId = user.activeFamilyId;
    let families = await getFamiliesForUser(user.userId);
    const joinedIds = new Set(families.map((family) => family.familyId));

    if (previousActiveId && !joinedIds.has(previousActiveId)) {
        const oldFamily = await Family.findOne({
            familyId: previousActiveId,
            status: FamilyStatus.ACTIVE,
        });
        const membership = oldFamily?.members.find((member) => member.userId === user.userId);
        const alertType =
            membership?.status === FamilyMemberStatus.BLOCKED ? "blocked" : "removed";

        if (families.length === 0) {
            await createDefaultFamilyForUser(user);
            families = await getFamiliesForUser(user.userId);
        }

        const nextId = resolveActiveFamilyId(user, families);
        if (nextId) {
            await updateActiveFamilyId(user.userId, nextId);
            user.activeFamilyId = nextId;
        }

        return {
            type: alertType,
            familyId: previousActiveId,
            familyName: oldFamily?.name ?? "this family",
        };
    }

    if (families.length === 0) {
        await ensureDefaultFamily(user);
    } else if (!user.activeFamilyId || !joinedIds.has(user.activeFamilyId)) {
        const nextId = resolveActiveFamilyId(user, families);
        if (nextId) {
            await updateActiveFamilyId(user.userId, nextId);
            user.activeFamilyId = nextId;
        }
    }

    return null;
}

export async function ensureDefaultFamily(user: IUserDocument): Promise<IFamilyDocument | null> {
    const families = await Family.findByUserId(user.userId);
    if (families.length > 0) {
        if (
            !user.activeFamilyId ||
            !families.some((family) => family.familyId === user.activeFamilyId)
        ) {
            await updateActiveFamilyId(user.userId, families[0].familyId);
            user.activeFamilyId = families[0].familyId;
        }
        return families[0];
    }

    const pendingOnly = await Family.findOne({
        status: FamilyStatus.ACTIVE,
        members: {
            $elemMatch: {
                userId: user.userId,
                status: FamilyMemberStatus.PENDING,
            },
        },
    });

    if (pendingOnly) {
        return null;
    }

    return createDefaultFamilyForUser(user);
}

export async function getFamiliesForUser(userId: string) {
    return Family.findByUserId(userId).sort({ createdAt: 1 });
}

export function getJoinedMember(
    family: IFamilyDocument,
    userId: string,
): IFamilyMember | undefined {
    return family.members.find(
        (member) =>
            member.userId === userId &&
            (member.status === FamilyMemberStatus.JOINED ||
                (member.status as string) === "ACTIVE"),
    );
}

/** @deprecated use getJoinedMember */
export const getActiveMember = getJoinedMember;

export function formatFamilySummary(
    family: IFamilyDocument,
    userId: string,
    activeFamilyId?: string,
    primaryFamilyId?: string,
) {
    const membership = getJoinedMember(family, userId);
    const role = membership?.role ?? FamilyRole.VIEW_ONLY;
    const isActive = activeFamilyId === family.familyId;
    const isPrimary = primaryFamilyId === family.familyId;

    return {
        familyId: family.familyId,
        name: family.name,
        initial: getFamilyInitial(family.name),
        description: family.description,
        role,
        roleLabel: getRoleLabel(role),
        roleBadge: getRoleLabel(role, "badge"),
        switcherRoleBadge: getSwitcherRoleBadge(role),
        memberCount: family.memberCount,
        isActive,
        isPrimary,
        status: family.status,
        createdAt: family.createdAt,
        updatedAt: family.updatedAt,
    };
}

export function getPrimaryFamilyId(
    user: Pick<IUserDocument, "userId" | "primaryFamilyId">,
    families: IFamilyDocument[],
): string | undefined {
    if (families.length === 0) {
        return undefined;
    }

    if (
        user.primaryFamilyId &&
        families.some((family) => family.familyId === user.primaryFamilyId)
    ) {
        return user.primaryFamilyId;
    }

    const primaryCaregiverFamily = families.find((family) => {
        const membership = getJoinedMember(family, user.userId);
        return membership?.role === FamilyRole.PRIMARY_CAREGIVER;
    });

    return primaryCaregiverFamily?.familyId ?? families[0].familyId;
}

export function resolveActiveFamilyId(
    user: IUserDocument,
    families: IFamilyDocument[],
): string | undefined {
    if (families.length === 0) {
        return undefined;
    }

    if (
        user.activeFamilyId &&
        families.some((family) => family.familyId === user.activeFamilyId)
    ) {
        return user.activeFamilyId;
    }

    return families[0].familyId;
}

/** On login, default active family to the user's primary family. */
export async function setPrimaryFamilyOnLogin(user: IUserDocument): Promise<void> {
    await ensureDefaultFamily(user);

    const families = await getFamiliesForUser(user.userId);
    const primaryFamilyId = getPrimaryFamilyId(user, families);

    if (primaryFamilyId) {
        if (!user.primaryFamilyId) {
            await User.updateOne({ userId: user.userId }, { primaryFamilyId });
            user.primaryFamilyId = primaryFamilyId;
        }
        await updateActiveFamilyId(user.userId, primaryFamilyId);
        user.activeFamilyId = primaryFamilyId;
    }
}

export async function setUserPrimaryFamily(user: IUserDocument, familyId: string) {
    await assertFamilyMember(familyId, user.userId);
    await User.updateOne({ userId: user.userId }, { primaryFamilyId: familyId });
    user.primaryFamilyId = familyId;
    return user;
}

export async function getStoredFamilyContext(userId: string) {
    const user = await User.findOne({ userId });
    if (!user) {
        return null;
    }

    await ensureDefaultFamily(user);

    const refreshedUser = (await User.findOne({ userId })) ?? user;
    const families = await getFamiliesForUser(userId);

    return buildFamilySwitcherPayload(refreshedUser, families);
}

export function buildFamilySwitcherPayload(
    user: IUserDocument,
    families: IFamilyDocument[],
) {
    const activeFamilyId = resolveActiveFamilyId(user, families);
    const primaryFamilyId = getPrimaryFamilyId(user, families) ?? null;
    const formattedFamilies = families.map((family) =>
        formatFamilySummary(family, user.userId, activeFamilyId, primaryFamilyId ?? undefined),
    );
    const activeFamily =
        formattedFamilies.find((family) => family.isActive) ?? formattedFamilies[0] ?? null;

    return {
        activeFamilyId: activeFamily?.familyId ?? null,
        primaryFamilyId,
        activeFamily,
        families: formattedFamilies,
    };
}

export async function setActiveFamily(user: IUserDocument, familyId: string) {
    await assertFamilyMember(familyId, user.userId);
    await updateActiveFamilyId(user.userId, familyId);
    user.activeFamilyId = familyId;
    return user;
}

export async function formatFamilyMember(member: IFamilyMember) {
    const user = await User.findOne({ userId: member.userId }).lean();

    return {
        userId: member.userId,
        firstName: user?.firstName,
        lastName: user?.lastName,
        fullName:
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
            user?.email ||
            "Unknown",
        email: user?.email,
        avatarUrl: user?.avatarUrl,
        initials: getUserInitials(user?.firstName, user?.lastName, user?.email),
        role: member.role,
        roleLabel: getRoleLabel(member.role),
        roleBadge: getRoleLabel(member.role, "badge"),
        status: member.status,
        statusLabel: member.status.toLowerCase(),
        joinedAt: member.joinedAt,
        invitedAt: member.invitedAt,
        invitedBy: member.invitedBy,
    };
}

export async function formatFamilyDetail(family: IFamilyDocument, userId: string) {
    const { getFamilyMembersList } = await import("./familyMember.service");
    const list = await getFamilyMembersList(family.familyId, userId);
    const membership = getJoinedMember(family, userId);
    const joinedMembers = list.members.filter(
        (m) => m.status === FamilyMemberStatus.JOINED,
    );

    return {
        familyId: family.familyId,
        name: family.name,
        initial: getFamilyInitial(family.name),
        description: family.description,
        memberCount: joinedMembers.length,
        status: family.status,
        createdBy: family.createdBy,
        createdAt: family.createdAt,
        updatedAt: family.updatedAt,
        myRole: membership?.role ?? null,
        myRoleLabel: membership ? getRoleLabel(membership.role) : null,
        myRoleBadge: membership ? getRoleLabel(membership.role, "badge") : null,
        switcherRoleBadge: membership ? getSwitcherRoleBadge(membership.role) : null,
        careRecipient:
            list.members.find(
                (m) =>
                    m.role === FamilyRole.CARE_RECIPIENT &&
                    m.status === FamilyMemberStatus.JOINED,
            ) ?? null,
        members: list.members,
    };
}

export async function assertFamilyMember(
    familyId: string,
    userId: string,
): Promise<IFamilyDocument> {
    const family = await Family.findOne({ familyId, status: FamilyStatus.ACTIVE });

    if (!family || !family.hasJoinedMember(userId)) {
        throw new Error("Family not found or access denied");
    }

    return family;
}
