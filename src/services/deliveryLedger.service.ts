/**
 * The delivery ledger (trust plan B1.1–B1.3): every WhatsApp message we send gets a row with its wamid, and WhatsApp's own
 * status receipts (sent, delivered, read, failed) update it. Receipts are authentic: the webhook refuses anything Meta did
 * not sign (metaSignature.service, enforced in production since 2026-10-13).
 *
 * Who a message is for and what it is about travels with the send as a context (withDelivery): the reminder slot, the
 * nudge, the reader, the kind. The Meta client writes the row from that context when Meta accepts the message, so no send
 * can skip the ledger, whichever code path sent it. A send with no context is recorded as kind "message".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import MessageDelivery, { DELIVERY_KINDS, type DeliveryKind, type DeliveryStatus, type IMessageDelivery } from "../models/messageDelivery.model";

export type DeliveryCtx = {
    kind: DeliveryKind;
    refId?: string;
    nudgeId?: string;
    familyId?: string;
    toUserId?: string;
    aboutUserId?: string;
    dueAt?: Date;
    attempt?: number;
    critical?: boolean;
    /** Saheli answering a message from this number (digits): the chat is open by definition. */
    replyTo?: string;
    /** Internal: how many WhatsApp messages this send has made so far (a long text or text + buttons is several). */
    _parts?: number;
};

const als = new AsyncLocalStorage<DeliveryCtx>();

/** Run fn with this send context; every WhatsApp message it sends is recorded under it. */
export function withDelivery<T>(ctx: DeliveryCtx, fn: () => Promise<T>): Promise<T> {
    return als.run(ctx, fn);
}

export function currentDelivery(): DeliveryCtx | undefined {
    return als.getStore();
}

export function isDeliveryKind(k: unknown): k is DeliveryKind {
    return typeof k === "string" && (DELIVERY_KINDS as readonly string[]).includes(k);
}

const digits = (phone: string) => String(phone ?? "").replace(/\D/g, "");

// ── writing rows ──────────────────────────────────────────────────────────────────────────────────────────────────

type Receipt = { wamid: string; status: string; at: Date; errorCode?: number; errorTitle?: string; recipient?: string };

/** Receipts that arrived before their row was written (Meta can be faster than our insert); applied when it appears. */
const early = new Map<string, { at: number; receipts: Receipt[] }>();
const EARLY_KEEP_MS = 2 * 60_000;

function pruneEarly(now = Date.now()) {
    for (const [k, v] of early) if (now - v.at > EARLY_KEEP_MS) early.delete(k);
    while (early.size > 2000) early.delete(early.keys().next().value as string);
}

/** Meta accepted a message: one ledger row, from the send's context. Never throws (a ledger problem never stops a send). */
export async function recordSent(input: { wamid?: string; phone: string; template?: string; part?: number; at?: Date }): Promise<void> {
    const ctx = currentDelivery();
    const at = input.at ?? new Date();
    const part = input.part ?? (ctx ? (ctx._parts = (ctx._parts ?? 0) + 1) - 1 : 0);
    try {
        const row: Partial<IMessageDelivery> = {
            ...(input.wamid ? { wamid: input.wamid } : {}),
            phone: digits(input.phone),
            // an answer goes to the number that wrote; anything else sent meanwhile (a relay to someone else) is a message
            kind: ctx?.kind === "reply" && ctx.replyTo && ctx.replyTo !== digits(input.phone) ? "message" : ctx?.kind ?? "message",
            status: "sent",
            sentAt: at,
            ...(input.template ? { viaTemplate: true, template: input.template } : {}),
            ...(part ? { part } : {}),
            ...ctxFields(ctx),
        };
        await MessageDelivery.create(row);
        if (input.wamid && early.has(input.wamid)) {
            const pending = early.get(input.wamid)!.receipts;
            early.delete(input.wamid);
            for (const r of pending) await applyReceipt(r);
        }
    } catch (err) {
        console.warn("[ledger] could not record a send:", err instanceof Error ? err.message : err);
    }
}

/** A message that never reached Meta (closed chat and no template, a failed call): a failed row, never "delivered". */
export async function recordNotSent(input: { phone: string; reason: string; errorCode?: number; template?: string; ctx?: DeliveryCtx; at?: Date }): Promise<void> {
    const ctx = input.ctx ?? currentDelivery();
    const at = input.at ?? new Date();
    try {
        await MessageDelivery.create({
            phone: digits(input.phone),
            kind: ctx?.kind ?? "message",
            status: "failed",
            failedAt: at,
            errorTitle: input.reason.slice(0, 200),
            ...(input.errorCode ? { errorCode: input.errorCode } : {}),
            ...(input.template ? { viaTemplate: true, template: input.template } : {}),
            ...ctxFields(ctx),
        });
    } catch (err) {
        console.warn("[ledger] could not record a failed send:", err instanceof Error ? err.message : err);
    }
}

function ctxFields(ctx: DeliveryCtx | undefined): Partial<IMessageDelivery> {
    if (!ctx) return {};
    const out: Partial<IMessageDelivery> = {};
    if (ctx.familyId) out.familyId = ctx.familyId;
    if (ctx.toUserId) out.toUserId = ctx.toUserId;
    if (ctx.aboutUserId) out.aboutUserId = ctx.aboutUserId;
    if (ctx.refId) out.refId = ctx.refId;
    if (ctx.nudgeId) out.nudgeId = ctx.nudgeId;
    if (ctx.dueAt) out.dueAt = ctx.dueAt;
    if (ctx.attempt) out.attempt = ctx.attempt;
    if (ctx.critical) out.critical = true;
    return out;
}

// ── receipts ──────────────────────────────────────────────────────────────────────────────────────────────────────

type ReceiptState = Pick<IMessageDelivery, "status" | "deliveredAt" | "readAt" | "failedAt" | "errorCode" | "errorTitle">;

const earlier = (a: Date | undefined, b: Date) => (a && new Date(a).getTime() <= b.getTime() ? new Date(a) : b);

/**
 * Pure: the row after one receipt. Receipts can come in any order (a read before its delivered): read implies delivered,
 * timestamps keep the earliest, and the status is the furthest the message got. A failure after delivery stays delivered
 * (the phone had it).
 */
export function mergeReceipt(row: ReceiptState, r: Pick<Receipt, "status" | "at" | "errorCode" | "errorTitle">): ReceiptState {
    const next: ReceiptState = {
        status: row.status,
        ...(row.deliveredAt ? { deliveredAt: new Date(row.deliveredAt) } : {}),
        ...(row.readAt ? { readAt: new Date(row.readAt) } : {}),
        ...(row.failedAt ? { failedAt: new Date(row.failedAt) } : {}),
        ...(row.errorCode != null ? { errorCode: row.errorCode } : {}),
        ...(row.errorTitle ? { errorTitle: row.errorTitle } : {}),
    };
    if (r.status === "delivered") next.deliveredAt = earlier(next.deliveredAt, r.at);
    else if (r.status === "read") {
        next.readAt = earlier(next.readAt, r.at);
        next.deliveredAt = earlier(next.deliveredAt, r.at);
    } else if (r.status === "failed") {
        next.failedAt = earlier(next.failedAt, r.at);
        if (r.errorCode != null) next.errorCode = r.errorCode;
        if (r.errorTitle) next.errorTitle = r.errorTitle.slice(0, 200);
    }
    next.status = next.readAt ? "read" : next.deliveredAt ? "delivered" : next.failedAt ? "failed" : "sent";
    return next;
}

/** The status entries of a Meta webhook body. */
export function parseStatuses(body: unknown): Receipt[] {
    const out: Receipt[] = [];
    const entries = (body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: unknown[] } }> }> } | null)?.entry ?? [];
    for (const entry of entries) {
        for (const change of entry.changes ?? []) {
            for (const raw of change.value?.statuses ?? []) {
                const s = raw as { id?: string; status?: string; timestamp?: string | number; recipient_id?: string;
                    errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }> };
                if (!s?.id || !s.status) continue;
                const ts = Number(s.timestamp);
                const err = s.errors?.[0];
                out.push({
                    wamid: String(s.id),
                    status: String(s.status),
                    at: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date(),
                    ...(err?.code != null ? { errorCode: Number(err.code) } : {}),
                    ...(err ? { errorTitle: String(err.title || err.message || err.error_data?.details || "failed") } : {}),
                    ...(s.recipient_id ? { recipient: String(s.recipient_id) } : {}),
                });
            }
        }
    }
    return out;
}

export type ReceiptListener = (row: IMessageDelivery, before: DeliveryStatus) => Promise<void> | void;
const listeners: ReceiptListener[] = [];

/** Something to do when a receipt changes a row (the reminder ledger, the due list, the dose alert). */
export function onReceipt(fn: ReceiptListener): void {
    listeners.push(fn);
}

async function applyReceipt(r: Receipt): Promise<"updated" | "same" | "unknown"> {
    const row = await MessageDelivery.findOne({ wamid: r.wamid }).lean<IMessageDelivery>();
    if (!row) {
        pruneEarly();
        const e = early.get(r.wamid) ?? { at: Date.now(), receipts: [] };
        e.receipts.push(r);
        early.set(r.wamid, e);
        return "unknown";
    }
    const next: ReceiptState & { receiptAt?: Date } = mergeReceipt(row, r);
    const changed = !row.receiptAt || (["status", "deliveredAt", "readAt", "failedAt", "errorCode", "errorTitle"] as const).some(
        (k) => String(next[k] instanceof Date ? (next[k] as Date).getTime() : next[k] ?? "") !==
               String(row[k] instanceof Date ? (row[k] as Date).getTime() : row[k] ?? ""),
    );
    if (!changed) return "same";
    if (!row.receiptAt) next.receiptAt = r.at;
    await MessageDelivery.updateOne({ wamid: r.wamid }, { $set: next });
    const after = { ...row, ...next } as IMessageDelivery;
    if (after.nudgeId && !after.part) {
        // the reminder ledger shows WhatsApp's own word: delivered = on the phone (B1.3)
        const { default: SaheliNudgeLog } = await import("../models/saheliNudgeLog.model");
        await SaheliNudgeLog.updateOne({ nudgeId: after.nudgeId, $or: [{ wamid: after.wamid }, { wamid: { $exists: false } }] }, {
            $set: {
                wamid: after.wamid, deliveryStatus: after.status,
                ...(after.deliveredAt ? { deliveredAt: after.deliveredAt } : {}),
                ...(after.readAt ? { readAt: after.readAt } : {}),
                ...(after.failedAt ? { failedAt: after.failedAt } : {}),
                ...(after.errorCode != null ? { errorCode: after.errorCode } : {}),
                // WhatsApp could not deliver a dose or reminder: the slot may be tried again inside its window (B1.7),
                // as the template now if the chat turned out to be closed (131047)
                ...(after.status === "failed" && (after.kind === "dose_reminder" || after.kind === "reminder") ? { delivered: false } : {}),
            },
        }).catch((err) => console.warn("[ledger] reminder ledger update failed:", err instanceof Error ? err.message : err));
    }
    if (row.status !== after.status) {
        // the due list (B1.4): a dose or reminder slot moves to delivered / read / failed; a failed one alerts (B1.5)
        const { onDeliveryReceipt } = await import("./dueList.service");
        await onDeliveryReceipt(after).catch((err) => console.warn("[ledger] due list update failed:", err instanceof Error ? err.message : err));
        if (after.status === "failed" && after.viaTemplate && after.kind === "alert") await alertFailedTemplate(after);
    }
    for (const fn of listeners) {
        try {
            await fn(after, row.status);
        } catch (err) {
            console.warn("[ledger] receipt listener failed:", err instanceof Error ? err.message : err);
        }
    }
    return "updated";
}

/** A caregiver alert's template that WhatsApp could not deliver: the team hears (B3.5). */
async function alertFailedTemplate(row: IMessageDelivery): Promise<void> {
    const { alertOps } = await import("./opsAlert.service");
    const text = `WhatsApp could not deliver the ${row.template ?? "alert"} template (an alert to a caregiver) for family ${String(row.familyId ?? "-").slice(0, 8)}: ` +
        `${row.errorCode ?? ""} ${row.errorTitle ?? ""}`.trim() + ". The alert itself waits for their next message. Check the template's status at Meta.";
    const out = await alertOps(`template-failed:${row.template ?? "alert"}`, "A caregiver alert template was not delivered", text, { everyMs: 30 * 60_000 });
    const { default: OpsAlertLog } = await import("../models/opsAlertLog.model");
    await OpsAlertLog.create({ kind: "template", subject: "A caregiver alert template was not delivered", text,
        items: [{ family: String(row.familyId ?? "-").slice(0, 8), template: row.template, error: `${row.errorCode ?? ""} ${row.errorTitle ?? ""}`.trim() }],
        emailed: out.sent, at: new Date() }).catch(() => undefined);
}

/**
 * Status webhooks: each receipt updates its row by wamid. A free message Meta refused because the chat was closed
 * (131047) also closes the window, so the next send uses a template. A receipt for a wamid we never sent is ignored.
 */
export async function applyStatuses(body: unknown): Promise<{ updated: number; unknown: number; closed: number }> {
    let updated = 0;
    let unknown = 0;
    let closed = 0;
    for (const r of parseStatuses(body)) {
        if (r.status === "failed" && r.errorCode === 131047 && r.recipient) {
            const { noteClosed } = await import("./whatsappWindow.service");
            await noteClosed(r.recipient).catch(() => undefined);
            closed += 1;
        }
        try {
            const out = await applyReceipt(r);
            if (out === "updated") updated += 1;
            else if (out === "unknown") unknown += 1;
        } catch (err) {
            console.warn("[ledger] receipt failed:", err instanceof Error ? err.message : err);
        }
    }
    return { updated, unknown, closed };
}

/** Tests only. */
export function resetEarlyReceipts(): void {
    early.clear();
}

// ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────

const RANK: Record<DeliveryStatus, number> = { failed: 0, sent: 1, delivered: 2, read: 3 };

/** The furthest any of these messages got. */
export function bestStatus(rows: Array<Pick<IMessageDelivery, "status">>): DeliveryStatus | null {
    if (!rows.length) return null;
    return rows.reduce<DeliveryStatus>((best, r) => (RANK[r.status] > RANK[best] ? r.status : best), rows[0]!.status);
}

/** Delivery of these wamids, for the engine (it keeps the wamid send_whatsapp returned) and the dashboard. */
export async function deliveryOf(wamids: string[]): Promise<Array<{ wamid: string; status: DeliveryStatus; sentAt?: string; deliveredAt?: string; readAt?: string; failedAt?: string; error?: string }>> {
    const ids = [...new Set(wamids.filter((w) => typeof w === "string" && w))].slice(0, 50);
    if (!ids.length) return [];
    const rows = await MessageDelivery.find({ wamid: { $in: ids } }).lean<IMessageDelivery[]>();
    const iso = (d?: Date) => (d ? new Date(d).toISOString() : undefined);
    return rows.map((r) => ({
        wamid: r.wamid!, status: r.status, sentAt: iso(r.sentAt), deliveredAt: iso(r.deliveredAt), readAt: iso(r.readAt), failedAt: iso(r.failedAt),
        ...(r.errorTitle ? { error: `${r.errorCode ?? ""} ${r.errorTitle}`.trim() } : {}),
    }));
}
