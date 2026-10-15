/**
 * The Kavach team hears about reminders (trust plan B1.5, B1.6; founder 2026-10-13: "send a daily report of what was due
 * versus sent; alert the Kavach team if any dose reminder didn't send"):
 *   - the dose alert, every tick: a dose not sent within 5 minutes of its time, a failed one, or one with no "delivered"
 *     receipt 30 minutes after it went. One email per tick for all of them, each slot once; held slots never alert.
 *   - the daily report at 23:30 IST: due, sent, delivered, read, held and failed by reason, missed, the on-time rate,
 *     per family and in total, and every dose that did not reach the phone; by email and on the admin "Delivery" page.
 * Families are named by short id and people by first name only.
 */
import DeliveryReport, { type DeliveryCounts, type IDeliveryReport } from "../models/deliveryReport.model";
import DueSlot, { type IDueSlot } from "../models/dueSlot.model";
import OpsAlertLog from "../models/opsAlertLog.model";
import { clockNow } from "../utils/clock.util";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";
import { DELIVERED_WITHIN_MS, DOSE_ALERT_AFTER_MS, ON_TIME_DOSE_MS, ON_TIME_REMINDER_MS } from "./dueList.service";

const short = (familyId: string) => familyId.slice(0, 8);

function istClock(d: Date | string | undefined): string {
    if (!d) return "-";
    return new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true });
}

/** First names of the people in these slots (the family's own name for them, first word). */
export async function firstNames(slots: Array<Pick<IDueSlot, "familyId" | "recipientUserId">>): Promise<Map<string, string>> {
    const { default: Family } = await import("../models/family.model");
    const { default: User } = await import("../models/users.model");
    const out = new Map<string, string>();
    const fams = new Map<string, { members?: Array<{ userId: string; name?: string }> } | null>();
    for (const s of slots) {
        const key = `${s.familyId}|${s.recipientUserId}`;
        if (out.has(key)) continue;
        if (!fams.has(s.familyId)) fams.set(s.familyId, await Family.findOne({ familyId: s.familyId }, { members: 1 }).lean<{ members?: Array<{ userId: string; name?: string }> }>().catch(() => null));
        const fromFamily = (fams.get(s.familyId)?.members ?? []).find((m) => m.userId === s.recipientUserId)?.name?.trim();
        const user = fromFamily ? null : await User.findOne({ userId: s.recipientUserId }, { firstName: 1 }).lean<{ firstName?: string }>().catch(() => null);
        out.set(key, (fromFamily || user?.firstName || "someone").trim().split(/\s+/)[0]!);
    }
    return out;
}

// ── the dose alert ────────────────────────────────────────────────────────────────────────────────────────────────

/** Pure: why this dose slot should alert now, or null. Held, delivered and read slots never alert. */
export function doseAlertReason(slot: Pick<IDueSlot, "state" | "dueAt" | "sentAt" | "deliveredAt" | "reason" | "medicine" | "test">, now: Date): string | null {
    if (!slot.medicine || slot.test) return null;
    const due = new Date(slot.dueAt).getTime();
    if ((slot.state === "scheduled" || slot.state === "missed") && now.getTime() - due > DOSE_ALERT_AFTER_MS) {
        return slot.state === "missed" && slot.reason && slot.reason !== "never attempted" ? `not sent: ${slot.reason}` : "not sent within 5 minutes of its time";
    }
    if (slot.state === "failed") return `failed: ${slot.reason || "unknown"}`;
    if (slot.state === "sent" && !slot.deliveredAt && now.getTime() - new Date(slot.sentAt ?? slot.dueAt).getTime() > DELIVERED_WITHIN_MS) {
        return "sent, but WhatsApp has not delivered it to the phone after 30 minutes";
    }
    return null;
}

/** Every tick: one email for every dose slot that needs the team now (each slot once), plus an admin alert row. */
export async function runDoseAlertCheck(now = clockNow()): Promise<{ alerted: number; emailed: boolean }> {
    const dateKeys = [toDateKeyIST(now), toDateKeyIST(new Date(now.getTime() - 86_400_000))];
    const candidates = await DueSlot.find({
        dateKey: { $in: dateKeys }, medicine: true, test: { $ne: true }, alertedAt: { $exists: false },
        state: { $in: ["scheduled", "missed", "failed", "sent"] }, dueAt: { $lte: now },
    }).lean<IDueSlot[]>();
    const due: Array<IDueSlot & { why: string }> = [];
    for (const s of candidates) {
        const why = doseAlertReason(s, now);
        if (!why) continue;
        // each slot alerts once, even with two instances or a retried tick
        const claim = await DueSlot.updateOne({ slotKey: s.slotKey, alertedAt: { $exists: false } }, { $set: { alertedAt: now, alertReason: why } });
        if (claim.modifiedCount === 1) due.push({ ...s, why });
    }
    if (!due.length) return { alerted: 0, emailed: false };
    const names = await firstNames(due);
    const items = due.map((s) => ({
        family: short(s.familyId), person: names.get(`${s.familyId}|${s.recipientUserId}`) || "someone", medicine: s.title, time: s.time,
        reason: s.why, attempts: s.attempts ?? 0, kind: s.kind,
    }));
    const subject = due.length === 1
        ? `Dose reminder problem: ${items[0]!.person}, ${items[0]!.medicine} at ${items[0]!.time}`
        : `${due.length} dose reminders did not reach the phone`;
    const text = [
        "A dose reminder did not go out or did not reach the phone (WhatsApp's own receipts).",
        "",
        ...items.map((i) => `• family ${i.family} · ${i.person} · ${i.medicine} at ${i.time} · ${i.reason} · ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}${i.kind === "reminder" ? " (a reminder Saheli set)" : ""}`),
        "",
        "Each dose is alerted once. The family's caregivers are not told by this email; check the admin console's Delivery page, and call the family if a critical medicine is involved.",
    ].join("\n");
    const { alertOps } = await import("./opsAlert.service");
    const out = await alertOps(`dose:${now.getTime()}`, subject, text, { everyMs: 0, now: now.getTime() });
    await OpsAlertLog.create({ kind: "dose", subject, text, items, emailed: out.sent, ...(out.error ? { error: out.error } : {}), at: now })
        .catch((err) => console.warn("[dose-alert] admin row failed:", err instanceof Error ? err.message : err));
    console.warn(`[dose-alert] ${due.length} slot(s) alerted to the team (emailed=${out.sent})`);
    return { alerted: due.length, emailed: out.sent };
}

// ── the daily report ──────────────────────────────────────────────────────────────────────────────────────────────

const emptyCounts = (): DeliveryCounts => ({ due: 0, sent: 0, delivered: 0, read: 0, held: {}, failed: {}, missed: 0, onTime: 0, attemptable: 0, later: 0 });

/** A reason as a short bucket for counting ("gate: active_flow:pharmacy" → "gate"). */
export function reasonBucket(reason?: string): string {
    const r = String(reason ?? "unknown").trim();
    if (/^WhatsApp\s+131047/.test(r)) return "chat closed (131047)";
    if (/^WhatsApp/.test(r)) return r.split(/\s+/).slice(0, 2).join(" ");
    return r.split(/[:(]/)[0]!.trim().slice(0, 40) || "unknown";
}

/** Pure: the counts for a set of slots, as of now. */
export function countSlots(slots: Array<Pick<IDueSlot, "state" | "reason" | "dueAt" | "sentAt" | "kind">>, now: Date): DeliveryCounts {
    const c = emptyCounts();
    for (const s of slots) {
        if (s.state === "removed") continue;
        if (new Date(s.dueAt).getTime() > now.getTime()) {
            c.later += 1;
            continue;
        }
        c.due += 1;
        const reached = s.state === "sent" || s.state === "delivered" || s.state === "read";
        if (reached) {
            c.sent += 1;
            if (s.state !== "sent") c.delivered += 1;
            if (s.state === "read") c.read += 1;
            const late = s.sentAt ? new Date(s.sentAt).getTime() - new Date(s.dueAt).getTime() : Infinity;
            if (late <= (s.kind === "dose" ? ON_TIME_DOSE_MS : ON_TIME_REMINDER_MS)) c.onTime += 1;
        } else if (s.state === "held") {
            const k = reasonBucket(s.reason);
            c.held[k] = (c.held[k] ?? 0) + 1;
        } else if (s.state === "failed") {
            const k = reasonBucket(s.reason);
            c.failed[k] = (c.failed[k] ?? 0) + 1;
        } else {
            c.missed += 1; // scheduled past its time, or missed
        }
        if (s.state !== "held") c.attemptable += 1;
    }
    return c;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

function countsLine(c: DeliveryCounts): string {
    const held = Object.entries(c.held).map(([k, v]) => `${k} ${v}`).join(", ");
    const failed = Object.entries(c.failed).map(([k, v]) => `${k} ${v}`).join(", ");
    return [
        `due ${c.due}, sent ${c.sent}, delivered ${c.delivered}, read ${c.read}, missed ${c.missed}`,
        `held ${Object.values(c.held).reduce((a, b) => a + b, 0)}${held ? ` (${held})` : ""}`,
        `failed ${Object.values(c.failed).reduce((a, b) => a + b, 0)}${failed ? ` (${failed})` : ""}`,
        `on time ${c.onTime}/${c.attemptable} (${pct(c.onTime, c.attemptable)})${c.later ? `, ${c.later} later tonight` : ""}`,
    ].join(" · ");
}

/** The day's report from the due list and the delivery ledger. */
export async function buildDeliveryReport(dateKey: string, now = clockNow(), opts: { readOnly?: boolean } = {}): Promise<IDeliveryReport> {
    if (!opts.readOnly) {
        // the admin page reads without writing; a slot still "scheduled" past its time counts as missed either way
        const { markMissed } = await import("./dueList.service");
        await markMissed(now).catch(() => 0);
    }
    const slots = await DueSlot.find({ dateKey, test: { $ne: true }, state: { $ne: "removed" } }).lean<IDueSlot[]>();
    const names = await firstNames(slots);
    const byFamily = new Map<string, IDueSlot[]>();
    for (const s of slots) byFamily.set(s.familyId, [...(byFamily.get(s.familyId) ?? []), s]);
    const families = [...byFamily.entries()].map(([familyId, rows]) => ({
        family: short(familyId),
        people: [...new Set(rows.map((r) => names.get(`${r.familyId}|${r.recipientUserId}`) || "someone"))],
        counts: countSlots(rows, now),
    }));
    // A slot sent before the ledger was watching it (the first build after a deploy) has no receipt to wait for: it is
    // counted as sent, but never listed as "not delivered" (13 Oct, the first night: 15 doses sent before tracking began).
    const beforeTracking = (s: IDueSlot) => s.state === "sent" && String(s.alertReason ?? "").startsWith("listed after its time");
    const notDelivered = slots
        .filter((s) => s.medicine && new Date(s.dueAt).getTime() <= now.getTime() && !["delivered", "read", "held"].includes(s.state) && !beforeTracking(s))
        .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime())
        .map((s) => ({ family: short(s.familyId), person: names.get(`${s.familyId}|${s.recipientUserId}`) || "someone", medicine: s.title, time: s.time,
                       state: s.state, ...(s.reason ? { reason: s.reason } : {}), ...(s.attempts ? { attempts: s.attempts } : {}) }));
    const { default: MessageDelivery } = await import("../models/messageDelivery.model");
    const start = new Date(`${dateKey}T00:00:00+05:30`);
    const end = new Date(start.getTime() + 86_400_000);
    const range = { createdAt: { $gte: start, $lt: end } };
    const [sends, withWamid, withReceipt, failed] = await Promise.all([
        MessageDelivery.countDocuments({ ...range, sentAt: { $exists: true } }),
        MessageDelivery.countDocuments({ ...range, sentAt: { $exists: true }, wamid: { $type: "string" } }),
        MessageDelivery.countDocuments({ ...range, wamid: { $type: "string" }, receiptAt: { $exists: true } }),
        MessageDelivery.countDocuments({ ...range, status: "failed" }),
    ]);
    const untracked = slots.filter(beforeTracking).length;
    return { dateKey, builtAt: now, totals: countSlots(slots, now), families, notDelivered, ledger: { sends, withWamid, withReceipt, failed }, ...(untracked ? { untracked } : {}) };
}

export function reportText(r: IDeliveryReport): { subject: string; text: string } {
    const t = r.totals;
    const subject = `Kavach reminders ${r.dateKey}: ${t.sent}/${t.due} sent, ${t.delivered} delivered, ${t.read} read` +
        (r.notDelivered.length ? `, ${r.notDelivered.length} dose${r.notDelivered.length === 1 ? "" : "s"} not delivered` : "");
    const lines = [
        `Reminders due versus sent on ${r.dateKey} (IST, up to ${istClock(r.builtAt)}).`,
        "",
        `All families: ${countsLine(t)}`,
        "",
        ...r.families.map((f) => `Family ${f.family} (${f.people.join(", ")}): ${countsLine(f.counts)}`),
        "",
        r.notDelivered.length ? "Doses that did not reach the phone:" : "Every dose that was due reached the phone (or was held on purpose).",
        ...r.notDelivered.map((d) => `• family ${d.family} · ${d.person} · ${d.medicine} at ${d.time} · ${d.state}${d.reason ? ` (${d.reason})` : ""}${d.attempts ? ` · ${d.attempts} attempt${d.attempts === 1 ? "" : "s"}` : ""}`),
        "",
        r.untracked ? `${r.untracked} slot(s) were sent before tracking began today (no WhatsApp receipt was kept for them).` : "",
        r.ledger ? `WhatsApp sends today: ${r.ledger.sends}, with a wamid ${r.ledger.withWamid} (${pct(r.ledger.withWamid, r.ledger.sends)}), with a receipt ${r.ledger.withReceipt} (${pct(r.ledger.withReceipt, r.ledger.withWamid)}), failed ${r.ledger.failed}.` : "",
        "On time = sent within 2 minutes of the time for doses, within 15 minutes for other reminders. Held = not sent on purpose (already marked taken, quiet hours, paused, an order in progress, skipped).",
        "Full report: admin console, Delivery.",
    ];
    return { subject, text: lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") };
}

export const REPORT_AT_MIN = 23 * 60 + 30;

/** Every tick: at 23:30 IST, once a day, the report is saved and emailed to the Kavach team. */
export async function runDailyDeliveryReport(now = clockNow()): Promise<IDeliveryReport | null> {
    if (getISTParts(now).minutesSinceMidnight < REPORT_AT_MIN) return null;
    const dateKey = toDateKeyIST(now);
    if (await DeliveryReport.exists({ dateKey })) return null;
    const report = await buildDeliveryReport(dateKey, now);
    try {
        await DeliveryReport.create(report); // unique per day: a second instance stops here
    } catch {
        return null;
    }
    const { subject, text } = reportText(report);
    let body = text;
    try {
        const { slo } = await import("../admin/infra/aws");
        const line = (await slo(now.getTime()))?.digest;
        if (line) body = `${text}\n${line}`;
    } catch { /* the reminder report still goes out when CloudWatch does not answer */ }
    const { alertOps } = await import("./opsAlert.service");
    const out = await alertOps(`report:${dateKey}`, subject, body, { everyMs: 0, now: now.getTime() });
    await DeliveryReport.updateOne({ dateKey }, { $set: out.sent ? { emailedAt: now } : { emailError: out.error || "not sent" } });
    console.log(`[delivery-report] ${dateKey}: due ${report.totals.due}, sent ${report.totals.sent}, delivered ${report.totals.delivered} (emailed=${out.sent})`);
    return { ...report, ...(out.sent ? { emailedAt: now } : {}) };
}
