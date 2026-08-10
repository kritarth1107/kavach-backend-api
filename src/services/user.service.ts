import User, { IUserDocument } from "../models/users.model";
import Session from "../models/session.model";
import { AppError } from "../middleware/error.middleware";
import { getUserInitials } from "./family.service";
import { AuthProvider, IUserPreferences } from "../types/user.types";
import { SessionStatus } from "../types/session.types";

const defaultPreferences: IUserPreferences = {
    emailAlerts: true,
    pushReminders: true,
    weeklyDigest: false,
    familyActivity: true,
    medicineReminders: true,
    checkInReminders: true,
};

export function buildUserProfile(user: IUserDocument) {
    const socialAccounts = user.socialAccounts.map((account) => ({
        provider: account.provider,
        email: account.email,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
        linkedAt: account.linkedAt,
        lastUsedAt: account.lastUsedAt,
    }));

    return {
        userId: user.userId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        initials: getUserInitials(user.firstName, user.lastName, user.email),
        avatarUrl: user.avatarUrl,
        phone: user.phone ?? null,
        emailVerified: user.emailVerified,
        primaryAuthProvider: user.primaryAuthProvider,
        linkedProviders: user.linkedProviders,
        socialAccounts,
        hasPassword: user.hasPassword,
        preferences: { ...defaultPreferences, ...user.preferences },
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
    };
}

export async function updateUserProfile(
    userId: string,
    payload: {
        firstName?: string;
        lastName?: string;
        phone?: string | null;
        phoneCountryCode?: string | null;
        avatarUrl?: string | null;
        preferences?: Partial<IUserPreferences>;
    },
) {
    const user = await User.findOne({ userId });
    if (!user) {
        throw new AppError("User not found", 404);
    }

    if (payload.firstName !== undefined) {
        user.firstName = payload.firstName.trim() || undefined;
    }

    if (payload.lastName !== undefined) {
        user.lastName = payload.lastName.trim() || undefined;
    }

    if (payload.avatarUrl !== undefined) {
        user.avatarUrl = payload.avatarUrl?.trim() || undefined;
    }

    if (payload.phone !== undefined || payload.phoneCountryCode !== undefined) {
        const phone = payload.phone?.trim() ?? "";
        const countryCode = payload.phoneCountryCode?.trim() ?? "";

        if (!phone && !countryCode) {
            user.phone = undefined;
        } else {
            if (!phone || !countryCode) {
                throw new AppError("Both phone number and country code are required", 400);
            }
            user.phone = { countryCode, number: phone.replace(/\D/g, "") };
        }
    }

    if (payload.preferences) {
        user.preferences = {
            ...defaultPreferences,
            ...user.preferences,
            ...payload.preferences,
        };
    }

    await user.save();
    return buildUserProfile(user);
}

export async function listUserSessions(userId: string, currentSessionId?: string) {
    const sessions = await Session.find({
        userId,
        status: SessionStatus.ACTIVE,
        expiresAt: { $gt: new Date() },
    })
        .sort({ lastActiveAt: -1 })
        .lean();

    return sessions.map((session) => ({
        sessionId: session.sessionId,
        authProvider: session.authProvider,
        userAgent: session.userAgent ?? "Unknown device",
        ipAddress: session.ipAddress ?? null,
        lastActiveAt: session.lastActiveAt,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        isCurrent: session.sessionId === currentSessionId,
    }));
}

export async function revokeUserSession(
    userId: string,
    sessionId: string,
    currentSessionId?: string,
) {
    if (sessionId === currentSessionId) {
        throw new AppError("Cannot revoke your current session from here. Use sign out instead.", 400);
    }

    const session = await Session.findOne({
        userId,
        sessionId,
        status: SessionStatus.ACTIVE,
    });

    if (!session) {
        throw new AppError("Session not found", 404);
    }

    await session.revoke();
    return { revoked: true };
}

export async function revokeOtherUserSessions(userId: string, currentSessionId?: string) {
    const filter: Record<string, unknown> = {
        userId,
        status: SessionStatus.ACTIVE,
    };

    if (currentSessionId) {
        filter.sessionId = { $ne: currentSessionId };
    }

    const result = await Session.updateMany(filter, { status: SessionStatus.REVOKED });
    return { revokedCount: result.modifiedCount ?? 0 };
}

export function describeAuthProvider(provider: AuthProvider) {
    switch (provider) {
        case AuthProvider.GOOGLE:
            return "Google";
        case AuthProvider.APPLE:
            return "Apple";
        case AuthProvider.EMAIL:
            return "Email OTP";
        default:
            return provider;
    }
}
