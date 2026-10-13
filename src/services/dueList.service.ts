/**
 * The due list (trust plan B1.4): every dose and reminder time due today, one slot each, and what became of it
 * (scheduled → sent → delivered → read, or held / failed / missed). Built at midnight IST and rebuilt within a minute
 * when a care schedule or a reminder changes (a fingerprint of both is checked every tick, so every write path counts:
 * the dashboard, Saheli's tools, the engine's sync).
 *
 * The senders note what happened to their slot (noteDue*); WhatsApp's receipts move a sent slot on (onDeliveryReceipt).
 */
import DueSlot, { type DueSlotState, type IDueSlot } from "../models/dueSlot.model";
import { clockNow } from "../utils/clock.util";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";

/** A dose not sent this long after its time is alerted (B1.5); its retries (+1, +3 min) are inside it. */
export const DOSE_ALERT_AFTER_MS = 5 * 60_000;
/** A sent dose with no "delivered" receipt this long after it went is alerted. */
export const DELIVERED_WITHIN_MS = 30 * 60_000;
/** A reminder (not a dose) may wait up to 10 minutes while they are chatting, within its 15-minute window. */
export const REMINDER_MISSED_AFTER_MS = 20 * 60_000;
/** On time: doses within 2 minutes of their time, other reminders within 15 (B1.6). */
export const ON_TIME_DOSE_MS = 2 * 60_000;
export const ON_TIME_REMINDER_MS = 15 * 60_000;

export function doseSlotKey(scheduleId: string, dateKey: string): string {
    return `dose:${scheduleId}:${dateKey}`;
}

export function reminderSlotKey(reminderId: string, hhmm: string, dateKey: string): string {
    return `reminder:${reminderId}:${hhmm}:${dateKey}`;
}

function slotDate(dateKey: string, hhmm: string): Date | null {
    const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const d = new Date(`${dateKey}T${m[1]!.padStart(2, "0")}:${m[2]}:00+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
}

function istMinutesOn(dateKey: string, at: Date | string | undefined | null): number | null {
    if (!at) return null;
    const d = new Date(at);
    return toDateKeyIST(d) === dateKey ? getISTParts(d).minutesSinceMidnight : null;
}

// ── building ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Built = Omit<IDueSlot, "state" | "createdAt" | "updatedAt"> & { state?: DueSlotState; reason?: string };

/** The slots due on dateKey (pure inputs: the people reminded, their medicine schedules and the reminders Saheli set). */
export function planDueSlots(input: {
    dateKey: string;
    dayOfWeek: number;
    schedules: Array<{ scheduleId: string; familyId: string; recipientUserId: string; title: string; time: string; dosage?: string | null;
        daysOfWeek?: number[]; critical?: boolean; createdAt?: Date | string | null }>;
    reminders: Array<{ reminderId: string; familyId: string; recipientUserId: string; text: string; aboutKey?: string | null;
        createdAt?: Date | string | null; slots: string[]; skipped: (t: string) => boolean }>;
}): Built[] {
    const out: Built[] = [];
    for (const s of input.schedules) {
        if ((s.daysOfWeek ?? []).length && !s.daysOfWeek!.includes(input.dayOfWeek)) continue;
        const dueAt = slotDate(input.dateKey, s.time);
        if (!dueAt) continue;
        const created = istMinutesOn(input.dateKey, s.createdAt);
        const at = getISTParts(dueAt).minutesSinceMidnight;
        if (created != null && created >= at) continue; // added after its time today: never due today
        out.push({
            slotKey: doseSlotKey(s.scheduleId, input.dateKey), dateKey: input.dateKey, familyId: s.familyId, recipientUserId: s.recipientUserId,
            kind: "dose", refId: s.scheduleId, title: `${s.title}${s.dosage ? ` ${s.dosage}` : ""}`.slice(0, 120), time: s.time.slice(0, 5), dueAt,
            medicine: true, ...(s.critical ? { critical: true } : {}),
        });
    }
    for (const r of input.reminders) {
        for (const t of r.slots) {
            const dueAt = slotDate(input.dateKey, t);
            if (!dueAt) continue;
            if (r.createdAt && new Date(r.createdAt).getTime() > dueAt.getTime()) continue;
            out.push({
                slotKey: reminderSlotKey(r.reminderId, t, input.dateKey), dateKey: input.dateKey, familyId: r.familyId, recipientUserId: r.recipientUserId,
                kind: "reminder", refId: r.reminderId, title: r.text.slice(0, 120), time: t, dueAt,
                medicine: String(r.aboutKey ?? "").startsWith("medicine:"),
                ...(r.skipped(t) ? { state: "held" as const, reason: "skipped" } : {}),
            });
        }
    }
    return out;
}

/** Who gets reminders: the people Saheli keeps company (enabled) and caregivers keeping their own schedule. */
async function remindedPeople(): Promise<Set<string>> {
    const { listEnabledCompanions } = await import("./saheliCompanion.service");
    const { listSelfCareTargets } = await import("./saheliCareNudge.service");
    const out = new Set<string>();
    for (const c of await listEnabledCompanions()) out.add(`${c.familyId}|${c.recipientUserId}`);
    for (const t of await listSelfCareTargets().catch(() => [])) out.add(`${t.familyId}|${t.recipientUserId}`);
    return out;
}

/** Build (or refresh) the day's slots. Idempotent: a slot already sent keeps its state; one no longer due is "removed". */
export async function buildDueList(dateKey: string, now = clockNow()): Promise<{ slots: number; removed: number }> {
    const { default: CareSchedule } = await import("../models/careSchedule.model");
    const { default: SaheliReminder } = await import("../models/saheliReminder.model");
    const { slotsOn, isSkipped, weekdayOf } = await import("./reminderSchedule.service");
    const people = await remindedPeople();
    const schedules = (await CareSchedule.find({ active: true, type: "MEDICINE" }).lean<Array<{ scheduleId: string; familyId: string;
        recipientUserId: string; title: string; time: string; dosage?: string; daysOfWeek?: number[]; critical?: boolean; createdAt?: Date }>>())
        .filter((s) => people.has(`${s.familyId}|${s.recipientUserId}`));
    const reminders = (await SaheliReminder.find({ status: "active" }).limit(5000).lean()) as unknown as Array<Parameters<typeof slotsOn>[0] & {
        reminderId: string; familyId: string; recipientUserId: string; text: string; aboutKey?: string | null; createdAt?: Date }>;
    const planned = planDueSlots({
        dateKey, dayOfWeek: weekdayOf(dateKey), schedules,
        reminders: reminders.map((r) => ({ ...r, slots: slotsOn(r, dateKey), skipped: (t: string) => isSkipped(r, dateKey, t) })),
    });
    for (const p of planned) {
        const { state, reason, ...fields } = p;
        const res = await DueSlot.updateOne(
            { slotKey: p.slotKey },
            {
                $set: { title: fields.title, time: fields.time, dueAt: fields.dueAt, medicine: fields.medicine, ...(fields.critical ? { critical: true } : {}) },
                $setOnInsert: { slotKey: p.slotKey, dateKey, familyId: p.familyId, recipientUserId: p.recipientUserId, kind: p.kind, refId: p.refId,
                                state: state ?? "scheduled", ...(reason ? { reason } : {}), createdAt: now },
            },
            { upsert: true },
        );
        // A slot first listed after its time had passed (the first build after a deploy, or after Kavach was down at
        // midnight): what happened is read from the reminder ledger, and it never alerts (nobody was watching it then).
        if (res.upsertedCount && fields.dueAt.getTime() < now.getTime() - DOSE_ALERT_AFTER_MS) await seedPastSlot(p, now);
        // a time skipped after the list was built
        if (state === "held") await DueSlot.updateOne({ slotKey: p.slotKey, state: "scheduled" }, { $set: { state, reason } });
    }
    const keys = planned.map((p) => p.slotKey);
    const removed = await DueSlot.updateMany({ dateKey, state: "scheduled", slotKey: { $nin: keys } }, { $set: { state: "removed", reason: "no longer scheduled" } });
    // a removed slot that is due again (a schedule turned back on)
    await DueSlot.updateMany({ dateKey, state: "removed", slotKey: { $in: keys } }, { $set: { state: "scheduled" }, $unset: { reason: 1 } });
    return { slots: planned.length, removed: removed.modifiedCount };
}

/** A slot that was already past when first listed: its state from SaheliNudgeLog, and no alert. */
async function seedPastSlot(p: Built, now: Date): Promise<void> {
    const { default: SaheliNudgeLog } = await import("../models/saheliNudgeLog.model");
    const scheduleId = p.kind === "dose" ? p.refId : `reminder:${p.refId}:${p.time}`;
    const log = await SaheliNudgeLog.findOne({ familyId: p.familyId, recipientUserId: p.recipientUserId, scheduleId, dateKey: p.dateKey,
        nudgeKind: p.kind === "dose" ? "dose_due" : "pre_reminder" }).lean<{ delivered?: boolean; deliveryStatus?: string; wamid?: string; reason?: string;
        terminal?: boolean; lastAttemptAt?: Date; attempts?: number; deliveredAt?: Date; readAt?: Date }>().catch(() => null);
    let set: Record<string, unknown>;
    if (log?.delivered) {
        const st = log.deliveryStatus === "read" || log.deliveryStatus === "delivered" ? log.deliveryStatus : "sent";
        set = { state: st, ...(log.wamid ? { wamid: log.wamid } : {}), ...(log.lastAttemptAt ? { sentAt: log.lastAttemptAt } : {}),
                ...(log.deliveredAt ? { deliveredAt: log.deliveredAt } : {}), ...(log.readAt ? { readAt: log.readAt } : {}) };
    } else if (log && (log.reason === "done" || log.reason === "paused" || String(log.reason ?? "").startsWith("gated"))) {
        set = { state: "held", reason: log.reason === "done" ? "already marked taken" : log.reason };
    } else if (log) {
        set = { state: "failed", reason: log.reason || "not delivered" };
    } else {
        set = { state: "held", reason: "before tracking began" };
    }
    await DueSlot.updateOne({ slotKey: p.slotKey }, { $set: { ...set, ...(log?.attempts ? { attempts: log.attempts } : {}), alertedAt: now,
        alertReason: "listed after its time (not alerted)" } }).catch(() => undefined);
}

let last: { dateKey: string; fingerprint: string; at: number } | null = null;

/** What the day's list is built from, in one short hash (every active medicine, reminder and companion). */
async function fingerprint(): Promise<string> {
    const { createHash } = await import("crypto");
    const { default: CareSchedule } = await import("../models/careSchedule.model");
    const { default: SaheliReminder } = await import("../models/saheliReminder.model");
    const { default: SaheliCompanion } = await import("../models/saheliCompanion.model");
    const [sc, rm, cp] = await Promise.all([
        CareSchedule.find({ active: true, type: "MEDICINE" }, { scheduleId: 1, time: 1, daysOfWeek: 1, critical: 1, recipientUserId: 1, _id: 0 }).sort({ scheduleId: 1 }).limit(20_000).lean(),
        SaheliReminder.find({ status: "active" }, { reminderId: 1, updatedAt: 1, _id: 0 }).sort({ reminderId: 1 }).limit(20_000).lean(),
        SaheliCompanion.find({ enabled: true }, { familyId: 1, recipientUserId: 1, _id: 0 }).sort({ familyId: 1, recipientUserId: 1 }).limit(20_000).lean(),
    ]);
    return createHash("sha1").update(JSON.stringify([sc, rm, cp])).digest("hex");
}

/** Every tick: build the day's list at midnight, and again whenever a schedule or reminder changed (or every 30 min). */
export async function ensureDueList(now = clockNow()): Promise<boolean> {
    const dateKey = toDateKeyIST(now);
    const fp = await fingerprint();
    if (last && last.dateKey === dateKey && last.fingerprint === fp && now.getTime() - last.at < 30 * 60_000) return false;
    await buildDueList(dateKey, now);
    last = { dateKey, fingerprint: fp, at: now.getTime() };
    return true;
}

/** Tests only. */
export function resetDueListCache(): void {
    last = null;
}

// ── what happened to a slot ───────────────────────────────────────────────────────────────────────────────────────

/** Meta accepted the slot's message. A test number's (simulated) send counts as delivered and is left out of reports. */
export async function noteDueSent(slotKey: string, info: { wamid?: string; attempts?: number; at?: Date; late?: boolean } = {}): Promise<void> {
    const at = info.at ?? clockNow();
    const test = String(info.wamid ?? "").startsWith("mock.");
    await DueSlot.updateOne(
        { slotKey, state: { $in: ["scheduled", "held", "failed", "missed"] } },
        {
            $set: {
                state: test ? "delivered" : "sent", sentAt: at, ...(info.wamid ? { wamid: info.wamid } : {}),
                ...(info.attempts ? { attempts: info.attempts } : {}), ...(test ? { test: true, deliveredAt: at } : {}),
                ...(info.late ? { reason: "sent late (catch-up)" } : {}),
            },
            ...(info.late ? {} : { $unset: { reason: 1 } }),
        },
    ).catch((err) => console.warn("[due] noteDueSent failed:", err instanceof Error ? err.message : err));
}

/** The slot's send did not reach WhatsApp. */
export async function noteDueFailed(slotKey: string, reason: string, attempts?: number): Promise<void> {
    await DueSlot.updateOne(
        { slotKey, state: { $in: ["scheduled", "held", "failed"] } },
        { $set: { state: "failed", reason: reason.slice(0, 200), failedAt: clockNow(), ...(attempts ? { attempts } : {}) } },
    ).catch((err) => console.warn("[due] noteDueFailed failed:", err instanceof Error ? err.message : err));
}

/** Held back on purpose (already marked taken, quiet hours, paused, an order in progress, skipped). */
export async function noteDueHeld(slotKey: string, reason: string): Promise<void> {
    await DueSlot.updateOne({ slotKey, state: "scheduled" }, { $set: { state: "held", reason: reason.slice(0, 200) } })
        .catch((err) => console.warn("[due] noteDueHeld failed:", err instanceof Error ? err.message : err));
}

/** Never attempted (Kavach was down and it was too late to send). */
export async function noteDueMissed(slotKey: string, reason: string): Promise<void> {
    await DueSlot.updateOne({ slotKey, state: { $in: ["scheduled", "held"] } }, { $set: { state: "missed", reason: reason.slice(0, 200) } })
        .catch((err) => console.warn("[due] noteDueMissed failed:", err instanceof Error ? err.message : err));
}

/** Hold this person's doses due in the last few minutes (the tick skipped them: their quiet hours). */
export async function holdRecentDoses(familyId: string, recipientUserId: string, reason: string, now = clockNow()): Promise<number> {
    const res = await DueSlot.updateMany(
        { familyId, recipientUserId, kind: "dose", state: "scheduled", dueAt: { $lte: now, $gte: new Date(now.getTime() - DOSE_ALERT_AFTER_MS) } },
        { $set: { state: "held", reason } },
    ).catch(() => ({ modifiedCount: 0 }));
    return res.modifiedCount;
}

/** WhatsApp's receipt for a slot's message (from the delivery ledger): delivered, read or failed. */
export async function onDeliveryReceipt(row: { refId?: string; kind: string; part?: number; status: string; deliveredAt?: Date; readAt?: Date;
    failedAt?: Date; errorCode?: number; errorTitle?: string; wamid?: string }): Promise<void> {
    if (!row.refId || row.part || !/^(dose|reminder):/.test(row.refId)) return;
    if (row.kind !== "dose_reminder" && row.kind !== "reminder") return; // follow-ups share the slot but are not its reminder
    if (row.status === "read") {
        await DueSlot.updateOne({ slotKey: row.refId, state: { $in: ["sent", "delivered", "failed"] } },
            { $set: { state: "read", readAt: row.readAt, deliveredAt: row.deliveredAt ?? row.readAt }, $unset: { reason: 1 } });
    } else if (row.status === "delivered") {
        await DueSlot.updateOne({ slotKey: row.refId, state: { $in: ["sent", "failed"] } },
            { $set: { state: "delivered", deliveredAt: row.deliveredAt }, $unset: { reason: 1 } });
    } else if (row.status === "failed") {
        await DueSlot.updateOne({ slotKey: row.refId, state: "sent", wamid: row.wamid },
            { $set: { state: "failed", failedAt: row.failedAt, reason: `WhatsApp ${row.errorCode ?? ""} ${row.errorTitle ?? "failed"}`.replace(/\s+/g, " ").trim().slice(0, 200) } });
    }
}

/** Past their time and never attempted: missed (doses after the alert window, reminders after theirs). */
export async function markMissed(now = clockNow()): Promise<number> {
    const dateKeys = [toDateKeyIST(now), toDateKeyIST(new Date(now.getTime() - 86_400_000))];
    const a = await DueSlot.updateMany({ dateKey: { $in: dateKeys }, kind: "dose", state: "scheduled", dueAt: { $lt: new Date(now.getTime() - DOSE_ALERT_AFTER_MS) } },
        { $set: { state: "missed", reason: "never attempted" } });
    const b = await DueSlot.updateMany({ dateKey: { $in: dateKeys }, kind: "reminder", state: "scheduled", dueAt: { $lt: new Date(now.getTime() - REMINDER_MISSED_AFTER_MS) } },
        { $set: { state: "missed", reason: "never attempted" } });
    return a.modifiedCount + b.modifiedCount;
}
