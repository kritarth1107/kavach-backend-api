/**
 * Operational alerts to the Kavach team (founder 2026-10-13: "if reminder data is lost or spoofed, nothing else matters").
 * One email per problem key at most every `everyMs` (default 30 min). The window is a Mongo row, so two tasks
 * do not both send. Dose failures are not sent here one by one: they wait for the 15-minute digest.
 * A crisis (the tick stopped, a forged webhook, the brain holding) still sends on its own.
 */

type Entry = { lastSent: number; suppressed: number };

const seen = new Map<string, Entry>();

function dup(err: unknown): boolean {
    return typeof err === "object" && err != null && (err as { code?: number }).code === 11000;
}

let indexesReady: Promise<void> | null = null;

async function claimWindow(key: string, every: number, now: number): Promise<boolean | null> {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return null;
    const bucket = every <= 0 ? key : `${key}:${Math.floor(now / every)}`;
    try {
        const Throttle = (await import("../models/opsAlertThrottle.model")).default;
        indexesReady ??= Throttle.createIndexes().then(() => undefined);
        await indexesReady;
        await Throttle.create({ key: bucket, at: new Date(now) });
        return true;
    } catch (err) {
        if (dup(err)) return false;
        return null;
    }
}

export async function alertOps(key: string, subject: string, text: string, opts: { everyMs?: number; now?: number } = {}): Promise<{ sent: boolean; suppressed?: number; error?: string }> {
    const now = opts.now ?? Date.now();
    const every = opts.everyMs ?? 30 * 60_000;
    const shared = await claimWindow(key, every, now);
    if (shared === false) return { sent: false, suppressed: 1 };
    const entry = seen.get(key);
    if (shared == null && entry && every > 0 && now - entry.lastSent < every && now >= entry.lastSent) {
        entry.suppressed += 1;
        return { sent: false, suppressed: entry.suppressed };
    }
    const suppressed = entry?.suppressed ?? 0;
    seen.set(key, { lastSent: now, suppressed: 0 });
    const body = suppressed ? `${text}\n\n(${suppressed} more of these since the last email.)` : text;
    try {
        const { sendCareTeamAlert } = await import("./email.service");
        await sendCareTeamAlert(`[Kavach ops] ${subject}`, body);
        return { sent: true };
    } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 200) : "send failed";
        console.error(`[ops-alert] email failed key=${key}: ${error}`);
        return { sent: false, error };
    }
}

/** Team notes that are not a crisis: at most one email every 15 minutes, the rest wait and go in the next note. */
const DIGEST_MS = 15 * 60_000;

export async function noteTeamDigest(
    kind: "template",
    subject: string,
    text: string,
    items: Array<Record<string, unknown>>,
    now = new Date(),
): Promise<boolean> {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) {
        const out = await alertOps(`${kind}-digest:${now.getTime()}`, subject, text, { everyMs: 0, now: now.getTime() });
        return out.sent;
    }
    const OpsAlertLog = (await import("../models/opsAlertLog.model")).default;
    const won = await claimWindow(`${kind}-digest`, DIGEST_MS, now.getTime());
    if (won === false) {
        await OpsAlertLog.create({ kind, subject, text, items, emailed: false, at: now }).catch(() => undefined);
        return false;
    }
    const held = await OpsAlertLog.find({ kind, emailed: false }).sort({ at: 1 }).lean<Array<{ _id: unknown; text?: string; items?: unknown[] }>>();
    const extra = held.reduce((n, h) => n + (h.items?.length ?? 0), 0);
    const count = extra + items.length;
    const combinedSubject = held.length ? `${count} team notes since the last email` : subject;
    const combined = held.length
        ? [`${count} notes since the last email.`, "", ...held.map((h) => h.text || ""), text].join("\n")
        : text;
    const out = await alertOps(`${kind}-digest:${now.getTime()}`, combinedSubject, combined, { everyMs: 0, now: now.getTime() });
    await OpsAlertLog.create({ kind, subject: combinedSubject, text: combined, items, emailed: out.sent, ...(out.error ? { error: out.error } : {}), at: now }).catch(() => undefined);
    if (out.sent && held.length) {
        await OpsAlertLog.updateMany({ _id: { $in: held.map((h) => h._id) } }, { $set: { emailed: true } }).catch(() => undefined);
    }
    return out.sent;
}

/** Held notes go out once the 15 minutes have passed, even when nothing new happened. */
export async function flushTeamDigests(now = new Date()): Promise<void> {
    const mongoose = (await import("mongoose")).default;
    if (mongoose.connection.readyState !== 1) return;
    const OpsAlertLog = (await import("../models/opsAlertLog.model")).default;
    for (const kind of ["dose", "template"] as const) {
        const pending = await OpsAlertLog.find({ kind, emailed: false }).sort({ at: 1 }).lean<Array<{ _id: unknown; text?: string; items?: unknown[] }>>();
        if (!pending.length) continue;
        const last = await OpsAlertLog.findOne({ kind, emailed: true }).sort({ at: -1 }).lean<{ at: Date }>();
        const age = last ? now.getTime() - new Date(last.at).getTime() : Number.POSITIVE_INFINITY;
        if (age >= 0 && age < DIGEST_MS) continue;
        const count = pending.reduce((n, h) => n + (h.items?.length ?? 0), 0);
        const subject = kind === "dose" ? `${count} dose reminders did not reach the phone` : `${count} team notes since the last email`;
        const text = pending.map((h) => h.text || "").filter(Boolean).join("\n\n");
        const out = await alertOps(`${kind}-flush:${now.getTime()}`, subject, text, { everyMs: 0, now: now.getTime() });
        if (out.sent) await OpsAlertLog.updateMany({ _id: { $in: pending.map((h) => h._id) } }, { $set: { emailed: true } }).catch(() => undefined);
    }
}

/** Tests only. */
export function resetOpsAlerts(): void {
    seen.clear();
}
