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
import TokenBlacklist from "../utils/tokenBlacklist.util";

const OTP_EXPIRY = "10m";
const OTP_EXPIRY_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;

interface IOtpJwtPayload extends jwt.JwtPayload {
  sub: "otp";
  email: string;
  enc: string;
  jti: string;
}

const attemptCounts = new Map<string, number>();

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

export function generateOtpCode(): string {
  return String(randomInt(100000, 999999));
}

export function createOtpToken(email: string, code: string): string {
  const normalized = email.toLowerCase().trim();
  const payload: IOtpJwtPayload = {
    sub: "otp",
    email: normalized,
    enc: encryptOtp(code),
    jti: randomBytes(16).toString("hex"),
  };

  return jwt.sign(payload, config.jwt.secret, { expiresIn: OTP_EXPIRY });
}

export type OtpVerifyResult =
  | { valid: true }
  | { valid: false; reason: "expired" | "invalid" | "max_attempts" | "consumed" };

export async function verifyOtpToken(
  email: string,
  code: string,
  otpToken: string,
  options: { consume?: boolean } = { consume: true },
): Promise<OtpVerifyResult> {
  const normalized = email.toLowerCase().trim();

  if (await TokenBlacklist.isBlacklisted(otpToken)) {
    return { valid: false, reason: "consumed" };
  }

  let payload: IOtpJwtPayload;
  try {
    payload = jwt.verify(otpToken, config.jwt.secret) as IOtpJwtPayload;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      return { valid: false, reason: "expired" };
    }
    return { valid: false, reason: "invalid" };
  }

  if (payload.sub !== "otp" || payload.email !== normalized || !payload.enc || !payload.jti) {
    return { valid: false, reason: "invalid" };
  }

  const attempts = attemptCounts.get(payload.jti) ?? 0;
  if (attempts >= MAX_ATTEMPTS) {
    return { valid: false, reason: "max_attempts" };
  }

  let decrypted: string;
  try {
    decrypted = decryptOtp(payload.enc);
  } catch {
    return { valid: false, reason: "invalid" };
  }

  if (!codesMatch(decrypted, code)) {
    attemptCounts.set(payload.jti, attempts + 1);
    return { valid: false, reason: "invalid" };
  }

  attemptCounts.delete(payload.jti);

  if (options.consume !== false) {
    await TokenBlacklist.blacklistToken(otpToken, OTP_EXPIRY_SECONDS);
  }

  return { valid: true };
}
