import { randomUUID } from "crypto";
import SaheliNudgeLog, { type SaheliNudgeKind } from "../models/saheliNudgeLog.model";

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
export function decideNudgeSlot(rows: SlotRow[], now = new Date()): NudgeSlotDecision {
    if (!rows.length) return { allowed: true };
    if (rows.some((r) => r.delivered)) return { allowed: false, reason: "delivered" };
    if (rows.some((r) => r.terminal)) return { allowed: false, reason: "terminal" };
    const attempts = rows.reduce((sum, r) => sum + Math.max(1, r.attempts ?? 0), 0);
    if (attempts >= NUDGE_MAX_ATTEMPTS) return { allowed: false, reason: "max_attempts" };
    const last = Math.max(
        ...rows.map((r) => new Date(r.lastAttemptAt ?? r.createdAt ?? 0).getTime()),
    );
    if (now.getTime() - last < NUDGE_RETRY_COOLDOWN_MS) return { allowed: false, reason: "cooldown" };
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
    now = new Date(),
): Promise<string | null> {
    const rows = (await SaheliNudgeLog.find(slotFilter(key)).lean()) as unknown as SlotRow[];
    const decision = decideNudgeSlot(rows, now);
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
    const cutoff = new Date(now.getTime() - NUDGE_RETRY_COOLDOWN_MS);
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

export async function finalizeNudgeAttempt(
    nudgeId: string,
    outcome: {
        delivered: boolean;
        channel: string;
        messagePreview?: string;
        terminal?: boolean;
        reason?: string;
    },
): Promise<void> {
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
            },
        },
    ).catch((err) => {
        console.warn("finalizeNudgeAttempt failed:", err instanceof Error ? err.message : err);
    });
}
