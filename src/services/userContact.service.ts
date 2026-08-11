import FamilyInvitation from "../models/familyInvitation.model";
import User, { IUserDocument } from "../models/users.model";
import { FamilyInvitationStatus } from "../types/family.types";

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
