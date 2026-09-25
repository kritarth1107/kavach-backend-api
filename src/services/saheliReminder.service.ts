import { randomUUID } from "crypto";
import { claimNudgeAttempt, finalizeNudgeAttempt } from "./saheliNudgeAttempt.service";
import Family from "../models/family.model";
import SaheliReminder, {
    type ISaheliReminder,
    type SaheliReminderKind,
    type SaheliReminderStatus,
} from "../models/saheliReminder.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyRole } from "../types/family.types";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";
import { getCompanionProfile, isWithinQuietHours } from "./saheliCompanion.service";
import { deliverOutboundMessage, resolveRecipientChannel } from "./channelOutbound.service";
import { parseTimeToMinutes } from "./careScheduleCompletion.service";

const MANAGER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

function serialize(doc: ISaheliReminder) {
    return {
        reminderId: doc.reminderId,
        familyId: doc.familyId,
        recipientUserId: doc.recipientUserId,
        text: doc.text,
        times: doc.times ?? [],
        kind: doc.kind,
        timezone: doc.timezone,
        windowStartMinutes: doc.windowStartMinutes ?? null,
        windowEndMinutes: doc.windowEndMinutes ?? null,
        stopConditionPhrase: doc.stopConditionPhrase ?? null,
        status: doc.status,
        createdBy: doc.createdBy,
        lastFiredAt: doc.lastFiredAt ?? null,
        lastFiredSlotKey: doc.lastFiredSlotKey ?? null,
    };
}

async function assertCanManageReminder(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
): Promise<void> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new AppError("Family not found", 404);
    if (!family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }
    const role = family.getMemberRole(actorUserId);
    // CARE_RECIPIENT may manage own reminders; caregivers manage for recipient.
    if (actorUserId === recipientUserId && role === FamilyRole.CARE_RECIPIENT) return;
    if (role && MANAGER_ROLES.has(role)) return;
    throw new AppError("You do not have permission to manage reminders", 403);
}

/** Parse "6pm", "9:00", "18:00", "6:30 pm" → HH:MM 24h. */
export function parseClockToHHMM(raw: string): string | null {
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
    const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const min = m[2] ?? "00";
    const ap = (m[3] || "").toLowerCase();
    if (Number.isNaN(h) || h > 23) return null;
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h > 23) return null;
    return `${String(h).padStart(2, "0")}:${min}`;
}

/** Extract multiple clock times from free text ("6pm and 9pm", "at 18:00, 21:00"). */
export function extractTimesFromText(text: string): string[] {
    const found: string[] = [];
    const re =
        /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|(?:[01]?\d|2[0-3]):[0-5]\d)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const hhmm = parseClockToHHMM(m[1]);
        if (hhmm && !found.includes(hhmm)) found.push(hhmm);
    }
    // Hindi: "raat 8 baje", "subah 9 baje", "sham 6 baje", or bare "8 baje"
    const bajeRe =
        /\b(subah|savar|savere|dupahar|dopahar|sham|shaam|raat|night|evening|morning)?\s*(\d{1,2})\s*baje\b/gi;
    let bm: RegExpExecArray | null;
    while ((bm = bajeRe.exec(text)) !== null) {
        let h = parseInt(bm[2], 10);
        if (Number.isNaN(h) || h < 0 || h > 23) continue;
        const period = (bm[1] || "").toLowerCase();
        if (period && h <= 12) {
            if (/raat|night/.test(period) && h < 12) {
                // 8 raat → 20:00; 12 raat stays awkward — treat 1-11 as PM
                if (h < 12) h = h === 12 ? 0 : h + 12;
            } else if (/sham|shaam|evening/.test(period) && h < 12) {
                h = h + 12;
            } else if (/subah|savar|savere|morning/.test(period) && h === 12) {
                h = 0;
            }
            // dupahar 1-4 → +12 if <=4? keep simple: 1-4 dopahar => 13-16
            else if (/dupahar|dopahar/.test(period) && h < 12) {
                h = h + 12;
            }
        }
        const hhmm = `${String(h).padStart(2, "0")}:00`;
        if (!found.includes(hhmm)) found.push(hhmm);
    }
    return found;
}

export function parseHourlyWindow(text: string): {
    start: number | null;
    end: number | null;
    needsEnd: boolean;
} {
    const lower = text.toLowerCase();
    const hourly =
        /\bevery\s+hour\b/.test(lower) ||
        /\bhourly\b/.test(lower) ||
        /\bevery\s+1\s*h(our)?\b/.test(lower);
    if (!hourly) return { start: null, end: null, needsEnd: false };

    const times = extractTimesFromText(text);
    const startHH = times[0] ?? null;
    const endHH = times[1] ?? null;
    const start = startHH ? parseTimeToMinutes(startHH) : null;
    const end = endHH ? parseTimeToMinutes(endHH) : null;

    const fromMatch = lower.match(/\bfrom\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i);
    const untilMatch = lower.match(
        /\b(?:until|till|to|upto|up to)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i,
    );
    const start2 = fromMatch ? parseTimeToMinutes(parseClockToHHMM(fromMatch[1]) ?? "") : start;
    const end2 = untilMatch ? parseTimeToMinutes(parseClockToHHMM(untilMatch[1]) ?? "") : end;

    return {
        start: start2,
        end: end2,
        needsEnd: start2 != null && end2 == null,
    };
}

export async function createSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    times?: string[];
    kind?: SaheliReminderKind;
    windowStartMinutes?: number | null;
    windowEndMinutes?: number | null;
    stopConditionPhrase?: string | null;
}): Promise<
    | { ok: true; reminder: ReturnType<typeof serialize>; askUser?: string }
    | { ok: false; error: string; askUser?: string }
> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);

    const text = input.text.trim().slice(0, 400);
    if (!text || text.length < 2) {
        return { ok: false, error: "Reminder text is required." };
    }

    const window = parseHourlyWindow(text);
    let kind: SaheliReminderKind = input.kind ?? (window.start != null ? "hourly_window" : "multi_time");
    let times = (input.times ?? []).map((t) => parseClockToHHMM(t) ?? t).filter(Boolean);
    if (!times.length && kind === "multi_time") {
        times = extractTimesFromText(text);
    }

    let windowStartMinutes = input.windowStartMinutes ?? window.start ?? null;
    let windowEndMinutes =
        input.windowEndMinutes !== undefined ? input.windowEndMinutes : window.end ?? null;

    if (kind === "hourly_window" || window.needsEnd) {
        kind = "hourly_window";
        if (windowStartMinutes == null) {
            return {
                ok: false,
                error: "missing_window_start",
                askUser: "What time should I start reminding you every hour?",
            };
        }
        if (windowEndMinutes == null || window.needsEnd) {
            return {
                ok: false,
                error: "missing_window_end",
                askUser: "What time should I stop the hourly reminders?",
            };
        }
    }

    if (kind === "multi_time" && !times.length) {
        return {
            ok: false,
            error: "missing_times",
            askUser: "What time(s) should I remind you? For example 6pm and 9pm.",
        };
    }

    let stop =
        input.stopConditionPhrase?.trim() ||
        (/\buntil\s+i\s+(say\s+)?(.+)$/i.exec(text)?.[2]?.trim() ?? undefined);
    if (stop && stop.length > 200) stop = stop.slice(0, 200);
    if (!stop && /\buntil\s+i\s+(fill|filled|done|finish|call)/i.test(text)) {
        stop = "filled";
    }

    const doc = await SaheliReminder.create({
        reminderId: randomUUID(),
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        text,
        times: kind === "multi_time" ? times : [],
        kind,
        timezone: "Asia/Kolkata",
        windowStartMinutes: kind === "hourly_window" ? windowStartMinutes ?? undefined : undefined,
        windowEndMinutes: kind === "hourly_window" ? windowEndMinutes : null,
        stopConditionPhrase: stop,
        status: "active" as SaheliReminderStatus,
        createdBy: input.actorUserId,
    });

    return { ok: true, reminder: serialize(doc) };
}

export async function listSaheliReminders(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    status?: SaheliReminderStatus;
}) {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    const filter: Record<string, unknown> = {
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
    };
    if (input.status) filter.status = input.status;
    else filter.status = "active";
    const rows = await SaheliReminder.find(filter).sort({ createdAt: -1 }).limit(40).lean();
    return rows.map((r) => serialize(r as ISaheliReminder));
}

export async function cancelSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    reminderId?: string;
    textHint?: string;
}): Promise<{ ok: boolean; reminder?: ReturnType<typeof serialize>; error?: string }> {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    let doc = input.reminderId
        ? await SaheliReminder.findOne({
              reminderId: input.reminderId,
              familyId: input.familyId,
              recipientUserId: input.recipientUserId,
          })
        : null;
    if (!doc && input.textHint) {
        const hint = input.textHint.toLowerCase();
        const active = await SaheliReminder.find({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            status: "active",
        }).lean();
        const match = active.find((r) => r.text.toLowerCase().includes(hint) || hint.includes(r.text.toLowerCase().slice(0, 20)));
        if (match) {
            doc = await SaheliReminder.findOne({ reminderId: match.reminderId });
        }
    }
    if (!doc) return { ok: false, error: "Reminder not found." };
    doc.status = "cancelled";
    await doc.save();
    return { ok: true, reminder: serialize(doc) };
}

export async function completeSaheliReminder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    reminderId: string;
}) {
    await assertCanManageReminder(input.familyId, input.recipientUserId, input.actorUserId);
    const doc = await SaheliReminder.findOne({
        reminderId: input.reminderId,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
    });
    if (!doc) return { ok: false as const, error: "Reminder not found." };
    doc.status = "completed";
    await doc.save();
    return { ok: true as const, reminder: serialize(doc) };
}

function normalizePhrase(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Hybrid semantic stop: phrase match + light heuristics. */
export function messageCompletesReminder(
    message: string,
    reminder: Pick<ISaheliReminder, "text" | "stopConditionPhrase">,
): boolean {
    const msg = normalizePhrase(message);
    if (!msg || msg.length > 160) return false;

    const stop = reminder.stopConditionPhrase
        ? normalizePhrase(reminder.stopConditionPhrase)
        : "";
    if (stop && (msg.includes(stop) || stop.includes(msg))) return true;

    const filled =
        /\b(i\s+)?(filled|fill(ed)?\s+it|done|finished|complete(d)?|drank|drink|pi\s+liya|pi\s+li|le\s+liya|le\s+li|kar\s+diya|ho\s+gaya|i'?ve\s+called|i\s+called|called\s+(them|him|her))\b/.test(
            msg,
        );
    if (!filled) return false;

    // If reminder mentions medicine / fill / call, accept generic done phrases.
    const topic = normalizePhrase(reminder.text);
    if (/\b(fill|medicine|tablet|dose|pill|call|remind|water|paani|drink)\b/.test(topic) || !topic) {
        return true;
    }
    // Soft overlap between reminder topic and message
    const tokens = topic.split(" ").filter((w) => w.length >= 4);
    return tokens.some((t) => msg.includes(t)) || tokens.length === 0;
}

export async function tryCompleteRemindersFromMessage(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
}): Promise<string | null> {
    const active = await SaheliReminder.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        status: "active",
    }).limit(20);
    if (!active.length) return null;

    const completed: string[] = [];
    for (const rem of active) {
        if (messageCompletesReminder(input.message, rem)) {
            rem.status = "completed";
            await rem.save();
            completed.push(rem.text);
        }
    }
    if (!completed.length) return null;
    if (completed.length === 1) {
        return `Got it — I'll stop reminding you about "${completed[0]}".`;
    }
    return `Got it — stopped ${completed.length} reminders.`;
}

async function fireReminderMessage(input: {
    familyId: string;
    recipientUserId: string;
    reminder: ISaheliReminder;
    slotKey: string;
    dateKey: string;
}): Promise<boolean> {
    const companion = await getCompanionProfile(input.familyId, input.recipientUserId);
    if (isWithinQuietHours(companion)) {
        return false;
    }

    const text = `Reminder: ${input.reminder.text}`;
    const attemptId = await claimNudgeAttempt(
        {
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            scheduleId: `reminder:${input.reminder.reminderId}:${input.slotKey}`,
            dateKey: input.dateKey,
            nudgeKind: "pre_reminder",
        },
        text,
    );
    if (!attemptId) {
        return false;
    }

    const target = await resolveRecipientChannel(
        input.familyId,
        input.recipientUserId,
        companion.preferredChannel ?? "whatsapp",
    );
    if (!target || target.channel === "dashboard") {
        console.warn(
            `Reminder skipped — no valid WhatsApp recipient for ${input.recipientUserId}; terminal for this slot`,
        );
        await finalizeNudgeAttempt(attemptId, {
            delivered: false,
            channel: "dashboard",
            terminal: true,
            reason: "no_valid_recipient",
        });
        return false;
    }

    const delivery = await deliverOutboundMessage({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        content: text,
        channel: target.channel,
        channelIdentifier: target.channelIdentifier,
    });

    await finalizeNudgeAttempt(attemptId, {
        delivered: delivery.delivered,
        channel: target.channel,
        terminal: delivery.reason === "invalid_recipient",
        reason: delivery.delivered ? undefined : delivery.reason ?? "send_failed",
    });

    if (delivery.delivered) {
        await SaheliReminder.updateOne(
            { reminderId: input.reminder.reminderId },
            {
                $set: {
                    lastFiredAt: new Date(),
                    lastFiredSlotKey: `${input.dateKey}:${input.slotKey}`,
                },
            },
        );
    }
    return delivery.delivered;
}

/** Tick due Instinct-style reminders (call from care nudge scheduler). */
export async function runSaheliReminderTick(
    now = new Date(),
): Promise<{ sent: number; scanned: number }> {
    const dateKey = toDateKeyIST(now);
    const { minutesSinceMidnight } = getISTParts(now);
    const active = await SaheliReminder.find({ status: "active" }).limit(500).lean();
    let sent = 0;
    let scanned = 0;

    for (const rem of active) {
        scanned += 1;
        if (rem.kind === "multi_time") {
            for (const t of rem.times ?? []) {
                const mins = parseTimeToMinutes(t);
                if (mins == null) continue;
                // Fire within a 2-minute window of the slot.
                if (minutesSinceMidnight < mins || minutesSinceMidnight > mins + 1) continue;
                const ok = await fireReminderMessage({
                    familyId: rem.familyId,
                    recipientUserId: rem.recipientUserId,
                    reminder: rem as ISaheliReminder,
                    slotKey: t,
                    dateKey,
                });
                if (ok) sent += 1;
            }
            continue;
        }

        if (rem.kind === "hourly_window") {
            const start = rem.windowStartMinutes;
            const end = rem.windowEndMinutes;
            if (start == null || end == null) continue;
            const inWindow =
                start <= end
                    ? minutesSinceMidnight >= start && minutesSinceMidnight <= end
                    : minutesSinceMidnight >= start || minutesSinceMidnight <= end;
            if (!inWindow) continue;
            // Fire on the hour (minute 0-1) within the window.
            if (minutesSinceMidnight % 60 > 1) continue;
            const hourSlot = `${String(Math.floor(minutesSinceMidnight / 60)).padStart(2, "0")}:00`;
            const ok = await fireReminderMessage({
                familyId: rem.familyId,
                recipientUserId: rem.recipientUserId,
                reminder: rem as ISaheliReminder,
                slotKey: hourSlot,
                dateKey,
            });
            if (ok) sent += 1;
        }
    }

    return { sent, scanned };
}
