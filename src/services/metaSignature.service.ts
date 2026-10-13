/**
 * Meta signs every webhook POST with the app secret (X-Hub-Signature-256). Without the check anyone could forge an
 * inbound message "from" any elder's number, a "done" tap on a dose, or a delivery receipt.
 *
 * WHATSAPP_META_SIGNATURE=enforce (production, since 2026-10-13: 7 days of live traffic had no bad signature) rejects
 * anything that is not signed right, and fails closed when the secret is missing (that is a misconfiguration, never a
 * reason to let requests through). "log" (local and tests) only warns.
 */
import { createHmac, timingSafeEqual } from "crypto";

export type SignatureStatus = "ok" | "bad" | "missing" | "no_secret";

export function metaSignatureStatus(secret: string | undefined, header: string | undefined, raw: Buffer | undefined): SignatureStatus {
    if (!secret) return "no_secret";
    const h = String(header ?? "");
    if (!h.startsWith("sha256=") || !raw) return "missing";
    const expected = `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
    if (expected.length !== h.length) return "bad";
    return timingSafeEqual(Buffer.from(expected), Buffer.from(h)) ? "ok" : "bad";
}

export function signatureMode(): "enforce" | "log" {
    return process.env.WHATSAPP_META_SIGNATURE === "enforce" ? "enforce" : "log";
}

/** Enforce rejects every status but ok, including a missing secret. */
export function rejectWebhook(status: SignatureStatus, mode = signatureMode()): boolean {
    return mode === "enforce" && status !== "ok";
}

const recent: number[] = [];

/** Count a rejection; the team hears about a missing secret at once and about a burst (20 in 10 minutes). */
export async function noteRejected(status: SignatureStatus, now = Date.now()): Promise<void> {
    recent.push(now);
    while (recent.length && now - recent[0] > 10 * 60_000) recent.shift();
    const { alertOps } = await import("./opsAlert.service");
    if (status === "no_secret") {
        await alertOps("webhook-no-secret", "WhatsApp webhook secret missing: every message is being refused",
            "WHATSAPP_META_SIGNATURE=enforce but WHATSAPP_META_APP_SECRET is not set on kavach-backend, so every WhatsApp webhook is refused (fail closed). Set the secret and redeploy.", { now });
    } else if (recent.length >= 20) {
        await alertOps("webhook-forged", "Many unsigned WhatsApp webhook calls refused",
            `${recent.length} webhook calls in the last 10 minutes had a ${status} signature and were refused. Someone may be trying to forge messages, or the app secret changed at Meta.`, { now });
    }
}

/** Tests only. */
export function resetRejections(): void {
    recent.length = 0;
}
