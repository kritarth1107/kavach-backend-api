import WhatsappInboundDedupe from "../models/whatsappInboundDedupe.model";

/** In-flight on this process. A restart clears it; Mongo's lease is what survives a kill. */
const inflight = new Set<string>();
const LEASE_MS = 3 * 60_000;
const MAX_ATTEMPTS = 3;
let indexReady: Promise<unknown> | undefined;

export type ClaimRow = { answeredAt?: Date | null; leasedUntil?: Date | null; attempts?: number; payload?: unknown };

/** new: first time. resume: the worker died. busy: someone is answering. done: already answered, or an old claim with no payload. */
export function claimDecision(row: ClaimRow | null, now = Date.now()): "new" | "resume" | "busy" | "done" {
    if (!row) return "new";
    if (row.answeredAt || !row.payload) return "done";
    if ((row.attempts ?? 0) >= MAX_ATTEMPTS) return "done";
    if (row.leasedUntil && new Date(row.leasedUntil).getTime() > now) return "busy";
    return "resume";
}

function hold(id: string): boolean {
    if (inflight.has(id)) return false;
    inflight.add(id);
    return true;
}

export function releaseInbound(id: string): void {
    inflight.delete(id);
}

/**
 * Claim an inbound WhatsApp message id. Returns true exactly once per id across all
 * instances (Mongo unique index); false for Meta retries / duplicates.
 * Messages without an id are always processed.
 */
function payloadOf(inbound: Record<string, unknown> | undefined, id: string): Record<string, unknown> | undefined {
    if (!inbound) return undefined;
    const keep = ["from", "text", "messageId", "interactiveId", "mediaType", "mediaId", "mediaCaption", "replyToId", "location", "profileName"];
    const out: Record<string, unknown> = { messageId: id };
    for (const key of keep) if (inbound[key] != null) out[key] = inbound[key];
    return out;
}

export async function claimWhatsAppInboundMessage(
    messageId: string | undefined,
    from?: string,
    media?: { mediaId?: string; mediaType?: string },
    inbound?: Record<string, unknown>,
): Promise<boolean> {
    const id = (messageId ?? "").trim();
    if (!id) return true;
    if (!hold(id)) return false;
    try {
        indexReady ??= WhatsappInboundDedupe.init().catch(() => undefined);
        await indexReady;
        const { clockNow } = await import("../utils/clock.util");
        const phone = String(from ?? "").replace(/\D/g, "");
        const payload = payloadOf(inbound, id);
        const now = clockNow();
        await WhatsappInboundDedupe.create({
            messageId: id, from: from?.slice(-4), ...(phone.length >= 8 ? { phone } : {}), createdAt: now,
            leasedUntil: new Date(now.getTime() + LEASE_MS), attempts: 1,
            ...(payload ? { payload } : {}),
            ...(media?.mediaId ? { mediaId: media.mediaId, mediaType: media.mediaType } : {}),
        });
        return true;
    } catch (err) {
        const code = (err as { code?: number } | null)?.code;
        if (code === 11000) {
            const row = await WhatsappInboundDedupe.findOne({ messageId: id }).lean<ClaimRow>().catch(() => null);
            if (claimDecision(row) !== "resume") {
                releaseInbound(id);
                return false;
            }
            const now = new Date();
            const taken = await WhatsappInboundDedupe.findOneAndUpdate(
                { messageId: id, answeredAt: { $exists: false }, payload: { $exists: true }, attempts: { $lt: MAX_ATTEMPTS },
                  $or: [{ leasedUntil: { $lte: now } }, { leasedUntil: { $exists: false } }] },
                { $set: { leasedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
            ).catch(() => null);
            if (!taken) releaseInbound(id);
            return !!taken;
        }
        console.warn("WhatsApp inbound dedupe claim failed (processing anyway):", err instanceof Error ? err.message : err);
        return true;
    }
}

export async function markInboundAnswered(messageId: string | undefined): Promise<void> {
    const id = (messageId ?? "").trim();
    if (!id) return;
    const { clockNow } = await import("../utils/clock.util");
    await WhatsappInboundDedupe.updateOne({ messageId: id }, { $set: { answeredAt: clockNow() } }).catch(() => undefined);
    releaseInbound(id);
}

/** Claims whose worker died. Each row is leased to this caller. */
export async function takeExpiredInbounds(now = new Date()): Promise<Array<Record<string, unknown>>> {
    const rows = await WhatsappInboundDedupe.find({
        answeredAt: { $exists: false }, payload: { $exists: true }, attempts: { $lt: MAX_ATTEMPTS }, leasedUntil: { $lte: now },
    }).limit(20).lean<Array<{ messageId: string; payload?: Record<string, unknown> }>>();
    const out: Array<Record<string, unknown>> = [];
    for (const row of rows) {
        if (!hold(row.messageId)) continue;
        const taken = await WhatsappInboundDedupe.findOneAndUpdate(
            { messageId: row.messageId, answeredAt: { $exists: false }, attempts: { $lt: MAX_ATTEMPTS }, leasedUntil: { $lte: now } },
            { $set: { leasedUntil: new Date(now.getTime() + LEASE_MS) }, $inc: { attempts: 1 } },
            { new: true },
        ).catch(() => null);
        if (!taken?.payload) {
            releaseInbound(row.messageId);
            continue;
        }
        out.push(taken.payload as Record<string, unknown>);
    }
    return out;
}

/** An earlier inbound message (for a reply that quotes it): whether it was theirs, and the media it carried if known. */
export async function quotedMedia(messageId: string | undefined): Promise<{ theirs: boolean; mediaId?: string; mediaType?: string } | null> {
    const id = (messageId ?? "").trim();
    if (!id) return null;
    const row = await WhatsappInboundDedupe.findOne({ messageId: id }, { mediaId: 1, mediaType: 1 }).lean<{ mediaId?: string; mediaType?: string }>().catch(() => null);
    if (!row) return { theirs: false };
    return row.mediaId ? { theirs: true, mediaId: row.mediaId, mediaType: row.mediaType || "image" } : { theirs: true };
}
