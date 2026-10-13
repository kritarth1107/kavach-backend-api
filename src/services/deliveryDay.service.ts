/**
 * The day's due reminder slots for the engine's daily score (trust plan C1 check 1, "the reminder was actually sent"):
 * host tool `delivery_day`. Read from the due list (due_slots: every dose and reminder due that day, with WhatsApp's own
 * sent/delivered/read receipts from the delivery ledger); a day before the due list existed falls back to the reminder
 * ledger (SaheliNudgeLog, where "delivered" only means Meta accepted the send, and nothing never attempted is listed).
 * Test numbers' sends and slots removed before their time are left out. Internal only (the engine, behind the shared
 * secret); first names only.
 */
import DueSlot, { type IDueSlot } from "../models/dueSlot.model";

export type DaySlot = {
    familyId: string;
    userId: string;
    person: string;
    kind: "dose_reminder" | "reminder";
    refId: string;
    item: string;
    dueAt: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    failedAt: string | null;
    held: boolean;
    heldReason: string | null;
    error: string | null;
    state: string;
};

const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

export function fromDueSlot(s: IDueSlot, person = ""): DaySlot {
    return {
        familyId: s.familyId, userId: s.recipientUserId, person, kind: s.kind === "dose" ? "dose_reminder" : "reminder", refId: s.slotKey,
        item: s.title || "", dueAt: iso(s.dueAt), sentAt: iso(s.sentAt), deliveredAt: iso(s.deliveredAt), readAt: iso(s.readAt),
        failedAt: s.state === "failed" ? iso(s.failedAt) || iso(s.dueAt) : iso(s.failedAt), held: s.state === "held",
        heldReason: s.state === "held" ? s.reason || "held" : null, error: s.state === "failed" ? s.reason || "failed" : null, state: s.state,
    };
}

async function firstNames(ids: string[]): Promise<Map<string, string>> {
    const { default: User } = await import("../models/users.model");
    const rows = await User.find({ _id: { $in: ids.filter((x) => /^[a-f0-9]{24}$/i.test(x)) } }, { name: 1 }).lean<Array<{ _id: unknown; name?: string }>>();
    return new Map(rows.map((u) => [String(u._id), String(u.name || "").trim().split(/\s+/)[0] || ""]));
}

export async function deliveryDay(dateKey: string): Promise<{ source: string; receipts: boolean; day: string; slots: DaySlot[] }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error("day must be YYYY-MM-DD");
    const due = await DueSlot.find({ dateKey, test: { $ne: true }, state: { $ne: "removed" } }).sort({ dueAt: 1 }).limit(5000).lean<IDueSlot[]>();
    if (due.length) {
        const names = await firstNames([...new Set(due.map((s) => s.recipientUserId))]);
        return { source: "due_slots", receipts: true, day: dateKey, slots: due.map((s) => fromDueSlot(s, names.get(s.recipientUserId) || "")) };
    }
    const { default: Log } = await import("../models/saheliNudgeLog.model");
    const rows = await Log.find({ dateKey, nudgeKind: "dose_due" }).limit(5000).lean<Array<Record<string, unknown>>>();
    const slots: DaySlot[] = rows.map((r) => {
        const scheduleId = String(r.scheduleId || "");
        const hhmm = /reminder:[^:]+:(\d{2}:\d{2})/.exec(scheduleId)?.[1];
        const due = hhmm ? new Date(`${dateKey}T${hhmm}:00+05:30`) : (r.createdAt as Date | undefined);
        const held = r.reason === "done" || r.reason === "paused" || String(r.reason || "").startsWith("gated:");
        return {
            familyId: String(r.familyId), userId: String(r.recipientUserId), person: "", kind: scheduleId.startsWith("reminder:") ? "reminder" : "dose_reminder",
            refId: String(r.nudgeId), item: String(r.messagePreview || "").slice(0, 80), dueAt: iso(due), sentAt: r.delivered ? iso(r.createdAt as Date) : null,
            deliveredAt: r.delivered ? iso(r.createdAt as Date) : null, readAt: null, failedAt: !r.delivered && r.terminal && !held ? iso(r.createdAt as Date) : null,
            held, heldReason: held ? String(r.reason) : null, error: !r.delivered && !held ? String(r.reason || "not delivered") : null, state: r.delivered ? "sent" : held ? "held" : "failed",
        };
    });
    return { source: "nudge_log", receipts: false, day: dateKey, slots };
}
