import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "crypto";
import jwt from "jsonwebtoken";
import config from "../config/app.config";
import { AuthOtpCode } from "../models/authOtp.model";

const OTP_EXPIRY = "10m";
const OTP_EXPIRY_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

export type OtpChannel = "email" | "phone";

interface IOtpJwtPayload extends jwt.JwtPayload {
  sub: "otp";
  channel?: OtpChannel;
  identifier?: string;
  /** @deprecated legacy email-only tokens */
  email?: string;
  enc: string;
  jti: string;
}

function getAesKey(): Buffer {
  const secret = config.encryption.secretKey;
  if (!secret) {
    throw new Error("AES_SECRET is not configured");
  }
  return createHash("sha256").update(secret).digest();
}

function encryptOtp(code: string): string {
  const key = getAesKey();
  const iv = randomBytes(config.encryption.ivLength);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptOtp(enc: string): string {
  const [ivB64, tagB64, dataB64] = enc.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted OTP format");
  }

  const key = getAesKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function codesMatch(expected: string, submitted: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(submitted);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function resolvePayloadIdentity(payload: IOtpJwtPayload): {
  channel: OtpChannel;
  identifier: string;
} | null {
  if (payload.channel && payload.identifier) {
    return { channel: payload.channel, identifier: payload.identifier };
  }

  if (payload.email) {
    return { channel: "email", identifier: payload.email.toLowerCase().trim() };
  }

  return null;
}

export function generateOtpCode(): string {
  return String(randomInt(100000, 999999));
}

/** The token carries the code (encrypted); its tries and use live in the database (AuthOtpCode). */
export async function createOtpToken(
  channel: OtpChannel,
  identifier: string,
  code: string,
): Promise<string> {
  const normalized =
    channel === "email" ? identifier.toLowerCase().trim() : identifier.trim();

  const payload: IOtpJwtPayload = {
    sub: "otp",
    channel,
    identifier: normalized,
    enc: encryptOtp(code),
    jti: randomBytes(16).toString("hex"),
  };

  await AuthOtpCode.create({
    jti: payload.jti,
    channel,
    expiresAt: new Date(Date.now() + OTP_EXPIRY_SECONDS * 1000),
  });
  return jwt.sign(payload, config.jwt.secret, { expiresIn: OTP_EXPIRY });
}

export type OtpVerifyResult =
  | { valid: true }
  | { valid: false; reason: "expired" | "invalid" | "max_attempts" | "consumed" };

/**
 * Check a code. Each try is counted before comparing (at most 5 per code, across all instances). `consume: false`
 * (a new user who still has to give their name) leaves the code usable once more, by the registration step.
 */
export async function verifyOtpToken(
  channel: OtpChannel,
  identifier: string,
  code: string,
  otpToken: string,
  options: { consume?: boolean } = { consume: true },
): Promise<OtpVerifyResult> {
  const normalized =
    channel === "email" ? identifier.toLowerCase().trim() : identifier.trim();

  let payload: IOtpJwtPayload;
  try {
    payload = jwt.verify(otpToken, config.jwt.secret) as IOtpJwtPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, reason: "expired" };
    }
    return { valid: false, reason: "invalid" };
  }

  const identity = resolvePayloadIdentity(payload);
  if (
    !identity ||
    identity.channel !== channel ||
    identity.identifier !== normalized ||
    !payload.enc ||
    !payload.jti
  ) {
    return { valid: false, reason: "invalid" };
  }

  const claimed = await AuthOtpCode.updateOne(
    { jti: payload.jti, usedAt: null, tries: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: new Date() } },
    { $inc: { tries: 1 } },
  );
  if (claimed.modifiedCount !== 1) {
    const row = await AuthOtpCode.findOne({ jti: payload.jti }).lean<{ usedAt?: Date | null; tries: number }>();
    if (!row) return { valid: false, reason: "expired" }; // issued before codes were tracked, or long gone
    if (row.usedAt) return { valid: false, reason: "consumed" };
    return { valid: false, reason: row.tries >= MAX_ATTEMPTS ? "max_attempts" : "expired" };
  }

  let decrypted: string;
  try {
    decrypted = decryptOtp(payload.enc);
  } catch {
    return { valid: false, reason: "invalid" };
  }

  if (!codesMatch(decrypted, code)) {
    return { valid: false, reason: "invalid" };
  }

  if (options.consume === false) {
    await AuthOtpCode.updateOne({ jti: payload.jti, usedAt: null }, { $set: { tries: 0 } });
    return { valid: true };
  }
  const used = await AuthOtpCode.updateOne({ jti: payload.jti, usedAt: null }, { $set: { usedAt: new Date() } });
  if (used.modifiedCount !== 1) return { valid: false, reason: "consumed" };
  return { valid: true };
}
