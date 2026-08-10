/**
 * Session & JWT types for Kavach auth
 */

import { AuthProvider } from "./user.types";

export enum SessionStatus {
    ACTIVE = "ACTIVE",
    REVOKED = "REVOKED",
    EXPIRED = "EXPIRED",
}

export interface ISession {
    sessionId: string;
    userId: string;
    tokenHash: string;
    fingerprint: string;
    authProvider: AuthProvider;
    userAgent?: string;
    ipAddress?: string;
    status: SessionStatus;
    expiresAt: Date;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface IJwtPayload {
    userId: string;
    email: string;
    sessionId: string;
    authProvider: AuthProvider;
}
