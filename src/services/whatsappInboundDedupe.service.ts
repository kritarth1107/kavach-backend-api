import WhatsappInboundDedupe from "../models/whatsappInboundDedupe.model";

/** Per-instance fast path (also covers a Mongo blip). */
const recent = new Map<string, number>();
const RECENT_TTL_MS = 30 * 60 * 1000;
let indexReady: Promise<unknown> | undefined;

function rememberLocal(id: string): boolean {
    const now = Date.now();
    if (recent.size > 2000) {
        for (const [k, at] of recent) {
            if (now - at > RECENT_TTL_MS) recent.delete(k);
        }
    }
    if (recent.has(id)) return false;
    recent.set(id, now);
    return true;
}

/**
 * Claim an inbound WhatsApp message id. Returns true exactly once per id across all
 * instances (Mongo unique index); false for Meta retries / duplicates.
 * Messages without an id are always processed.
 */
export async function claimWhatsAppInboundMessage(
    messageId: string | undefined,
    from?: string,
): Promise<boolean> {
    const id = (messageId ?? "").trim();
    if (!id) return true;
    if (!rememberLocal(id)) return false;
    try {
        // Ensure the unique index exists before the first claim (no-op afterwards).
        indexReady ??= WhatsappInboundDedupe.init().catch(() => undefined);
        await indexReady;
        await WhatsappInboundDedupe.create({ messageId: id, from: from?.slice(-4) });
        return true;
    } catch (err) {
        const code = (err as { code?: number } | null)?.code;
        if (code === 11000) return false;
        // Fail open on DB errors (local map still dedupes on this instance).
        console.warn(
            "WhatsApp inbound dedupe claim failed (processing anyway):",
            err instanceof Error ? err.message : err,
        );
        return true;
    }
}
