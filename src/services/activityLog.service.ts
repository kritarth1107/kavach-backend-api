/**
 * Persisted activity log for the caregiver dashboard (timeline + daily snapshot).
 * Fire-and-forget: never throws, never blocks WhatsApp replies.
 */
import ActivityLog, { type ActivityKind } from "../models/activityLog.model";

export function istDayKey(d: Date = new Date()): string {
    // en-CA gives YYYY-MM-DD
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(d);
}

/** Strip anything that looks like an OTP / long digit run / phone before persisting. */
export function redactActivityText(text: string | undefined, max = 1500): string | undefined {
    if (!text) return text;
    return text
        .replace(/\b(otp|code)\b([^\d]{0,12})\d{4,8}\b/gi, "$1$2••••")
        .replace(/(\+?\d[\d\s-]{8,}\d)/g, (m) => {
            const digits = m.replace(/\D/g, "");
            return digits.length >= 10 ? `••••${digits.slice(-2)}` : m;
        })
        .slice(0, max);
}

export type LogActivityInput = {
    familyId?: string | null;
    recipientUserId?: string | null;
    actorUserId?: string | null;
    kind: ActivityKind;
    title: string;
    detail?: string;
    data?: Record<string, unknown>;
    severity?: "info" | "warn" | "error";
};

/** Persist one activity row. Returns a promise that always resolves (caller may `void` it). */
export async function logActivity(input: LogActivityInput): Promise<void> {
    try {
        if (!input.familyId || !input.recipientUserId) return;
        const now = new Date();
        await ActivityLog.create({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId || undefined,
            kind: input.kind,
            title: redactActivityText(input.title, 200) || input.kind,
            detail: redactActivityText(input.detail, 4000),
            data: input.data,
            severity: input.severity ?? "info",
            dayKey: istDayKey(now),
        });
    } catch (err) {
        console.warn("activity log write failed:", err instanceof Error ? err.message : err);
    }
}

export async function listActivity(input: {
    recipientUserId: string;
    dayKey?: string;
    before?: Date;
    kinds?: ActivityKind[];
    limit?: number;
}) {
    const q: Record<string, unknown> = { recipientUserId: input.recipientUserId };
    if (input.dayKey) q.dayKey = input.dayKey;
    if (input.before) q.createdAt = { $lt: input.before };
    if (input.kinds?.length) q.kind = { $in: input.kinds };
    const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
    return ActivityLog.find(q).sort({ createdAt: -1 }).limit(limit).lean();
}

/** Latest order_step for status replies ("what's happening with my order?"). */
export async function latestOrderStep(recipientUserId: string, sinceMs = 30 * 60_000) {
    try {
        return await ActivityLog.findOne({
            recipientUserId,
            kind: { $in: ["order_step", "order_confirm_card", "order_placed", "order_failed"] },
            createdAt: { $gte: new Date(Date.now() - sinceMs) },
        })
            .sort({ createdAt: -1 })
            .lean();
    } catch {
        return null;
    }
}
