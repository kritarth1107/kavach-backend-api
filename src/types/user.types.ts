/**
 * User types for Kavach
 */

export enum UserStatus {
    ACTIVE = "ACTIVE",
    SUSPENDED = "SUSPENDED",
    BANNED = "BANNED",
    DELETED = "DELETED",
}

export enum AuthProvider {
    EMAIL = "EMAIL",
    GOOGLE = "GOOGLE",
    APPLE = "APPLE",
    X = "X",
    LINKEDIN = "LINKEDIN",
    FACEBOOK = "FACEBOOK",
    MICROSOFT = "MICROSOFT",
    GITHUB = "GITHUB",
}

export interface IPhone {
    countryCode: string;
    number: string;
}

export interface ISocialAccount {
    provider: AuthProvider;
    providerId: string;
    email?: string;
    displayName?: string;
    avatarUrl?: string;
    linkedAt: Date;
    lastUsedAt?: Date;
}

export interface IUserPreferences {
    emailAlerts: boolean;
    pushReminders: boolean;
    weeklyDigest: boolean;
    familyActivity: boolean;
    medicineReminders: boolean;
    checkInReminders: boolean;
}

export interface IUser {
    userId: string;
    email: string;
    phone?: IPhone;
    firstName?: string;
    lastName?: string;
    avatarUrl?: string;
    passwordHash?: string;
    primaryAuthProvider: AuthProvider;
    socialAccounts: ISocialAccount[];
    preferences?: IUserPreferences;
    status: UserStatus;
    emailVerified: boolean;
    activeFamilyId?: string;
    primaryFamilyId?: string;
    createdAt: Date;
    updatedAt: Date;
}
