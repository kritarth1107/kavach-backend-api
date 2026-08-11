import FamilyInvitation, {
    IFamilyInvitationDocument,
} from "../models/familyInvitation.model";
import User, { IUserDocument } from "../models/users.model";
import { FamilyInvitationStatus } from "../types/family.types";
import { AuthProvider } from "../types/user.types";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import config from "../config/app.config";

function buildPlaceholderMemberEmail(): string {
    return `${randomBytes(16).toString("hex")}@pending.kavach`;
}

export function isPlaceholderAccountEmail(email?: string | null): boolean {
    if (!email) {
        return false;
    }
    return email.endsWith("@pending.kavach");
}

export async function findUserByContactEmail(
    email: string,
): Promise<IUserDocument | null> {
    const normalized = email.toLowerCase().trim();

    const direct = await User.findOne({ email: normalized });
    if (direct && !isPlaceholderAccountEmail(direct.email)) {
        return direct;
    }

    const invitation = await FamilyInvitation.findOne({
        email: normalized,
        userId: { $exists: true, $ne: null },
        status: {
            $in: [
                FamilyInvitationStatus.ACCEPTED,
                FamilyInvitationStatus.PENDING,
            ],
        },
    });

    if (invitation?.userId) {
        const linked = await User.findOne({ userId: invitation.userId });
        if (linked) {
            return linked;
        }

        return ensureUserAccountForInvitation(invitation);
    }

    return direct;
}

export function resolveMemberContactEmail(
    userEmail?: string | null,
    invitationEmail?: string | null,
): string | null {
    if (invitationEmail && !isPlaceholderAccountEmail(invitationEmail)) {
        return invitationEmail;
    }

    if (userEmail && !isPlaceholderAccountEmail(userEmail)) {
        return userEmail;
    }

    return invitationEmail ?? userEmail ?? null;
}

export async function ensureUserAccountForInvitation(
    invitation: IFamilyInvitationDocument,
): Promise<IUserDocument | null> {
    if (!invitation.userId) {
        return null;
    }

    const existing = await User.findOne({ userId: invitation.userId });
    if (existing) {
        return existing;
    }

    const inviteeName = invitation.inviteeName?.trim() || "Member";
    const [firstName, ...rest] = inviteeName.split(/\s+/).filter(Boolean);
    const raw = randomBytes(24).toString("hex");
    const passwordHash = await bcrypt.hash(raw, config.security.bcryptSaltRounds);

    try {
        return await User.create({
            userId: invitation.userId,
            email: buildPlaceholderMemberEmail(),
            firstName,
            lastName: rest.join(" ") || undefined,
            passwordHash,
            primaryAuthProvider: AuthProvider.EMAIL,
            emailVerified: false,
        });
    } catch (error) {
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            (error as { code?: number }).code === 11000
        ) {
            return User.findOne({ userId: invitation.userId });
        }
        throw error;
    }
}
