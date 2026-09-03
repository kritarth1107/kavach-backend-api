import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import config from "../config/app.config";

function key() {
    const secret = config.encryption.secretKey;
    if (!secret) throw new Error("AES_SECRET is not configured");
    return createHash("sha256").update(secret).digest();
}

export function encryptJson(value: unknown): string {
    const iv = randomBytes(config.encryption.ivLength);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const plain = JSON.stringify(value);
    const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("base64")}.${authTag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptJson<T>(payload: string): T {
    const [ivB64, tagB64, dataB64] = payload.split(".");
    if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid encrypted payload");
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(tagB64, "base64");
    const encrypted = Buffer.from(dataB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(authTag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return JSON.parse(plain) as T;
}
