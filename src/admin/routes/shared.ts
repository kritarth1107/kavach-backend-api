/** Helpers for admin routes: masked people, safe activity labels, paging. */
import { maskEmail, maskName, maskPhone } from "../mask";
import User from "../../models/users.model";

export const PAGE = 25;
export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const pageOf = (q: Record<string, string>) => Math.max(1, Math.min(Number(q.page) || 1, 1000));
export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
export const iso = (d?: Date | string | null) => (d ? new Date(d).toISOString() : null);

export type UserDoc = {
    userId: string; firstName?: string; lastName?: string; email?: string; phone?: { countryCode?: string; number?: string };
    status?: string; createdAt?: Date; updatedAt?: Date; primaryAuthProvider?: string; emailVerified?: boolean;
};

export const fullName = (u?: UserDoc | null) => (u ? [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null : null);
export const phoneOf = (u?: UserDoc | null) => {
    const n = u?.phone?.number;
    if (!n) return null;
    const cc = String(u?.phone?.countryCode || "").replace(/\D/g, "");
    return `+${cc}${String(n).replace(/\D/g, "")}`;
};

export function maskedUser(u?: UserDoc | null) {
    if (!u) return null;
    return {
        userId: u.userId, name: maskName(fullName(u)), email: maskEmail(u.email), phone: maskPhone(phoneOf(u)), status: u.status || "ACTIVE",
        createdAt: iso(u.createdAt), provider: u.primaryAuthProvider || null,
    };
}

export async function usersById(ids: string[]): Promise<Map<string, UserDoc>> {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return new Map();
    const rows = await User.find({ userId: { $in: uniq } }, { userId: 1, firstName: 1, lastName: 1, email: 1, phone: 1, status: 1, createdAt: 1, primaryAuthProvider: 1 }).lean<UserDoc[]>();
    return new Map(rows.map((u) => [u.userId, u]));
}

/** Activity titles can carry health details and medicine names; the masked view shows only what kind of thing happened. */
const KIND_LABEL: Record<string, string> = {
    message_in: "Message from family", message_out: "Saheli replied", voice_note: "Voice note", order_step: "Order step",
    order_confirm_card: "Order waiting for OK", order_placed: "Order placed", order_failed: "Order failed", order_cancelled: "Order cancelled",
    order_interrupt: "Order interrupted", ride: "Ride", reminder: "Reminder", mood: "Mood noted", health: "Health note",
    caregiver_alert: "Caregiver alert", nudge: "Nudge", followup: "Follow-up", diag: "Diagnostic",
};
export const kindLabel = (k: string) => KIND_LABEL[k] || k;

export type ActivityDoc = {
    _id?: unknown; familyId: string; recipientUserId: string; actorUserId?: string; kind: string; title: string; detail?: string;
    severity?: string; data?: Record<string, unknown>; createdAt?: Date;
};

export function safeActivity(a: ActivityDoc) {
    const alertKind = a.kind === "caregiver_alert" && typeof a.data?.kind === "string" ? (a.data.kind as string) : null;
    return {
        at: iso(a.createdAt), kind: a.kind, label: kindLabel(a.kind), severity: a.severity || "info", familyId: a.familyId,
        recipientUserId: a.recipientUserId, alertKind, whatsapp: a.kind === "caregiver_alert" ? a.data?.whatsapp === true : undefined,
        delivered: a.kind === "reminder" ? !/not delivered|not sent/i.test(a.title) : undefined,
    };
}

export function fullActivity(a: ActivityDoc) {
    return { ...safeActivity(a), title: a.title, detail: a.detail ?? null };
}
