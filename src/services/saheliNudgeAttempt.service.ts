import { randomUUID } from "crypto";
import SaheliNudgeLog, { type SaheliNudgeKind } from "../models/saheliNudgeLog.model";
import { clockNow } from "../utils/clock.util";

/**
 * Attempt bookkeeping for scheduled Saheli sends (care nudges + reminders).
 *
 * The schedulers tick every 60s on every Cloud Run instance. Previously only a
 * `delivered: true` row stopped a resend, so an undelivered/failed slot was re-sent
 * every minute for its whole window. Now each slot allows at most
 * NUDGE_MAX_ATTEMPTS sends, spaced by NUDGE_RETRY_COOLDOWN_MS, and a terminal
 * outcome (no valid recipient) stops the slot entirely.
 */
export const NUDGE_MAX_ATTEMPTS = 2; // first send + at most 1 retry
export const NUDGE_RETRY_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * How often a slot may be tried, and how long to wait before each retry (trust plan B1.7: a retry must land inside the
 * slot's window, or it never happens). A dose (sent 0–4 min after its time): again at +1 and +3 min. A reminder Saheli set
 * (15-minute window): again at +2 and +6 min. Everything else: once more after 30 min, as before.
 */
export type RetryPolicy = { maxAttempts: number; cooldownsMs: number[] };
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: NUDGE_MAX_ATTEMPTS, cooldownsMs: [NUDGE_RETRY_COOLDOWN_MS] };
export const DOSE_RETRY: RetryPolicy = { maxAttempts: 3, cooldownsMs: [60_000, 120_000] };
export const REMINDER_RETRY: RetryPolicy = { maxAttempts: 3, cooldownsMs: [120_000, 240_000] };

export function retryPolicy(key: Pick<NudgeSlotKey, "nudgeKind" | "scheduleId">): RetryPolicy {
    if (key.nudgeKind === "dose_due") return DOSE_RETRY;
    if (String(key.scheduleId ?? "").startsWith("reminder:")) return REMINDER_RETRY;
    return DEFAULT_RETRY;
}

/** The wait before the next try, after `attempts` tries. */
export function cooldownAfter(policy: RetryPolicy, attempts: number): number {
    return policy.cooldownsMs[Math.min(Math.max(1, attempts) - 1, policy.cooldownsMs.length - 1)] ?? NUDGE_RETRY_COOLDOWN_MS;
}

export type NudgeSlotKey = {
    familyId: string;
    recipientUserId: string;
    scheduleId: string;
    dateKey: string;
    nudgeKind: SaheliNudgeKind;
};

type SlotRow = {
    _id: unknown;
    delivered?: boolean;
    terminal?: boolean;
    attempts?: number;
    lastAttemptAt?: Date;
    createdAt?: Date;
};

export type NudgeSlotDecision =
    | { allowed: true }
    | { allowed: false; reason: "delivered" | "terminal" | "max_attempts" | "cooldown" };

/** Pure decision helper (exported for tests). */
export function decideNudgeSlot(rows: SlotRow[], now = new Date(), policy: RetryPolicy = DEFAULT_RETRY): NudgeSlotDecision {
    if (!rows.length) return { allowed: true };
    if (rows.some((r) => r.delivered)) return { allowed: false, reason: "delivered" };
    if (rows.some((r) => r.terminal)) return { allowed: false, reason: "terminal" };
    const attempts = rows.reduce((sum, r) => sum + Math.max(1, r.attempts ?? 0), 0);
    if (attempts >= policy.maxAttempts) return { allowed: false, reason: "max_attempts" };
    const last = Math.max(
        ...rows.map((r) => new Date(r.lastAttemptAt ?? r.createdAt ?? 0).getTime()),
    );
    if (now.getTime() - last < cooldownAfter(policy, attempts)) return { allowed: false, reason: "cooldown" };
    return { allowed: true };
}

function slotFilter(key: NudgeSlotKey) {
    return {
        familyId: key.familyId,
        recipientUserId: key.recipientUserId,
        scheduleId: key.scheduleId,
        dateKey: key.dateKey,
        nudgeKind: key.nudgeKind,
    };
}

/**
 * Atomically claim the right to send for this slot. Returns the log row id to
 * finalize, or null when the slot must not be sent now.
 */
export async function claimNudgeAttempt(
    key: NudgeSlotKey,
    messagePreview: string,
    now = clockNow(),
): Promise<string | null> {
    const rows = (await SaheliNudgeLog.find(slotFilter(key)).lean()) as unknown as SlotRow[];
    const policy = retryPolicy(key);
    const decision = decideNudgeSlot(rows, now, policy);
    if (!decision.allowed) return null;

    if (!rows.length) {
        const nudgeId = randomUUID();
        try {
            await SaheliNudgeLog.create({
                ...slotFilter(key),
                nudgeId,
                delivered: false,
                channel: "pending",
                messagePreview: messagePreview.slice(0, 200),
                attempts: 1,
                lastAttemptAt: now,
                terminal: false,
            });
            return nudgeId;
        } catch {
            // another instance claimed the slot first
            return null;
        }
    }

    // Retry: compare-and-set on lastAttemptAt so only one instance wins.
    const row = rows[0] as SlotRow & { nudgeId?: string };
    const cutoff = new Date(now.getTime() - cooldownAfter(policy, Math.max(1, row.attempts ?? 0)));
    const res = await SaheliNudgeLog.updateOne(
        {
            _id: row._id,
            delivered: { $ne: true },
            terminal: { $ne: true },
            $or: [{ lastAttemptAt: { $exists: false } }, { lastAttemptAt: { $lte: cutoff } }],
        },
        {
            $set: { lastAttemptAt: now, attempts: Math.max(1, row.attempts ?? 0) + 1 },
        },
    );
    if (!res.modifiedCount) return null;
    return row.nudgeId ?? null;
}

/** Reasons that mean a send was tried and did not reach WhatsApp (as opposed to held back on purpose: gated, done, paused). */
export function sendFailedReason(reason?: string): boolean {
    return /^(send_failed|outside_window|invalid_recipient|no_valid_recipient|no_template|late_reminder_)/.test(String(reason ?? ""));
}

/** How many sends this slot has had (for the delivery ledger's attempt count). */
export async function attemptsOf(nudgeId: string): Promise<number> {
    const row = await SaheliNudgeLog.findOne({ nudgeId }, { attempts: 1 }).lean<{ attempts?: number }>().catch(() => null);
    return Math.max(1, row?.attempts ?? 1);
}

export async function finalizeNudgeAttempt(
    nudgeId: string,
    outcome: {
        delivered: boolean;
        channel: string;
        messagePreview?: string;
        terminal?: boolean;
        reason?: string;
        /** The WhatsApp message id Meta gave the send (the delivery ledger links receipts back to this row). */
        wamid?: string;
    },
): Promise<void> {
    const deliveryStatus = outcome.delivered ? "sent" : sendFailedReason(outcome.reason) ? "failed" : undefined;
    await SaheliNudgeLog.updateOne(
        { nudgeId },
        {
            $set: {
                delivered: outcome.delivered,
                channel: outcome.channel,
                terminal: Boolean(outcome.terminal),
                ...(outcome.reason ? { reason: outcome.reason } : {}),
                ...(outcome.messagePreview
                    ? { messagePreview: outcome.messagePreview.slice(0, 200) }
                    : {}),
                ...(outcome.wamid ? { wamid: outcome.wamid } : {}),
                ...(deliveryStatus ? { deliveryStatus } : {}),
                ...(deliveryStatus === "failed" ? { failedAt: new Date() } : {}),
            },
            ...(outcome.delivered ? { $unset: { failedAt: 1, errorCode: 1 } } : {}),
        },
    ).catch((err) => {
        console.warn("finalizeNudgeAttempt failed:", err instanceof Error ? err.message : err);
    });
    void pushNudgeToLedger(nudgeId, outcome);
}

/** Saheli's ledger must know every reminder that went out or failed, or she cannot answer "was I reminded?". */
async function pushNudgeToLedger(nudgeId: string, outcome: { delivered: boolean; terminal?: boolean; reason?: string; messagePreview?: string; wamid?: string }) {
    if (!outcome.delivered && !outcome.terminal) return;
    const row = await SaheliNudgeLog.findOne({ nudgeId }).lean().catch(() => null);
    if (!row) return;
    // A reminder Saheli set (scheduleId "reminder:<id>:<HH:MM>") says its own words, not its id (founder 2026-10-11: the
    // calendar showed "pre reminder: reminder:1061061a…" for "Get ready for the gym").
    const custom = row.scheduleId?.startsWith("reminder:") ? row.scheduleId.split(":") : null;
    let what: string;
    let extra: Record<string, unknown> = {};
    if (custom) {
        const [, reminderId, ...rest] = custom;
        const slot = rest.join(":");
        const { default: SaheliReminder } = await import("../models/saheliReminder.model");
        const rem = await SaheliReminder.findOne({ reminderId }, { text: 1, aboutKey: 1 }).lean().catch(() => null);
        what = `${rem?.text ?? "a reminder"} at ${slot}`;
        // aboutKey: what it is linked to (a medicine gets no 5-minute follow-up question; an activity's gets its data asked)
        extra = { reminderId, slot, custom: true, ...(rem?.aboutKey ? { aboutKey: rem.aboutKey } : {}) };
    } else {
        const { default: CareSchedule } = await import("../models/careSchedule.model");
        const item = row.scheduleId ? await CareSchedule.findOne({ scheduleId: row.scheduleId }).lean().catch(() => null) : null;
        what = item ? `${item.title}${item.dosage ? ` ${item.dosage}` : ""} at ${item.time}` : row.scheduleId || row.nudgeKind;
    }
    const label = custom ? "reminder" : row.nudgeKind.replace(/_/g, " ");
    const { aiPushCareEvent } = await import("../clients/aiEngine.client");
    await aiPushCareEvent({
        family_id: row.familyId,
        subject_id: row.recipientUserId,
        kind: outcome.delivered ? "reminder_sent" : "reminder_failed",
        summary: `${label}: ${what}${outcome.delivered ? "" : ` (not delivered: ${outcome.reason || "unknown"})`}`,
        // the wamid: the engine can ask how far it got (delivered, read) and link its reply to it (trust plan B1.3)
        payload: { nudgeKind: row.nudgeKind, scheduleId: row.scheduleId, dateKey: row.dateKey, preview: outcome.messagePreview?.slice(0, 200),
                   ...(outcome.wamid ? { wamid: outcome.wamid } : {}), ...extra },
        ref: `nudge:${nudgeId}:${outcome.delivered ? "sent" : "failed"}`,
    });
}
