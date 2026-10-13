/**
 * Escalation (trust plan B2; founder 2026-10-13: "after 3 nudges with no reply, the caregiver hears, as agreed; test that
 * this fires on time every day").
 *
 * One counter, read from the delivery ledger: every proactive message Saheli sent a person about themselves (dose
 * reminders and their follow-ups, reminders, nudges, check-ins; from the backend or the engine) counts; any message from
 * them resets it (their WhatsApp window's last inbound time; a Done tap is a message too). Read receipts are shown in the
 * alert ("seen but not answered") but a read is not a reply.
 *
 * The rule: 3 unanswered in a row, then a 60-minute grace after the third, then the caregivers hear once per streak
 * (nudge_silence; the kavach_alert_noreply template when a caregiver's chat is closed). Each caregiver hears outside their
 * quiet hours (their own setting, else 22:00–07:00 IST), except when one of the unanswered messages was a dose reminder
 * for a medicine marked critical: then at once. Self-care (the person is their own caregiver): no family alert, since an
 * alert about a person never goes to that person; their emergency contact hears if they set one.
 *
 * runEscalationCheck (09:00 IST) re-reads yesterday from the ledger and the inbound log, independently of the rows the
 * tick wrote, and emails the team about any streak whose alert was late or missing ("escalations on time: x/y").
 */
import Escalation, { EscalationCheck, type IEscalation } from "../models/escalation.model";
import MessageDelivery, { PROACTIVE_KINDS, type IMessageDelivery } from "../models/messageDelivery.model";
import { clockNow } from "../utils/clock.util";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";
import { formatWhenIST } from "./saheliNudgeStreak.service";

export const STREAK_COUNT = Math.max(2, Math.round(Number(process.env.NUDGE_SILENCE_ALERT_COUNT) || 3));
export const GRACE_MS = (Number.isFinite(Number(process.env.NUDGE_SILENCE_GRACE_MINUTES)) && process.env.NUDGE_SILENCE_GRACE_MINUTES
    ? Number(process.env.NUDGE_SILENCE_GRACE_MINUTES) : 60) * 60_000;
/** "Within 65 minutes of the third": the grace plus 5 minutes for the tick. */
export const ON_TIME_SLACK_MS = 5 * 60_000;
const LOOKBACK_MS = 7 * 86_400_000;
const DEFAULT_QUIET = { start: 22 * 60, end: 7 * 60 };

export type Send = { id: string; at: Date; kind: string; readAt?: Date | null; critical?: boolean; familyId?: string };

/** Pure: the proactive messages after their last message, oldest first. */
export function unansweredSince(sends: Send[], lastInboundAt: Date | null | undefined): Send[] {
    const since = lastInboundAt ? new Date(lastInboundAt).getTime() : -Infinity;
    return sends.filter((s) => new Date(s.at).getTime() > since).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

/**
 * Pure: every streak of `n` or more unanswered messages in a timeline of sends and inbound messages (the 09:00 check).
 * A streak is the sends since the last inbound before them; repliedAt is their first message after the third.
 */
export function findStreaks(sends: Send[], inbounds: Date[], n = STREAK_COUNT): Array<{ key: string; sends: Send[]; thirdAt: Date; repliedAt: Date | null }> {
    const ins = inbounds.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
    const sorted = [...sends].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    const out: Array<{ key: string; sends: Send[]; thirdAt: Date; repliedAt: Date | null }> = [];
    let cur: Send[] = [];
    const close = () => {
        if (cur.length >= n) {
            const third = new Date(cur[n - 1]!.at);
            const reply = ins.find((t) => t > third.getTime());
            out.push({ key: cur[0]!.id, sends: cur, thirdAt: third, repliedAt: reply != null ? new Date(reply) : null });
        }
        cur = [];
    };
    for (const s of sorted) {
        const at = new Date(s.at).getTime();
        const prev = cur.length ? new Date(cur[cur.length - 1]!.at).getTime() : -Infinity;
        if (cur.length && ins.some((t) => t > prev && t <= at)) close();
        cur.push(s);
    }
    close();
    return out;
}

function minutesOf(hhmm?: string): number | null {
    const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Pure: is this IST minute inside [start, end) (a window may cross midnight)? */
export function inQuiet(minute: number, quiet: { start: number; end: number }): boolean {
    return quiet.start <= quiet.end ? minute >= quiet.start && minute < quiet.end : minute >= quiet.start || minute < quiet.end;
}

/** A caregiver's quiet hours: their own Saheli setting, else 22:00–07:00 IST. */
export async function quietHoursOf(familyId: string, userId: string): Promise<{ start: number; end: number }> {
    const { default: SaheliCompanion } = await import("../models/saheliCompanion.model");
    const row = await SaheliCompanion.findOne({ familyId, recipientUserId: userId }, { quietHoursStart: 1, quietHoursEnd: 1 })
        .lean<{ quietHoursStart?: string; quietHoursEnd?: string }>().catch(() => null);
    const start = minutesOf(row?.quietHoursStart);
    const end = minutesOf(row?.quietHoursEnd);
    return start != null && end != null ? { start, end } : DEFAULT_QUIET;
}

/** Pure: the first moment at or after `from` outside these quiet hours (to the minute). */
export function wakeAfter(from: Date, quiet: { start: number; end: number }): Date {
    let t = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
    for (let i = 0; i < 24 * 60 && inQuiet(getISTParts(t).minutesSinceMidnight, quiet); i++) t = new Date(t.getTime() + 60_000);
    return t;
}

/** "⚠️ Kamla hasn't replied to Saheli's last 3 messages (since today, 9:12 AM). She read 2 of them …" */
export function escalationText(input: { name: string; count: number; seen: number; firstAt: Date; lastReplyAt: Date | null; now: Date }): string {
    const seenLine = input.seen > 0
        ? `WhatsApp shows ${input.seen === input.count ? "all of them" : `${input.seen} of them`} as read, but no answer came.`
        : "WhatsApp does not show any of them as read yet.";
    return [
        `⚠️ ${input.name} hasn't replied to Saheli's last ${input.count} messages (since ${formatWhenIST(input.firstAt, input.now)}).`,
        seenLine,
        `Last reply: ${formatWhenIST(input.lastReplyAt, input.now)}.`,
        "Maybe give them a quick call.",
    ].join("\n");
}

function toSend(r: Pick<IMessageDelivery, "sentAt" | "kind" | "readAt" | "critical" | "familyId"> & { _id: unknown }): Send {
    return { id: String(r._id), at: new Date(r.sentAt!), kind: r.kind, readAt: r.readAt ?? null, critical: Boolean(r.critical), familyId: r.familyId };
}

/** The proactive messages to this person about themselves that reached WhatsApp (first part of each), in a time range. */
async function proactiveSends(personUserId: string, from: Date, to: Date): Promise<Send[]> {
    const rows = await MessageDelivery.find({
        toUserId: personUserId, kind: { $in: PROACTIVE_KINDS }, status: { $ne: "failed" }, sentAt: { $gt: from, $lte: to },
        $and: [{ $or: [{ part: { $exists: false } }, { part: 0 }] }, { $or: [{ aboutUserId: { $exists: false } }, { aboutUserId: personUserId }] }],
    }).sort({ sentAt: 1 }).limit(200).lean<Array<IMessageDelivery & { _id: unknown }>>();
    return rows.map(toSend);
}

async function lastInboundOf(phone: string | undefined): Promise<Date | null> {
    if (!phone) return null;
    const { default: WhatsAppWindow } = await import("../models/whatsappWindow.model");
    const row = await WhatsAppWindow.findOne({ phone }).lean<{ lastInboundAt?: Date }>().catch(() => null);
    return row?.lastInboundAt && new Date(row.lastInboundAt).getTime() > 0 ? new Date(row.lastInboundAt) : null;
}

type Who = { selfCare: boolean; caregivers: string[]; name: string; phone?: string };

/** The person's place in the family: cared for (their caregivers hear) or caring for themselves (self-care). */
async function whoIs(familyId: string, personUserId: string): Promise<Who> {
    const { default: Family } = await import("../models/family.model");
    const { default: User } = await import("../models/users.model");
    const family = await Family.findOne({ familyId, status: "ACTIVE" }, { members: 1 }).lean<{ members: Array<{ userId: string; role: string; status: string }> }>();
    const member = family?.members.find((m) => m.userId === personUserId);
    const caregivers = (family?.members ?? [])
        .filter((m) => m.status === "JOINED" && (m.role === "PRIMARY_CAREGIVER" || m.role === "CO_CAREGIVER") && m.userId !== personUserId)
        .map((m) => m.userId);
    const user = await User.findOne({ userId: personUserId }, { firstName: 1 }).lean<{ firstName?: string }>().catch(() => null);
    return {
        selfCare: member?.role !== "CARE_RECIPIENT",
        caregivers: member?.role === "CARE_RECIPIENT" ? caregivers : [],
        name: (user?.firstName || "Your family member").trim().split(/\s+/)[0]!,
    };
}

/** A self-care person's emergency contact (from their care record): a number that is not their own, or null. */
export async function emergencyContactOf(familyId: string, personUserId: string, personPhone?: string): Promise<{ name: string; phone: string } | null> {
    try {
        const { aiEngineJson } = await import("../clients/aiEngine.client");
        const card = await aiEngineJson<{ contacts?: Array<{ name?: string; phone?: string | null; emergency?: boolean }> }>(
            "GET", `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(personUserId)}/emergency`, undefined, 15_000);
        const own = String(personPhone ?? "").replace(/\D/g, "").slice(-10);
        const c = (card.contacts ?? []).find((x) => x.emergency && x.phone && String(x.phone).replace(/\D/g, "").length >= 10
            && String(x.phone).replace(/\D/g, "").slice(-10) !== own);
        if (!c) return null;
        const digits = String(c.phone).replace(/\D/g, "");
        return { name: c.name || "their emergency contact", phone: `+${digits.length === 10 ? `91${digits}` : digits}` };
    } catch {
        return null;
    }
}

/** For the engine: the person's unanswered streak now and the escalation it led to (if any). Members of this family only. */
export async function escalationStatus(familyId: string, personUserId: string, now = clockNow()): Promise<{
    unanswered: number; streakSince: string | null; state: string; dueAt: string | null; sentAt: string | null;
}> {
    const { default: Family } = await import("../models/family.model");
    if (!(await Family.exists({ familyId, "members.userId": personUserId }))) return { unanswered: 0, streakSince: null, state: "none", dueAt: null, sentAt: null };
    const latest = await MessageDelivery.findOne({ toUserId: personUserId, kind: { $in: PROACTIVE_KINDS } }, { phone: 1 }).sort({ sentAt: -1 }).lean<{ phone?: string }>();
    const lastInbound = await lastInboundOf(latest?.phone);
    const from = new Date(Math.max(now.getTime() - LOOKBACK_MS, lastInbound?.getTime() ?? 0));
    const streak = unansweredSince(await proactiveSends(personUserId, from, now), lastInbound);
    const esc = streak.length ? await Escalation.findOne({ streakKey: streak[0]!.id }).lean<IEscalation>() : null;
    return {
        unanswered: streak.length, streakSince: streak[0] ? streak[0].at.toISOString() : null, state: esc?.state ?? "none",
        dueAt: esc?.dueAt ? new Date(esc.dueAt).toISOString() : null, sentAt: esc?.sentAt ? new Date(esc.sentAt).toISOString() : null,
    };
}

export type TickResult = { checked: number; created: number; sent: number; deferred: number; replied: number; none: number };

/** Every minute: find streaks that reached 3, and tell the caregivers when their alert is due. */
export async function runEscalationTick(now = clockNow()): Promise<TickResult> {
    const out: TickResult = { checked: 0, created: 0, sent: 0, deferred: 0, replied: 0, none: 0 };
    const recent = await MessageDelivery.distinct("toUserId", {
        kind: { $in: PROACTIVE_KINDS }, status: { $ne: "failed" }, sentAt: { $gte: new Date(now.getTime() - 48 * 3_600_000), $lte: now },
    }) as string[];
    const open = await Escalation.distinct("personUserId", { $or: [{ state: { $in: ["pending", "deferred"] } }, { state: "sent", partial: true }] }) as string[];
    for (const person of [...new Set([...recent, ...open].filter(Boolean))]) {
        out.checked += 1;
        try {
            await escalateOne(person, now, out);
        } catch (err) {
            console.warn(`[escalation] check failed for …${person.slice(-4)}:`, err instanceof Error ? err.message : err);
        }
    }
    return out;
}

async function escalateOne(person: string, now: Date, out: TickResult): Promise<void> {
    const latest = await MessageDelivery.findOne({ toUserId: person, kind: { $in: PROACTIVE_KINDS } }, { phone: 1, familyId: 1 })
        .sort({ sentAt: -1 }).lean<{ phone?: string; familyId?: string }>();
    const lastInbound = await lastInboundOf(latest?.phone);
    const from = new Date(Math.max(now.getTime() - LOOKBACK_MS, lastInbound?.getTime() ?? 0));
    const streak = unansweredSince(await proactiveSends(person, from, now), lastInbound);
    // a streak that was open but they wrote (or tapped Done) since: nothing is sent
    const stale = await Escalation.find({ personUserId: person, $or: [{ state: { $in: ["pending", "deferred"] } }, { state: "sent", partial: true }] }).lean<IEscalation[]>();
    for (const e of stale) {
        if (!streak.length || streak[0]!.id !== e.streakKey) {
            if (e.state === "sent") {
                // they answered after the first caregiver was told: the others need not be woken for it
                await Escalation.updateOne({ streakKey: e.streakKey }, { $set: { partial: false, repliedAt: lastInbound ?? now } });
                continue;
            }
            await Escalation.updateOne({ streakKey: e.streakKey, state: { $in: ["pending", "deferred"] } },
                { $set: { state: "replied", repliedAt: lastInbound ?? now, reason: "they wrote before the alert" } });
            out.replied += 1;
        }
    }
    if (streak.length < STREAK_COUNT) return;
    const first = streak[0]!;
    const third = streak[STREAK_COUNT - 1]!;
    const familyId = third.familyId || latest?.familyId;
    if (!familyId) return;
    const critical = streak.some((s) => s.critical && (s.kind === "dose_reminder" || s.kind === "dose_followup"));
    const seen = streak.filter((s) => s.readAt).length;
    const who = await whoIs(familyId, person);
    const created = await Escalation.updateOne(
        { streakKey: first.id },
        {
            $setOnInsert: { streakKey: first.id, familyId, personUserId: person, firstAt: first.at, thirdAt: third.at,
                            dueAt: new Date(third.at.getTime() + GRACE_MS), state: "pending", notified: [], selfCare: who.selfCare, createdAt: now },
            $set: { count: streak.length, seen, critical },
        },
        { upsert: true },
    );
    if (created.upsertedCount) out.created += 1;
    const esc = await Escalation.findOne({ streakKey: first.id }).lean<IEscalation>();
    if (!esc) return;
    const later = esc.state === "sent" && esc.partial && esc.sentAt && now.getTime() - new Date(esc.sentAt).getTime() < 24 * 3_600_000;
    if (esc.state !== "pending" && esc.state !== "deferred" && !later) return;
    if (now.getTime() < new Date(esc.dueAt).getTime()) return; // the grace: they may still answer

    const message = escalationText({ name: who.name, count: streak.length, seen, firstAt: first.at, lastReplyAt: lastInbound, now });
    if (who.selfCare) {
        await alertEmergencyContact(esc, who, message, latest?.phone, critical, now, out);
        return;
    }
    if (!who.caregivers.length) {
        await Escalation.updateOne({ streakKey: esc.streakKey }, { $set: { state: "none", reason: "no caregiver in the family" } });
        out.none += 1;
        return;
    }
    const minute = getISTParts(now).minutesSinceMidnight;
    const waiting = who.caregivers.filter((c) => !esc.notified.includes(c));
    const awake: string[] = [];
    for (const c of waiting) if (critical || !inQuiet(minute, await quietHoursOf(familyId, c))) awake.push(c);
    if (!awake.length) {
        if (!esc.sentAt && esc.state !== "deferred") {
            await Escalation.updateOne({ streakKey: esc.streakKey, state: "pending" },
                { $set: { state: "deferred", deferredAt: now, reason: "quiet hours: goes when a caregiver's quiet hours end" } });
            out.deferred += 1;
            console.log(`[escalation] deferred for quiet hours (…${person.slice(-4)}, ${streak.length} unanswered)`);
        }
        return;
    }
    const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
    const res = await notifyCaregivers({
        familyId, recipientUserId: person, actorUserId: person, message, urgency: critical ? "high" : "medium", kind: "nudge_silence",
        onlyUserIds: awake, refId: `escalation:${esc.streakKey}`, dedupeKey: `escalation:${esc.streakKey}`,
    });
    const notified = [...new Set([...esc.notified, ...res.notifiedUserIds])];
    if (res.notifiedUserIds.length) {
        await Escalation.updateOne({ streakKey: esc.streakKey }, {
            $set: {
                notified, state: "sent", sentAt: esc.sentAt ?? now,
                // a caregiver still in their quiet hours hears when they wake (within a day)
                partial: notified.length < who.caregivers.length,
                ...(esc.sentAt ? {} : { reason: esc.state === "deferred" ? "deferred for quiet hours" : critical ? "critical medicine: not held for quiet hours" : "alert sent" }),
            },
        });
        if (!esc.sentAt) out.sent += 1;
        console.log(`[escalation] ${res.notifiedUserIds.length} caregiver(s) told (…${person.slice(-4)}, ${streak.length} unanswered, seen ${seen})`);
    } else if (!esc.sentAt) {
        await Escalation.updateOne({ streakKey: esc.streakKey }, { $set: { state: "none", reason: "no caregiver could be reached on WhatsApp (told in the app)" } });
        out.none += 1;
    } else {
        await Escalation.updateOne({ streakKey: esc.streakKey }, { $set: { partial: false } });
    }
}

async function alertEmergencyContact(esc: IEscalation, who: Who, message: string, personPhone: string | undefined, critical: boolean, now: Date, out: TickResult) {
    const contact = await emergencyContactOf(esc.familyId, esc.personUserId, personPhone);
    if (!contact) {
        await Escalation.updateOne({ streakKey: esc.streakKey }, { $set: { state: "none", reason: "self-care: no caregiver to tell and no emergency contact set" } });
        out.none += 1;
        return;
    }
    if (!critical && inQuiet(getISTParts(now).minutesSinceMidnight, DEFAULT_QUIET)) {
        if (esc.state !== "deferred") {
            await Escalation.updateOne({ streakKey: esc.streakKey }, { $set: { state: "deferred", deferredAt: now, reason: "quiet hours (emergency contact)" } });
            out.deferred += 1;
        }
        return;
    }
    const { deliverOutboundMessage } = await import("./channelOutbound.service");
    // A contact who never wrote to Kavach has no open chat: the template goes (a free message would fail quietly).
    const { default: WhatsAppWindow } = await import("../models/whatsappWindow.model");
    const W = await import("./whatsappWindow.service");
    if (!(await WhatsAppWindow.exists({ phone: W.phoneKey(contact.phone) }))) await W.noteClosed(contact.phone, now);
    // the reader is not a Kavach user: the waiting alert is kept by their number, never by the person's own id
    const delivery = await deliverOutboundMessage({
        purpose: "alert", familyId: esc.familyId, recipientUserId: esc.personUserId, toUserId: `contact:${contact.phone.replace(/\D/g, "")}`,
        content: `${message}\n\n(You are ${who.name}'s emergency contact on Kavach.)`, channel: "whatsapp", channelIdentifier: contact.phone,
        template: { purpose: "alert_noreply", params: [who.name], lang: "en" },
        delivery: { kind: "alert", refId: `escalation:${esc.streakKey}` },
    });
    await Escalation.updateOne({ streakKey: esc.streakKey }, delivery.delivered
        ? { $set: { state: "sent", sentAt: now, contactNotifiedAt: now, reason: "self-care: the emergency contact was told" } }
        : { $set: { state: "none", reason: `self-care: the emergency contact could not be reached (${delivery.reason ?? "failed"})` } });
    if (delivery.delivered) out.sent += 1;
    else out.none += 1;
}

// ── the 09:00 check (B2.5b) ───────────────────────────────────────────────────────────────────────────────────────

export type CheckCase = { family: string; person: string; personUserId: string; thirdAt: Date; dueAt: Date; outcome: string; reason?: string; alertAt?: Date; onTime: boolean };

/** Pure: was this streak handled on time? */
export function judgeCase(input: {
    thirdAt: Date; repliedAt: Date | null; escalation: Pick<IEscalation, "state" | "reason" | "sentAt" | "deferredAt"> | null; alertAt: Date | null;
    wakeAt: Date | null; now: Date;
}): { outcome: string; onTime: boolean; reason?: string; alertAt?: Date } {
    const due = input.thirdAt.getTime() + GRACE_MS;
    if (input.repliedAt && input.repliedAt.getTime() <= due) return { outcome: "replied before the alert was due", onTime: true };
    const e = input.escalation;
    const alertAt = input.alertAt ?? (e?.sentAt ? new Date(e.sentAt) : null);
    if (!e) return { outcome: "no escalation recorded", onTime: false, ...(alertAt ? { alertAt } : {}) };
    if (e.state === "none") return { outcome: "no one to tell", onTime: Boolean(e.reason), ...(e.reason ? { reason: e.reason } : {}) };
    if (alertAt && alertAt.getTime() <= due + ON_TIME_SLACK_MS) return { outcome: "alert sent", onTime: true, alertAt };
    if (e.deferredAt && input.wakeAt) {
        if (alertAt && alertAt.getTime() <= input.wakeAt.getTime() + ON_TIME_SLACK_MS) return { outcome: "deferred for quiet hours, then sent", onTime: true, alertAt, ...(e.reason ? { reason: e.reason } : {}) };
        if (!alertAt && input.now.getTime() < input.wakeAt.getTime() + ON_TIME_SLACK_MS) return { outcome: "deferred for quiet hours (not yet due)", onTime: true, ...(e.reason ? { reason: e.reason } : {}) };
    }
    if (e.state === "replied") return { outcome: "marked replied after the alert was due, nothing sent", onTime: false, ...(e.reason ? { reason: e.reason } : {}) };
    return { outcome: alertAt ? "alert late" : "alert missing", onTime: false, ...(alertAt ? { alertAt } : {}), ...(e.reason ? { reason: e.reason } : {}) };
}

/** At 09:00 IST, once a day: yesterday's streaks against what happened. A miss emails the team. */
export async function runEscalationCheck(now = clockNow(), opts: { force?: boolean } = {}): Promise<{ dateKey: string; onTime: number; total: number; cases: CheckCase[] } | null> {
    if (!opts.force && getISTParts(now).minutesSinceMidnight < 9 * 60) return null;
    const today = toDateKeyIST(now);
    const dayStart = new Date(new Date(`${today}T00:00:00+05:30`).getTime() - 86_400_000);
    const dayEnd = new Date(`${today}T00:00:00+05:30`);
    const dateKey = toDateKeyIST(dayStart);
    if (!opts.force && await EscalationCheck.exists({ dateKey })) return null;
    const from = new Date(dayStart.getTime() - 2 * 86_400_000);
    const people = (await MessageDelivery.distinct("toUserId", { kind: { $in: PROACTIVE_KINDS }, status: { $ne: "failed" }, sentAt: { $gte: from, $lt: dayEnd } }) as string[]).filter(Boolean);
    const { default: InboundLog } = await import("../models/whatsappInboundDedupe.model");
    const cases: CheckCase[] = [];
    for (const person of people) {
        const sends = await proactiveSends(person, from, now);
        if (sends.length < STREAK_COUNT) continue;
        const phone = (await MessageDelivery.findOne({ toUserId: person, kind: { $in: PROACTIVE_KINDS } }, { phone: 1 }).sort({ sentAt: -1 }).lean<{ phone?: string }>())?.phone;
        const inbounds = phone
            ? (await InboundLog.find({ phone, createdAt: { $gte: from, $lte: now } }, { createdAt: 1 }).lean<Array<{ createdAt: Date }>>()).map((r) => new Date(r.createdAt))
            : [];
        const last = await lastInboundOf(phone);
        if (last) inbounds.push(last);
        for (const s of findStreaks(sends, inbounds)) {
            if (s.thirdAt < dayStart || s.thirdAt >= dayEnd) continue;
            const esc = await Escalation.findOne({ streakKey: s.key }).lean<IEscalation>();
            const alertRow = await MessageDelivery.findOne({ kind: "alert", refId: `escalation:${s.key}` }, { sentAt: 1 }).sort({ sentAt: 1 }).lean<{ sentAt?: Date }>();
            const familyId = s.sends[STREAK_COUNT - 1]!.familyId || esc?.familyId || "";
            let wakeAt: Date | null = null;
            if (esc?.deferredAt) {
                const due = new Date(s.thirdAt.getTime() + GRACE_MS);
                const who = familyId ? await whoIs(familyId, person) : null;
                const wakes = who?.selfCare ? [wakeAfter(due, DEFAULT_QUIET)]
                    : await Promise.all((who?.caregivers ?? []).map(async (c) => wakeAfter(due, await quietHoursOf(familyId, c))));
                wakeAt = wakes.length ? new Date(Math.min(...wakes.map((w) => w.getTime()))) : null;
            }
            const verdict = judgeCase({ thirdAt: s.thirdAt, repliedAt: s.repliedAt, escalation: esc, alertAt: alertRow?.sentAt ? new Date(alertRow.sentAt) : null, wakeAt, now });
            const name = familyId ? (await whoIs(familyId, person)).name : "someone";
            cases.push({ family: familyId.slice(0, 8), person: name, personUserId: person, thirdAt: s.thirdAt, dueAt: new Date(s.thirdAt.getTime() + GRACE_MS), ...verdict });
        }
    }
    const onTime = cases.filter((c) => c.onTime).length;
    const result = { dateKey, onTime, total: cases.length, cases };
    try {
        await EscalationCheck.updateOne({ dateKey }, { $set: { checkedAt: now, onTime, total: cases.length, cases } }, { upsert: true });
    } catch (err) {
        console.warn("[escalation-check] save failed:", err instanceof Error ? err.message : err);
    }
    const misses = cases.filter((c) => !c.onTime);
    console.log(`[escalation-check] ${dateKey}: escalations on time ${onTime}/${cases.length}`);
    if (misses.length) {
        const ist = (d?: Date) => (d ? new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "-");
        const text = [
            `Escalations on time on ${dateKey}: ${onTime}/${cases.length}. These streaks of 3 unanswered messages were not handled on time:`,
            "",
            ...misses.map((c) => `• family ${c.family} · ${c.person} · third message ${ist(c.thirdAt)} · alert due ${ist(c.dueAt)} · ${c.outcome}${c.alertAt ? ` at ${ist(c.alertAt)}` : ""}${c.reason ? ` (${c.reason})` : ""}`),
            "",
            "The rule: the caregiver hears once, 60 minutes after the third unanswered message (within 65), or when their quiet hours end. Check the admin console's Delivery page and the backend logs ([escalation]).",
        ].join("\n");
        const { alertOps } = await import("./opsAlert.service");
        const sent = await alertOps(`escalation-check:${dateKey}`, `Escalations on time ${onTime}/${cases.length} on ${dateKey}`, text, { everyMs: 0, now: now.getTime() });
        const { default: OpsAlertLog } = await import("../models/opsAlertLog.model");
        await OpsAlertLog.create({ kind: "escalation", subject: `Escalations on time ${onTime}/${cases.length} on ${dateKey}`, text,
            items: misses.map((c) => ({ family: c.family, person: c.person, time: ist(c.thirdAt), reason: c.outcome })), emailed: sent.sent, at: now }).catch(() => undefined);
        if (sent.sent) await EscalationCheck.updateOne({ dateKey }, { $set: { emailedAt: now } }).catch(() => undefined);
    }
    return result;
}
