import jwt from "jsonwebtoken";
import config from "../config/app.config";
import Family, { IFamilyDocument } from "../models/family.model";
import FamilyInvitation, {
    hashInviteToken,
} from "../models/familyInvitation.model";
import User, { IUserDocument } from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import {
    formatFamilyDetail,
    getJoinedMember,
    getRoleLabel,
    getUserInitials,
    getFamiliesForUser,
    createDefaultFamilyForUser,
    reconcileUserAfterFamilyRemoval,
} from "./family.service";
import { sortByUpdatedAtDesc } from "../utils/cosmos-safe-sort.util";
import {
    FamilyInvitationStatus,
    FamilyMemberStatus,
    FamilyRole,
    IFamilyMember,
} from "../types/family.types";
import { sendFamilyInviteEmail } from "./email.service";
import { AuthProvider } from "../types/user.types";
import { FamilyStatus } from "../types/family.types";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

const INVITE_EXPIRY_DAYS = 7;

const NAME_PREFIXES = ["Mr.", "Mrs.", "Ms.", "Miss", "Dr.", "Prof.", "Mx."] as const;

type ResolvedMemberName = {
    namePrefix: string;
    name: string;
    fullName: string;
};

function splitNamePrefix(fullName: string): { namePrefix: string; name: string } {
    const trimmed = fullName.trim();
    for (const prefix of NAME_PREFIXES) {
        if (trimmed.startsWith(`${prefix} `)) {
            return { namePrefix: prefix, name: trimmed.slice(prefix.length + 1).trim() };
        }
    }
    return { namePrefix: "", name: trimmed };
}

function formatMemberDisplayName(namePrefix?: string, name?: string): string {
    const trimmedName = name?.trim() ?? "";
    if (!trimmedName) return "";
    const trimmedPrefix = namePrefix?.trim();
    return trimmedPrefix ? `${trimmedPrefix} ${trimmedName}` : trimmedName;
}

function normalizeMemberNameInput(payload: {
    name?: string;
    namePrefix?: string;
}): { namePrefix: string; name: string } {
    const explicitPrefix = payload.namePrefix?.trim() ?? "";
    const rawName = payload.name?.trim() ?? "";

    if (explicitPrefix) {
        return { namePrefix: explicitPrefix, name: rawName };
    }

    return splitNamePrefix(rawName);
}

function resolveMemberName(
    user: { firstName?: string; lastName?: string } | null | undefined,
    extras?: {
        namePrefix?: string;
        inviteeName?: string;
    },
): ResolvedMemberName {
    const invitePrefix = extras?.namePrefix?.trim() ?? "";
    const inviteName = extras?.inviteeName?.trim() ?? "";

    if (invitePrefix || inviteName) {
        if (!invitePrefix && inviteName) {
            const split = splitNamePrefix(inviteName);
            return {
                ...split,
                fullName: formatMemberDisplayName(split.namePrefix, split.name),
            };
        }

        const name =
            inviteName ||
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") ||
            "";

        return {
            namePrefix: invitePrefix,
            name,
            fullName: formatMemberDisplayName(invitePrefix, name),
        };
    }

    if (
        user?.firstName &&
        (NAME_PREFIXES as readonly string[]).includes(user.firstName)
    ) {
        const name = user.lastName?.trim() ?? "";
        return {
            namePrefix: user.firstName,
            name,
            fullName: formatMemberDisplayName(user.firstName, name),
        };
    }

    const rawName = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
    const split = splitNamePrefix(rawName);
    return {
        ...split,
        fullName: formatMemberDisplayName(split.namePrefix, split.name),
    };
}

type InviteMemberMeta = {
    relationship?: string;
    phone?: string;
    phoneCountryCode?: string;
    location?: string;
    inviteId?: string;
    namePrefix?: string;
    inviteeName?: string;
};

async function loadInviteMetaByUserId(
    familyId: string,
    userIds: string[],
): Promise<Map<string, InviteMemberMeta>> {
    if (userIds.length === 0) {
        return new Map();
    }

    const invitations = sortByUpdatedAtDesc(
        await FamilyInvitation.find({
            familyId,
            userId: { $in: userIds },
            status: {
                $in: [FamilyInvitationStatus.PENDING, FamilyInvitationStatus.ACCEPTED],
            },
        }),
    );

    const inviteMetaByUser = new Map<string, InviteMemberMeta>();
    for (const inv of invitations) {
        if (!inv.userId || inviteMetaByUser.has(inv.userId)) {
            continue;
        }

        inviteMetaByUser.set(inv.userId, {
            relationship: inv.relationship,
            phone: inv.phone,
            phoneCountryCode: inv.phoneCountryCode,
            location: inv.location,
            inviteId: inv.inviteId,
            namePrefix: inv.namePrefix,
            inviteeName: inv.inviteeName,
        });
    }

    return inviteMetaByUser;
}

export type PendingInvitationSummary = {
    inviteId: string;
    familyId: string;
    familyName: string;
    role: FamilyRole;
    roleLabel: string;
    invitedByName: string;
    relationship?: string;
    expiresAt: Date;
    createdAt: Date;
};

const MANAGER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

export function canManageMembers(role: FamilyRole | null): boolean {
    return role !== null && MANAGER_ROLES.has(role);
}

export function mapUiRoleToFamilyRole(role: string): FamilyRole {
    const map: Record<string, FamilyRole> = {
        care_recipient: FamilyRole.CARE_RECIPIENT,
        co_caregiver: FamilyRole.CO_CAREGIVER,
        view_only: FamilyRole.VIEW_ONLY,
        family_doctor: FamilyRole.FAMILY_DOCTOR,
        primary_caregiver: FamilyRole.PRIMARY_CAREGIVER,
        CARE_RECIPIENT: FamilyRole.CARE_RECIPIENT,
        CO_CAREGIVER: FamilyRole.CO_CAREGIVER,
        VIEW_ONLY: FamilyRole.VIEW_ONLY,
        FAMILY_DOCTOR: FamilyRole.FAMILY_DOCTOR,
        PRIMARY_CAREGIVER: FamilyRole.PRIMARY_CAREGIVER,
    };

    const mapped = map[role];
    if (!mapped) {
        throw new AppError("Invalid member role", 400);
    }
    return mapped;
}

function createInviteJwt(inviteId: string, familyId: string, email: string): string {
    return jwt.sign(
        { sub: "family_invite", inviteId, familyId, email },
        config.encryption.inviteSecret || config.jwt.secret,
        { expiresIn: `${INVITE_EXPIRY_DAYS}d` },
    );
}

function verifyInviteJwt(token: string): {
    inviteId: string;
    familyId: string;
    email: string;
} {
    const decoded = jwt.verify(
        token,
        config.encryption.inviteSecret || config.jwt.secret,
    ) as jwt.JwtPayload;

    if (
        decoded.sub !== "family_invite" ||
        !decoded.inviteId ||
        !decoded.familyId ||
        !decoded.email
    ) {
        throw new AppError("Invalid invitation token", 400);
    }

    return {
        inviteId: String(decoded.inviteId),
        familyId: String(decoded.familyId),
        email: String(decoded.email).toLowerCase(),
    };
}

async function assertCanManage(family: IFamilyDocument, userId: string) {
    const role = family.getMemberRole(userId);
    if (!canManageMembers(role)) {
        throw new AppError("You do not have permission to manage family members", 403);
    }
}

function resolveMemberPhoneFields(
    invitePhone?: string,
    inviteCountryCode?: string,
    userPhone?: { countryCode?: string; number?: string } | string | null,
): { phone?: string; phoneCountryCode?: string } {
    if (invitePhone?.trim()) {
        return {
            phone: invitePhone.trim(),
            phoneCountryCode: inviteCountryCode?.trim(),
        };
    }

    if (!userPhone) {
        return {};
    }

    if (typeof userPhone === "string") {
        return { phone: userPhone.trim(), phoneCountryCode: inviteCountryCode?.trim() };
    }

    return {
        phone: userPhone.number?.trim(),
        phoneCountryCode: userPhone.countryCode?.trim() ?? inviteCountryCode?.trim(),
    };
}

export async function createInvitedUser(
    email: string,
    memberName: string,
    namePrefix?: string,
    phone?: string,
    phoneCountryCode?: string,
) {
    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ email: normalizedEmail });

    const { namePrefix: resolvedPrefix, name } = namePrefix?.trim()
        ? { namePrefix: namePrefix.trim(), name: memberName.trim() }
        : splitNamePrefix(memberName);
    const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);

    if (user) {
        await User.updateOne(
            { userId: user.userId },
            {
                emailVerified: false,
                ...(firstName
                    ? {
                          firstName,
                          lastName: rest.join(" ") || undefined,
                      }
                    : {}),
            },
        );
        return (await User.findOne({ userId: user.userId })) ?? user;
    }

    const raw = randomBytes(24).toString("hex");
    const passwordHash = await bcrypt.hash(raw, config.security.bcryptSaltRounds);

    const phoneData =
        phone && phoneCountryCode
            ? {
                  phone: {
                      countryCode: phoneCountryCode,
                      number: phone.replace(/\D/g, ""),
                  },
              }
            : {};

    user = await User.create({
        email: normalizedEmail,
        firstName,
        lastName: rest.join(" ") || undefined,
        passwordHash,
        primaryAuthProvider: AuthProvider.EMAIL,
        emailVerified: false,
        ...phoneData,
    });

    return user;
}

export async function syncPendingInviteMembershipsForUser(user: IUserDocument) {
    const email = user.email.toLowerCase().trim();
    const invitations = await FamilyInvitation.find({
        email,
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    });

    for (const invitation of invitations) {
        if (invitation.userId && invitation.userId !== user.userId) {
            continue;
        }

        if (!invitation.userId) {
            invitation.userId = user.userId;
            await invitation.save();
        }

        const family = await Family.findOne({
            familyId: invitation.familyId,
            status: FamilyStatus.ACTIVE,
        });
        if (!family) {
            continue;
        }

        const existing = family.members.find((m) => m.userId === user.userId);
        if (!existing) {
            await family.addMember(user.userId, invitation.role, {
                status: FamilyMemberStatus.PENDING,
                invitedBy: invitation.invitedBy,
            });
        }
    }
}

export function userNeedsInvitationAction(
    joinedFamilyIds: string[],
    pendingInvitations: PendingInvitationSummary[],
): boolean {
    if (pendingInvitations.length === 0) {
        return false;
    }

    const invitedFamilyIds = new Set(pendingInvitations.map((invite) => invite.familyId));
    return !joinedFamilyIds.some((familyId) => invitedFamilyIds.has(familyId));
}

export function requiresBlockingInvitationScreen(
    joinedFamilyIds: string[],
    pendingInvitations: PendingInvitationSummary[],
): boolean {
    return (
        pendingInvitations.length > 0 &&
        joinedFamilyIds.length === 0 &&
        userNeedsInvitationAction(joinedFamilyIds, pendingInvitations)
    );
}

export async function getPendingMembershipsForUser(
    userId: string,
    email?: string,
): Promise<PendingInvitationSummary[]> {
    const normalizedEmail = email?.toLowerCase().trim();

    const families = await Family.find({
        status: FamilyStatus.ACTIVE,
        members: {
            $elemMatch: {
                userId,
                status: FamilyMemberStatus.PENDING,
            },
        },
    });

    const invitationFilter: Record<string, unknown> = {
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    };

    if (normalizedEmail) {
        invitationFilter.$or = [{ userId }, { email: normalizedEmail }];
    } else {
        invitationFilter.userId = userId;
    }

    const invitations = await FamilyInvitation.find(invitationFilter);

    const familyIdsFromMembers = new Set(families.map((family) => family.familyId));
    const missingFamilyIds = invitations
        .map((invite) => invite.familyId)
        .filter((familyId) => !familyIdsFromMembers.has(familyId));

    const extraFamilies =
        missingFamilyIds.length > 0
            ? await Family.find({
                  familyId: { $in: missingFamilyIds },
                  status: FamilyStatus.ACTIVE,
              })
            : [];

    const familyById = new Map<string, IFamilyDocument>();
    for (const family of [...families, ...extraFamilies]) {
        familyById.set(family.familyId, family);
    }

    if (familyById.size === 0) {
        return [];
    }

    const inviteByFamily = new Map(invitations.map((inv) => [inv.familyId, inv]));

    return Promise.all(
        Array.from(familyById.values()).map(async (family) => {
            const invite = inviteByFamily.get(family.familyId);
            const membership = family.members.find(
                (m) => m.userId === userId && m.status === FamilyMemberStatus.PENDING,
            );
            const inviter = await User.findOne({
                userId: invite?.invitedBy ?? membership?.invitedBy,
            }).lean();

            return {
                inviteId: invite?.inviteId ?? `${family.familyId}:${userId}`,
                familyId: family.familyId,
                familyName: family.name,
                role: membership?.role ?? invite?.role ?? FamilyRole.VIEW_ONLY,
                roleLabel: getRoleLabel(membership?.role ?? invite?.role ?? FamilyRole.VIEW_ONLY),
                invitedByName:
                    [inviter?.firstName, inviter?.lastName].filter(Boolean).join(" ") ||
                    inviter?.email ||
                    "Someone",
                relationship: invite?.relationship,
                expiresAt: invite?.expiresAt ?? new Date(Date.now() + INVITE_EXPIRY_DAYS * 86400000),
                createdAt: invite?.createdAt ?? membership?.invitedAt ?? new Date(),
            };
        }),
    );
}

export async function formatMemberWithMeta(
    member: IFamilyMember,
    extras?: InviteMemberMeta,
) {
    const user = await User.findOne({ userId: member.userId }).lean();
    const resolvedName = resolveMemberName(user, extras);

    const phoneFields = resolveMemberPhoneFields(
        extras?.phone,
        extras?.phoneCountryCode,
        user?.phone,
    );

    return {
        id: member.userId,
        userId: member.userId,
        inviteId: extras?.inviteId,
        firstName: user?.firstName,
        lastName: user?.lastName,
        namePrefix: resolvedName.namePrefix || undefined,
        fullName: resolvedName.fullName,
        name: resolvedName.name,
        email: user?.email ?? null,
        avatarUrl: user?.avatarUrl,
        initials: getUserInitials(user?.firstName, user?.lastName, user?.email),
        role: member.role,
        roleLabel: getRoleLabel(member.role),
        roleBadge: getRoleLabel(member.role, "badge"),
        status: member.status,
        joinedAt: member.joinedAt,
        invitedAt: member.invitedAt,
        invitedBy: member.invitedBy,
        relationship: extras?.relationship,
        phone: phoneFields.phone,
        phoneCountryCode: phoneFields.phoneCountryCode,
        location: extras?.location,
    };
}

async function formatPendingInvitation(invite: {
    inviteId: string;
    email: string;
    role: FamilyRole;
    status: FamilyInvitationStatus;
    inviteeName?: string;
    namePrefix?: string;
    relationship?: string;
    phone?: string;
    phoneCountryCode?: string;
    location?: string;
    createdAt: Date;
    expiresAt: Date;
}) {
    const resolvedName = resolveMemberName(null, {
        namePrefix: invite.namePrefix,
        inviteeName: invite.inviteeName || invite.email.split("@")[0],
    });

    return {
        id: invite.inviteId,
        inviteId: invite.inviteId,
        userId: null,
        namePrefix: resolvedName.namePrefix || undefined,
        fullName: resolvedName.fullName,
        name: resolvedName.name,
        email: invite.email,
        initials: resolvedName.name.charAt(0).toUpperCase() || invite.email.charAt(0).toUpperCase(),
        role: invite.role,
        roleLabel: getRoleLabel(invite.role),
        roleBadge: getRoleLabel(invite.role, "badge"),
        status: FamilyMemberStatus.PENDING,
        joinedAt: null,
        invitedAt: invite.createdAt,
        relationship: invite.relationship,
        phone: invite.phone,
        phoneCountryCode: invite.phoneCountryCode,
        location: invite.location,
        expiresAt: invite.expiresAt,
    };
}

export async function getFamilyMembersList(familyId: string, userId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(userId)) {
        throw new AppError("Family not found or access denied", 404);
    }

    const visibleMembers = family.members.filter(
        (m) => m.status !== FamilyMemberStatus.REMOVED,
    );

    const pendingInvites = await FamilyInvitation.findPendingByFamily(familyId);

    const memberUserIds = visibleMembers.map((member) => member.userId);
    const inviteMetaByUser = await loadInviteMetaByUserId(familyId, memberUserIds);

    for (const inv of pendingInvites) {
        if (!inv.userId || inviteMetaByUser.has(inv.userId)) {
            continue;
        }

        inviteMetaByUser.set(inv.userId, {
            relationship: inv.relationship,
            phone: inv.phone,
            phoneCountryCode: inv.phoneCountryCode,
            location: inv.location,
            inviteId: inv.inviteId,
            namePrefix: inv.namePrefix,
            inviteeName: inv.inviteeName,
        });
    }

    const members = await Promise.all(
        visibleMembers.map((member) =>
            formatMemberWithMeta(member, inviteMetaByUser.get(member.userId)),
        ),
    );

    const memberUserIdSet = new Set(visibleMembers.map((m) => m.userId));
    const emailOnlyInvites = pendingInvites.filter(
        (inv) => !inv.userId || !memberUserIdSet.has(inv.userId),
    );

    const invitations = await Promise.all(
        emailOnlyInvites.map((inv) => formatPendingInvitation(inv)),
    );

    return {
        familyId: family.familyId,
        familyName: family.name,
        myRole: family.getMemberRole(userId),
        members: [...members, ...invitations],
    };
}

export async function inviteFamilyMember(
    familyId: string,
    inviter: IUserDocument,
    payload: {
        email?: string;
        role: string;
        name?: string;
        namePrefix?: string;
        relationship?: string;
        phone?: string;
        phoneCountryCode?: string;
        location?: string;
    },
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    await assertCanManage(family, inviter.userId);

    const role = mapUiRoleToFamilyRole(payload.role);
    if (role === FamilyRole.PRIMARY_CAREGIVER) {
        throw new AppError("Cannot invite someone as primary caregiver", 400);
    }

    const isCareRecipient = role === FamilyRole.CARE_RECIPIENT;
    const email = String(payload.email ?? "")
        .trim()
        .toLowerCase();

    if (!isCareRecipient && !email) {
        throw new AppError("Email is required for this role", 400);
    }

    if (!payload.name?.trim()) {
        throw new AppError("Name is required", 400);
    }

    if (!email) {
        throw new AppError("Email is required so the member can sign in and accept", 400);
    }

    const { namePrefix, name: memberName } = normalizeMemberNameInput(payload);

    const invitedUser = await createInvitedUser(
        email,
        memberName,
        namePrefix,
        payload.phone,
        payload.phoneCountryCode,
    );

    const existingMember = family.members.find((m) => m.userId === invitedUser.userId);
    if (
        existingMember &&
        existingMember.status !== FamilyMemberStatus.REMOVED &&
        existingMember.status !== FamilyMemberStatus.REJECTED
    ) {
        if (existingMember.status === FamilyMemberStatus.BLOCKED) {
            throw new AppError("This member is blocked. Unblock them first.", 400);
        }
        throw new AppError("This person is already in the family", 400);
    }

    if (invitedUser.userId === inviter.userId) {
        throw new AppError("You are already in this family", 400);
    }

    const pendingInvite = await FamilyInvitation.findOne({
        familyId,
        email,
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    });

    if (pendingInvite) {
        throw new AppError("An invitation is already pending for this email", 400);
    }

    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await FamilyInvitation.create({
        familyId,
        email,
        role,
        invitedBy: inviter.userId,
        status: FamilyInvitationStatus.PENDING,
        tokenHash: "pending",
        expiresAt,
        inviteeName: memberName,
        namePrefix: namePrefix || undefined,
        relationship: payload.relationship?.trim(),
        phone: payload.phone?.trim(),
        phoneCountryCode: payload.phoneCountryCode?.trim(),
        location: payload.location?.trim(),
        userId: invitedUser.userId,
    });

    const jwtToken = createInviteJwt(invitation.inviteId, familyId, email);
    invitation.tokenHash = hashInviteToken(jwtToken);
    await invitation.save();

    await family.addMember(invitedUser.userId, role, {
        invitedBy: inviter.userId,
        status: FamilyMemberStatus.PENDING,
    });

    const inviterName =
        [inviter.firstName, inviter.lastName].filter(Boolean).join(" ") ||
        inviter.email;

    await sendFamilyInviteEmail({
        to: email,
        inviterName,
        familyName: family.name,
        roleLabel: getRoleLabel(role),
        acceptUrl: `${config.server.liveFrontendUrl}/auth/login?email=${encodeURIComponent(email)}`,
    });

    return getFamilyMembersList(familyId, inviter.userId);
}

export async function acceptFamilyInvitation(user: IUserDocument, token: string) {
    const { inviteId, familyId, email } = verifyInviteJwt(token);

    const invitation = await FamilyInvitation.findOne({
        inviteId,
        familyId,
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    });

    if (!invitation) {
        throw new AppError("Invitation not found or expired", 404);
    }

    if (hashInviteToken(token) !== invitation.tokenHash) {
        throw new AppError("Invalid invitation token", 400);
    }

    if (user.email.toLowerCase() !== invitation.email.toLowerCase() && !invitation.email.endsWith("@pending.kavach")) {
        throw new AppError("This invitation was sent to a different email address", 403);
    }

    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    const existing = family.members.find((m) => m.userId === user.userId);
    if (existing?.status === FamilyMemberStatus.JOINED) {
        invitation.status = FamilyInvitationStatus.ACCEPTED;
        await invitation.save();
        return formatFamilyDetail(family, user.userId);
    }

    if (existing?.status === FamilyMemberStatus.BLOCKED) {
        throw new AppError("You are blocked from this family", 403);
    }

    if (existing) {
        await family.updateMemberStatus(user.userId, FamilyMemberStatus.JOINED);
    } else {
        await family.addMember(user.userId, invitation.role, {
            status: FamilyMemberStatus.JOINED,
            invitedBy: invitation.invitedBy,
        });
    }

    invitation.status = FamilyInvitationStatus.ACCEPTED;
    invitation.userId = user.userId;
    await invitation.save();

    return formatFamilyDetail(family, user.userId);
}

export async function getPendingInvitationsForUser(user: IUserDocument) {
    const invites = await FamilyInvitation.findPendingByEmail(user.email);
    const families = await Family.find({
        familyId: { $in: invites.map((i) => i.familyId) },
    });

    const familyMap = new Map(families.map((f) => [f.familyId, f]));

    return Promise.all(
        invites.map(async (invite) => {
            const family = familyMap.get(invite.familyId);
            const inviter = await User.findOne({ userId: invite.invitedBy }).lean();
            return {
                inviteId: invite.inviteId,
                familyId: invite.familyId,
                familyName: family?.name ?? "Family",
                role: invite.role,
                roleLabel: getRoleLabel(invite.role),
                invitedByName:
                    [inviter?.firstName, inviter?.lastName].filter(Boolean).join(" ") ||
                    inviter?.email,
                expiresAt: invite.expiresAt,
                createdAt: invite.createdAt,
            };
        }),
    );
}

export async function updateMemberStatus(
    familyId: string,
    actorUserId: string,
    memberUserId: string,
    status: FamilyMemberStatus,
) {
    if (![FamilyMemberStatus.JOINED, FamilyMemberStatus.BLOCKED, FamilyMemberStatus.PENDING].includes(status)) {
        throw new AppError("Invalid member status", 400);
    }

    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    await assertCanManage(family, actorUserId);

    const member = family.members.find((m) => m.userId === memberUserId);
    if (!member || member.status === FamilyMemberStatus.REMOVED) {
        throw new AppError("Member not found", 404);
    }

    if (member.role === FamilyRole.PRIMARY_CAREGIVER) {
        throw new AppError("Cannot change status of the primary caregiver", 400);
    }

    await family.updateMemberStatus(memberUserId, status);

    if (status === FamilyMemberStatus.BLOCKED) {
        await reconcileUserAfterFamilyRemoval(memberUserId, familyId);
    }

    return getFamilyMembersList(familyId, actorUserId);
}

export async function removeFamilyMember(
    familyId: string,
    actorUserId: string,
    memberUserId: string,
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    await assertCanManage(family, actorUserId);

    const member = family.members.find((m) => m.userId === memberUserId);
    if (!member || member.status === FamilyMemberStatus.REMOVED) {
        throw new AppError("Member not found", 404);
    }

    if (member.role === FamilyRole.PRIMARY_CAREGIVER) {
        throw new AppError("Cannot remove the primary caregiver", 400);
    }

    await family.removeMember(memberUserId);

    await FamilyInvitation.updateMany(
        { familyId, userId: memberUserId, status: FamilyInvitationStatus.PENDING },
        { status: FamilyInvitationStatus.REVOKED },
    );

    await reconcileUserAfterFamilyRemoval(memberUserId, familyId);

    return getFamilyMembersList(familyId, actorUserId);
}

export async function updateFamilyMemberDetails(
    familyId: string,
    actorUserId: string,
    memberUserId: string,
    payload: {
        role?: string;
        name?: string;
        namePrefix?: string;
        relationship?: string;
        phone?: string;
        phoneCountryCode?: string;
        location?: string;
    },
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    await assertCanManage(family, actorUserId);

    const member = family.members.find((m) => m.userId === memberUserId);
    if (!member || member.status === FamilyMemberStatus.REMOVED) {
        throw new AppError("Member not found", 404);
    }

    if (member.role === FamilyRole.PRIMARY_CAREGIVER) {
        throw new AppError("Cannot edit the primary caregiver", 400);
    }

    if (payload.role) {
        const role = mapUiRoleToFamilyRole(payload.role);
        if (role === FamilyRole.PRIMARY_CAREGIVER) {
            throw new AppError("Cannot assign primary caregiver role", 400);
        }
        member.role = role;
        await family.save();
    }

    if (payload.name?.trim() || payload.namePrefix !== undefined) {
        const { namePrefix, name: memberName } = normalizeMemberNameInput(payload);
        const [firstName, ...rest] = memberName.split(/\s+/).filter(Boolean);

        if (firstName) {
            await User.updateOne(
                { userId: memberUserId },
                {
                    firstName,
                    lastName: rest.join(" ") || undefined,
                },
            );
        }

        await FamilyInvitation.updateMany(
            { familyId, userId: memberUserId },
            {
                inviteeName: memberName || undefined,
                namePrefix: namePrefix || undefined,
                ...(payload.relationship !== undefined
                    ? { relationship: payload.relationship.trim() || undefined }
                    : {}),
                ...(payload.phone !== undefined
                    ? { phone: payload.phone.trim() || undefined }
                    : {}),
                ...(payload.phoneCountryCode !== undefined
                    ? { phoneCountryCode: payload.phoneCountryCode.trim() || undefined }
                    : {}),
                ...(payload.location !== undefined
                    ? { location: payload.location.trim() || undefined }
                    : {}),
            },
        );
    } else if (
        payload.relationship !== undefined ||
        payload.phone !== undefined ||
        payload.phoneCountryCode !== undefined ||
        payload.location !== undefined
    ) {
        await FamilyInvitation.updateMany(
            { familyId, userId: memberUserId },
            {
                ...(payload.relationship !== undefined
                    ? { relationship: payload.relationship.trim() || undefined }
                    : {}),
                ...(payload.phone !== undefined
                    ? { phone: payload.phone.trim() || undefined }
                    : {}),
                ...(payload.phoneCountryCode !== undefined
                    ? { phoneCountryCode: payload.phoneCountryCode.trim() || undefined }
                    : {}),
                ...(payload.location !== undefined
                    ? { location: payload.location.trim() || undefined }
                    : {}),
            },
        );
    }

    if (payload.phone?.trim() && payload.phoneCountryCode?.trim()) {
        await User.updateOne(
            { userId: memberUserId },
            {
                phone: {
                    countryCode: payload.phoneCountryCode.trim(),
                    number: payload.phone.replace(/\D/g, ""),
                },
            },
        );
    }

    return getFamilyMembersList(familyId, actorUserId);
}

export async function updateInvitationDetails(
    familyId: string,
    actorUserId: string,
    inviteId: string,
    payload: {
        role?: string;
        name?: string;
        namePrefix?: string;
        relationship?: string;
        phone?: string;
        phoneCountryCode?: string;
        location?: string;
    },
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    await assertCanManage(family, actorUserId);

    const invitation = await FamilyInvitation.findOne({
        inviteId,
        familyId,
        status: FamilyInvitationStatus.PENDING,
    });

    if (!invitation) {
        throw new AppError("Invitation not found", 404);
    }

    if (payload.role) {
        const role = mapUiRoleToFamilyRole(payload.role);
        if (role === FamilyRole.PRIMARY_CAREGIVER) {
            throw new AppError("Cannot assign primary caregiver role", 400);
        }
        invitation.role = role;

        if (invitation.userId) {
            const member = family.members.find((m) => m.userId === invitation.userId);
            if (member && member.status === FamilyMemberStatus.PENDING) {
                member.role = role;
                await family.save();
            }
        }
    }

    if (payload.name?.trim() || payload.namePrefix !== undefined) {
        const { namePrefix, name: memberName } = normalizeMemberNameInput(payload);
        invitation.inviteeName = memberName || undefined;
        invitation.namePrefix = namePrefix || undefined;
    }
    if (payload.relationship !== undefined) {
        invitation.relationship = payload.relationship.trim() || undefined;
    }
    if (payload.phone !== undefined) invitation.phone = payload.phone.trim() || undefined;
    if (payload.phoneCountryCode !== undefined) {
        invitation.phoneCountryCode = payload.phoneCountryCode.trim() || undefined;
    }
    if (payload.location !== undefined) {
        invitation.location = payload.location.trim() || undefined;
    }

    await invitation.save();

    return getFamilyMembersList(familyId, actorUserId);
}

export async function revokeInvitation(
    familyId: string,
    actorUserId: string,
    inviteId: string,
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    await assertCanManage(family, actorUserId);

    const invitation = await FamilyInvitation.findOne({
        inviteId,
        familyId,
        status: FamilyInvitationStatus.PENDING,
    });

    if (!invitation) {
        throw new AppError("Invitation not found", 404);
    }

    invitation.status = FamilyInvitationStatus.REVOKED;
    await invitation.save();

    if (invitation.userId) {
        const member = family.members.find((m) => m.userId === invitation.userId);
        if (member?.status === FamilyMemberStatus.PENDING) {
            member.status = FamilyMemberStatus.REMOVED;
            await family.save();
        }
    }

    return getFamilyMembersList(familyId, actorUserId);
}

export async function acceptInvitationById(user: IUserDocument, inviteId: string) {
    const invitation = await FamilyInvitation.findOne({
        inviteId,
        status: FamilyInvitationStatus.PENDING,
        expiresAt: { $gt: new Date() },
    });

    if (!invitation) {
        throw new AppError("Invitation not found or expired", 404);
    }

    if (invitation.userId && invitation.userId !== user.userId) {
        throw new AppError("This invitation belongs to another account", 403);
    }

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new AppError("This invitation was sent to a different email address", 403);
    }

    const family = await Family.findOne({ familyId: invitation.familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    const existing = family.members.find((m) => m.userId === user.userId);
    if (existing?.status === FamilyMemberStatus.BLOCKED) {
        throw new AppError("You are blocked from this family", 403);
    }

    if (existing?.status !== FamilyMemberStatus.JOINED) {
        if (existing) {
            await family.updateMemberStatus(user.userId, FamilyMemberStatus.JOINED);
        } else {
            await family.addMember(user.userId, invitation.role, {
                status: FamilyMemberStatus.JOINED,
                invitedBy: invitation.invitedBy,
            });
        }
    }

    invitation.status = FamilyInvitationStatus.ACCEPTED;
    invitation.userId = user.userId;
    await invitation.save();

    const joinedBefore = await getFamiliesForUser(user.userId);
    const keepCurrentPrimary = joinedBefore.some(
        (existing) => existing.familyId !== family.familyId,
    );

    if (!keepCurrentPrimary) {
        await User.updateOne({ userId: user.userId }, { activeFamilyId: family.familyId });
        user.activeFamilyId = family.familyId;
    }

    const familyContext = await import("./family.service").then((m) =>
        m.getStoredFamilyContext(user.userId),
    );

    return {
        family: await formatFamilyDetail(family, user.userId),
        activeFamilyId: keepCurrentPrimary
            ? (familyContext?.activeFamilyId ?? user.activeFamilyId)
            : family.familyId,
        activeFamily: familyContext?.activeFamily ?? null,
        families: familyContext?.families ?? [],
    };
}

export async function rejectInvitationById(user: IUserDocument, inviteId: string) {
    const invitation = await FamilyInvitation.findOne({
        inviteId,
        status: FamilyInvitationStatus.PENDING,
    });

    if (!invitation) {
        throw new AppError("Invitation not found", 404);
    }

    if (invitation.userId && invitation.userId !== user.userId) {
        throw new AppError("This invitation belongs to another account", 403);
    }

    if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new AppError("This invitation was sent to a different email address", 403);
    }

    const family = await Family.findOne({ familyId: invitation.familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    const member = family.members.find((m) => m.userId === user.userId);
    if (member && member.status === FamilyMemberStatus.PENDING) {
        member.status = FamilyMemberStatus.REJECTED;
        await family.save();
    }

    invitation.status = FamilyInvitationStatus.DECLINED;
    await invitation.save();

    const joinedFamilies = await getFamiliesForUser(user.userId);
    let createdOwnFamily = false;
    if (joinedFamilies.length === 0) {
        await createDefaultFamilyForUser(user);
        createdOwnFamily = true;
    }

    return { success: true, createdOwnFamily };
}
