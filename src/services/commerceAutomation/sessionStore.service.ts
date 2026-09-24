import crypto from "crypto";
import CommerceAutomationSession from "../../models/commerceAutomationSession.model";
import type {
    AutomationSessionStatus,
    CommercePartnerKey,
    StoredPartnerSession,
} from "./types";

function encryptionKey(): Buffer | null {
    const raw = process.env.COMMERCE_SESSION_ENCRYPTION_KEY?.trim();
    if (!raw) return null;
    // 32-byte key as hex or utf8 padded
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSessionBlob(plaintext: string): string | null {
    const key = encryptionKey();
    if (!key) {
        console.warn("COMMERCE_SESSION_ENCRYPTION_KEY unset — refusing to persist session blob");
        return null;
    }
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSessionBlob(blob: string): string | null {
    const key = encryptionKey();
    if (!key) return null;
    try {
        const buf = Buffer.from(blob, "base64");
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const data = buf.subarray(28);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch {
        return null;
    }
}

export async function getAutomationSession(
    userId: string,
    partner: CommercePartnerKey,
): Promise<StoredPartnerSession | null> {
    const row = await CommerceAutomationSession.findOne({ userId, partner }).lean();
    if (!row) return null;
    return {
        userId: row.userId,
        partner: row.partner as CommercePartnerKey,
        status: row.status as AutomationSessionStatus,
        encryptedBlob: row.encryptedBlob,
        otpChallengeId: row.otpChallengeId,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
        connectedAt: row.connectedAt,
    };
}

export async function upsertAutomationSession(input: {
    userId: string;
    partner: CommercePartnerKey;
    status: AutomationSessionStatus;
    encryptedBlob?: string | null;
    otpChallengeId?: string | null;
    lastError?: string | null;
    connectedAt?: Date | null;
}): Promise<StoredPartnerSession> {
    const row = await CommerceAutomationSession.findOneAndUpdate(
        { userId: input.userId, partner: input.partner },
        {
            $set: {
                status: input.status,
                encryptedBlob: input.encryptedBlob ?? undefined,
                otpChallengeId: input.otpChallengeId ?? undefined,
                lastError: input.lastError ?? undefined,
                connectedAt: input.connectedAt ?? undefined,
            },
        },
        { upsert: true, new: true },
    ).lean();
    return {
        userId: row!.userId,
        partner: row!.partner as CommercePartnerKey,
        status: row!.status as AutomationSessionStatus,
        encryptedBlob: row!.encryptedBlob,
        otpChallengeId: row!.otpChallengeId,
        lastError: row!.lastError,
        updatedAt: row!.updatedAt,
        connectedAt: row!.connectedAt,
    };
}

/**
 * WhatsApp OTP relay state machine:
 * disconnected → pending_login → awaiting_otp → connected | error
 */
export async function beginOtpLogin(input: {
    userId: string;
    partner: CommercePartnerKey;
    otpChallengeId: string;
}): Promise<StoredPartnerSession> {
    return upsertAutomationSession({
        userId: input.userId,
        partner: input.partner,
        status: "awaiting_otp",
        otpChallengeId: input.otpChallengeId,
        lastError: null,
    });
}

export async function markSessionConnected(input: {
    userId: string;
    partner: CommercePartnerKey;
    encryptedBlob?: string;
}): Promise<StoredPartnerSession> {
    return upsertAutomationSession({
        userId: input.userId,
        partner: input.partner,
        status: "connected",
        encryptedBlob: input.encryptedBlob,
        otpChallengeId: null,
        lastError: null,
        connectedAt: new Date(),
    });
}
