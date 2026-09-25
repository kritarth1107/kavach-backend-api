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

const ORDER_JOB_KINDS = new Set<ActivityKind>([
    "order_step",
    "order_confirm_card",
    "order_placed",
    "order_failed",
    "order_cancelled",
    "order_interrupt",
]);
const ORDER_TERMINAL_KINDS = new Set<ActivityKind>(["order_placed", "order_failed", "order_cancelled"]);
const ORDER_JOB_IDLE_MS = 45 * 60_000;
const activeOrderJobs = new Map<string, { orderId: string; lastAt: number }>();

function newOrderJobId(): string {
    return `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Stable `data.jobId` for every order event of one order run (dashboard groups by it).
 * One active job per recipient: reused until a terminal event (placed/failed/cancelled) or
 * 45 min idle. After a restart the latest non-terminal order row (≤45 min) is resumed.
 * `diag` rows get the active id when one exists (never start a job).
 */
const jobLocks = new Map<string, Promise<unknown>>();

/** Serialize job-id resolution per recipient (fire-and-forget logs can arrive together). */
export function resolveOrderJobId(recipientUserId: string, kind: ActivityKind, explicit?: unknown): Promise<string | undefined> {
    if (!ORDER_JOB_KINDS.has(kind) && kind !== "diag") return Promise.resolve(undefined);
    const prev = jobLocks.get(recipientUserId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => resolveOrderJobIdUnlocked(recipientUserId, kind, explicit));
    jobLocks.set(recipientUserId, next);
    void next.finally(() => {
        if (jobLocks.get(recipientUserId) === next) jobLocks.delete(recipientUserId);
    });
    return next;
}

async function resolveOrderJobIdUnlocked(
    recipientUserId: string,
    kind: ActivityKind,
    explicit?: unknown,
): Promise<string | undefined> {
    const now = Date.now();
    const isOrder = ORDER_JOB_KINDS.has(kind);
    if (!isOrder && kind !== "diag") return undefined;
    let active = activeOrderJobs.get(recipientUserId);
    if (active && now - active.lastAt > ORDER_JOB_IDLE_MS) {
        activeOrderJobs.delete(recipientUserId);
        active = undefined;
    }
    if (!active && typeof explicit !== "string") {
        try {
            const last = (await ActivityLog.findOne({
                recipientUserId,
                kind: { $in: [...ORDER_JOB_KINDS] },
                createdAt: { $gte: new Date(now - ORDER_JOB_IDLE_MS) },
            })
                .sort({ createdAt: -1 })
                .lean()) as { kind?: ActivityKind; data?: { jobId?: unknown } } | null;
            const id = last?.data?.jobId;
            if (last && typeof id === "string" && !ORDER_TERMINAL_KINDS.has(last.kind as ActivityKind)) {
                active = { orderId: id, lastAt: now };
            }
        } catch {
            /* ignore */
        }
    }
    let orderId = typeof explicit === "string" && explicit ? explicit : active?.orderId;
    if (!orderId) {
        if (!isOrder) return undefined;
        orderId = newOrderJobId();
    }
    if (ORDER_TERMINAL_KINDS.has(kind)) activeOrderJobs.delete(recipientUserId);
    else if (isOrder) activeOrderJobs.set(recipientUserId, { orderId, lastAt: now });
    return orderId;
}

/** Persist one activity row. Returns a promise that always resolves (caller may `void` it). */
export async function logActivity(input: LogActivityInput): Promise<void> {
    try {
        if (!input.familyId || !input.recipientUserId) return;
        const orderId = await resolveOrderJobId(input.recipientUserId, input.kind, input.data?.jobId).catch(() => undefined);
        if (orderId) input = { ...input, data: { ...(input.data || {}), jobId: orderId, orderId } };
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
