import { type SaheliNudgeKind } from "../models/saheliNudgeLog.model";
import { claimNudgeAttempt, finalizeNudgeAttempt } from "./saheliNudgeAttempt.service";
import {
    getScheduleDayStatuses,
    parseTimeToMinutes,
} from "./careScheduleCompletion.service";
import { listEnabledCompanions, isWithinQuietHours } from "./saheliCompanion.service";
import { deliverOutboundMessage, resolveRecipientChannel } from "./channelOutbound.service";
import { getFamilyMembersList } from "./familyMember.service";
import { buildCareNudgeMessages } from "./whatsappMessageComposer.service";
import { buildCareNudgeText } from "./saheliNudgeCopy.service";
import { checkCaregiverAlertsForMissedTasks } from "./saheliCaregiverAlert.service";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";
import { doseSlotKey, noteDueFailed, noteDueHeld, noteDueMissed, noteDueSent } from "./dueList.service";
import { clockNow } from "../utils/clock.util";
import { formatScheduleSection } from "./saheliContext.service";
import { medicineDueWindow } from "./saheliFactGuard.service";

function resolveRecipientName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
): string {
    return members.find((m) => m.userId === recipientUserId)?.name?.trim() || "there";
}

function inWindow(value: number, min: number, max: number): boolean {
    return value >= min && value <= max;
}

async function composeDoseLine(input: { familyId: string; recipientUserId: string; scheduleId: string; title: string; time: string }): Promise<string | null> {
    try {
        const SaheliNudgeLog = (await import("../models/saheliNudgeLog.model")).default;
        const rows = await SaheliNudgeLog.find({ familyId: input.familyId, recipientUserId: input.recipientUserId, scheduleId: input.scheduleId, delivered: true })
            .sort({ lastAttemptAt: -1 })
            .limit(8)
            .select("messagePreview")
            .lean<Array<{ messagePreview?: string }>>();
        const { aiEngineJson } = await import("../clients/aiEngine.client");
        const out = await aiEngineJson<{ text: string | null }>("POST", "/v2/brain/compose-reminder", {
            family_id: input.familyId,
            subject_id: input.recipientUserId,
            purpose: `time for ${input.title} (${input.time})`,
            at: input.time,
            recent: rows.map((r) => String(r.messagePreview ?? "")).filter(Boolean),
            kind: "medicine",
            item: input.title,
        }, 20_000);
        return out?.text?.trim() || null;
    } catch (err) {
        console.warn(`[care-nudge] compose failed, sending the usual text: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/**
 * The reminder's usual text (when no fresh line comes from the engine): the name to use and the names never to use come
 * from the care record (trust plan A1, A3: app/care/naming.py for_person, through the engine, cached 60 s and dropped
 * when it changes), never from the retired Mongo profile.
 */
export async function careNudgeFallbackText(input: {
    familyId: string;
    recipientUserId: string;
    displayName: string;
    title: string;
    time: string;
    nudgeKind: SaheliNudgeKind;
    preferredLanguage?: string;
}): Promise<{ text: string; person: import("../clients/enginePerson.client").EnginePerson }> {
    const { getEnginePerson, withoutAvoidedNames } = await import("../clients/enginePerson.client");
    const person = await getEnginePerson(input.familyId, input.recipientUserId);
    const speech = await import("./voicePreference.service").then((V) => V.getSpeechProfile(input.recipientUserId, input.familyId)).catch(() => null);
    const text = withoutAvoidedNames(buildCareNudgeText({
        nudgeKind: input.nudgeKind,
        title: input.title,
        time: input.time,
        displayName: input.displayName,
        preferredLanguage: input.preferredLanguage,
        speech,
        addressAs: person.name ?? undefined,
    }), person);
    return { text, person };
}

export async function deliverCareNudge(input: {
    familyId: string;
    recipientUserId: string;
    displayName: string;
    scheduleId: string;
    title: string;
    time: string;
    nudgeKind: SaheliNudgeKind;
    dateKey: string;
    preferredChannel: "whatsapp" | "phone" | "dashboard";
    preferredLanguage?: string;
    /** A medicine dose: never held back for recent chat, only for an order in progress (then remembered for later). */
    medicine?: boolean;
}): Promise<boolean> {
    const { withoutAvoidedNames } = await import("../clients/enginePerson.client");
    const fallback = await careNudgeFallbackText(input);
    const person = fallback.person;
    let text = fallback.text;

    const build = () =>
        buildCareNudgeMessages({
            text,
            nudgeKind:
                input.nudgeKind === "daily_schedule" || input.nudgeKind === "dose_due"
                    ? "pre_reminder"
                    : input.nudgeKind === "missed_followup_2"
                      ? "missed_followup"
                      : input.nudgeKind,
            scheduleId: input.scheduleId,
            title: input.title,
            time: input.time,
        });
    let payloads = build();

    const slotKey = {
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        scheduleId: input.scheduleId,
        dateKey: input.dateKey,
        nudgeKind: input.nudgeKind,
    };
    {
        // Nudge gate: quiet ≥60 min + no active job/flow (checked again right before send).
        const { canSendProactiveNudge } = await import("./saheliNudgeGate.service");
        const gate = await canSendProactiveNudge({ familyId: input.familyId, recipientUserId: input.recipientUserId, medicine: input.medicine });
        if (!gate.ok) {
            console.log(`Care nudge deferred (${gate.reason}) for ${input.recipientUserId} (${input.nudgeKind})`);
            if (input.medicine && input.nudgeKind === "dose_due") {
                await rememberHeldDose(input, gate.reason || "gate");
                await noteDueHeld(doseSlotKey(input.scheduleId, input.dateKey), `held: ${gate.reason || "gate"} (sent once clear)`);
            }
            return false;
        }
    }
    if (input.nudgeKind === "dose_due") {
        // A dose reminder is written when it goes out (after the gate, so a held dose costs nothing), never the same line
        // twice (founder 2026-10-13); the medicine's name and time stay exact; the usual text goes out if there is none.
        const fresh = await composeDoseLine(input);
        if (fresh) {
            text = withoutAvoidedNames(fresh, person);
            payloads = build();
        }
    }
    const attemptId = await claimNudgeAttempt(slotKey, text);
    if (!attemptId) {
        return false;
    }

    const target = await resolveRecipientChannel(
        input.familyId,
        input.recipientUserId,
        input.preferredChannel,
    );
    if (!target || target.channel === "dashboard") {
        console.warn(
            `Care nudge skipped — no valid WhatsApp recipient for ${input.recipientUserId} (${input.nudgeKind}); terminal for this window`,
        );
        await finalizeNudgeAttempt(attemptId, {
            delivered: false,
            channel: "dashboard",
            terminal: true,
            reason: "no_valid_recipient",
        });
        if (input.nudgeKind === "dose_due") await noteDueFailed(doseSlotKey(input.scheduleId, input.dateKey), "no WhatsApp number for them");
        return false;
    }

    {
        const { canSendProactiveNudge } = await import("./saheliNudgeGate.service");
        const gate = await canSendProactiveNudge({ familyId: input.familyId, recipientUserId: input.recipientUserId, medicine: input.medicine });
        if (!gate.ok) {
            console.log(`Care nudge dropped at send (${gate.reason}) for ${input.recipientUserId}`);
            if (input.medicine && input.nudgeKind === "dose_due") {
                await rememberHeldDose(input, gate.reason || "gate");
                await noteDueHeld(doseSlotKey(input.scheduleId, input.dateKey), `held: ${gate.reason || "gate"} (sent once clear)`);
            }
            await finalizeNudgeAttempt(attemptId, {
                delivered: false,
                channel: target.channel,
                terminal: false,
                reason: `gated:${gate.reason}`,
            });
            return false;
        }
    }
    // Their WhatsApp chat closed (no message from them in 24 hours): the dose still reaches them as the reminder template,
    // with the same Done button. The day's schedule message has no template; its doses get their own reminders.
    const { clockTime } = await import("./whatsappTemplates.service");
    const template = input.nudgeKind === "daily_schedule"
        ? undefined
        : { purpose: "reminder" as const, params: [input.title, clockTime(input.time)], quickReplyPayloads: [`done:${input.scheduleId}`] };
    const { attemptsOf } = await import("./saheliNudgeAttempt.service");
    // a medicine marked critical: an unanswered streak with it is escalated even in the caregivers' quiet hours (B2.2)
    const critical = input.medicine && input.scheduleId !== "daily_schedule"
        ? Boolean(await import("../models/careSchedule.model").then((M) => M.default.exists({ scheduleId: input.scheduleId, critical: true })).catch(() => null))
        : false;
    const delivery = await deliverOutboundMessage({ purpose: "proactive",
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        content: text,
        channel: target.channel,
        channelIdentifier: target.channelIdentifier,
        whatsappPayloads: payloads,
        ...(template ? { template } : {}),
        delivery: {
            kind: careNudgeDeliveryKind(input.nudgeKind),
            refId: input.nudgeKind === "daily_schedule" ? `schedule:${input.dateKey}` : doseSlotKey(input.scheduleId, input.dateKey),
            nudgeId: attemptId,
            attempt: await attemptsOf(attemptId),
            ...(input.time ? { dueAt: slotTime(input.dateKey, input.time) } : {}),
            ...(critical ? { critical: true } : {}),
        },
    });

    await finalizeNudgeAttempt(attemptId, {
        delivered: delivery.delivered,
        channel: target.channel,
        terminal: delivery.reason === "invalid_recipient",
        reason: delivery.delivered ? undefined : delivery.reason ?? "send_failed",
        wamid: delivery.messageIds?.[0],
    });
    if (input.nudgeKind === "dose_due") {
        // the due list (B1.4): what became of this dose's slot
        const slot = doseSlotKey(input.scheduleId, input.dateKey);
        const attempts = await attemptsOf(attemptId);
        if (delivery.delivered) await noteDueSent(slot, { wamid: delivery.messageIds?.[0], attempts });
        else if (delivery.reason === "paused") await noteDueHeld(slot, "paused (admin console)");
        else await noteDueFailed(slot, delivery.reason ?? "send_failed", attempts);
    }

    if (!delivery.delivered) {
        console.warn(
            `Care nudge delivery failed for ${input.recipientUserId} (${input.nudgeKind})`,
        );
    } else {
        const { logActivity } = await import("./activityLog.service");
        void logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            kind: "nudge",
            title: `Care nudge: ${input.title}`.slice(0, 200),
            detail: text,
            data: {
                source: "care_nudge",
                nudgeKind: input.nudgeKind,
                scheduleId: input.scheduleId,
                scheduledTime: input.time,
                channel: target.channel,
            },
        });
    }
    return delivery.delivered;
}

/** The delivery ledger's kind for a care-schedule send. */
export function careNudgeDeliveryKind(kind: SaheliNudgeKind): import("../models/messageDelivery.model").DeliveryKind {
    switch (kind) {
        case "dose_due":
            return "dose_reminder";
        case "missed_followup":
        case "missed_followup_2":
            return "dose_followup";
        case "pre_reminder":
        case "appointment_prep":
            return "reminder";
        case "daily_schedule":
            return "brief";
        default:
            return "message";
    }
}

/** A dose's slot on the due list: one per medicine time per day. */
export { doseSlotKey } from "./dueList.service";

/** "2026-10-14" + "08:30" (IST) → the moment. */
export function slotTime(dateKey: string, hhmm: string): Date | undefined {
    const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})/);
    if (!m) return undefined;
    const d = new Date(`${dateKey}T${m[1]!.padStart(2, "0")}:${m[2]}:00+05:30`);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

/** The second follow-up goes only after the first went, and at least 30 minutes after it (never two in one minute). */
async function firstFollowupWentAWhileAgo(c: { familyId: string; recipientUserId: string }, scheduleId: string, dateKey: string, now: Date): Promise<boolean> {
    const { default: SaheliNudgeLog } = await import("../models/saheliNudgeLog.model");
    const first = await SaheliNudgeLog.findOne({ familyId: c.familyId, recipientUserId: c.recipientUserId, scheduleId, dateKey, nudgeKind: "missed_followup", delivered: true },
        { lastAttemptAt: 1, createdAt: 1 }).lean<{ lastAttemptAt?: Date; createdAt?: Date }>().catch(() => null);
    const at = first?.lastAttemptAt ?? first?.createdAt;
    return Boolean(at) && now.getTime() - new Date(at!).getTime() >= 30 * 60_000;
}

/** A medicine dose reminder the gate held back (an order in progress): remembered so the catch-up sends it once clear. */
async function rememberHeldDose(input: { familyId: string; recipientUserId: string; scheduleId: string; dateKey: string }, reason: string) {
    try {
        const { NudgeDeferral } = await import("../models/schedulerHeartbeat.model");
        await NudgeDeferral.updateOne(
            { familyId: input.familyId, recipientUserId: input.recipientUserId, dateKey: input.dateKey, scheduleId: input.scheduleId },
            { $setOnInsert: { reason, at: new Date() } },
            { upsert: true },
        );
    } catch (err) {
        console.warn("could not remember a held-back dose:", err instanceof Error ? err.message : err);
    }
}

/** Record this tick; returns today's gaps (minutes when reminders were not running). */
async function noteTick(now: Date): Promise<Array<{ from: Date; to: Date }>> {
    try {
        const { nextHeartbeat } = await import("./reminderCatchUp.service");
        const { default: HB } = await import("../models/schedulerHeartbeat.model");
        const prev = (await HB.findById("care-nudge").lean()) as { lastTickAt?: Date; gaps?: Array<{ from: Date; to: Date }> } | null;
        const next = nextHeartbeat(prev, now);
        await HB.updateOne({ _id: "care-nudge" }, { $set: next }, { upsert: true });
        if (prev?.lastTickAt && next.gaps.length > (prev.gaps?.length ?? 0)) {
            console.warn(`Reminder tick was not running from ${new Date(prev.lastTickAt).toISOString()} to ${now.toISOString()}: catching up`);
        }
        return next.gaps;
    } catch (err) {
        console.warn("reminder heartbeat failed:", err instanceof Error ? err.message : err);
        return [];
    }
}

type CatchUpInput = {
    gaps: Array<{ from: Date; to: Date }>;
    companion: NudgeTarget;
    items: Awaited<ReturnType<typeof getScheduleDayStatuses>>["items"];
    nowMinutes: number;
    dateKey: string;
    displayName: string;
    preferredLanguage: string;
};

/**
 * Doses whose reminder never went out: a little late → the normal reminder; 15–90 min → one combined "sorry, a little
 * late" message, sent under the missed follow-up so nothing chases it; later (or the next dose is near) → no message,
 * noted for the caregiver (dashboard activity) and in Saheli's ledger.
 */
async function catchUpMissedDoses(input: CatchUpInput): Promise<{ sent: number; handled: Set<string> }> {
    const { planCatchUp, lateDoseText, doseAt, inGap } = await import("./reminderCatchUp.service");
    const { default: SaheliNudgeLog } = await import("../models/saheliNudgeLog.model");
    const { NudgeDeferral } = await import("../models/schedulerHeartbeat.model");
    const { companion: c, dateKey } = input;
    const handled = new Set<string>();
    const held = new Set<string>(
        (await NudgeDeferral.distinct("scheduleId", { familyId: c.familyId, recipientUserId: c.recipientUserId, dateKey })).map(String),
    );
    if (!held.size && !input.gaps.length) return { sent: 0, handled }; // nothing was missed today: the usual case
    const attempted = new Set<string>(
        (await SaheliNudgeLog.distinct("scheduleId", {
            familyId: c.familyId, recipientUserId: c.recipientUserId, dateKey,
            nudgeKind: { $in: ["dose_due", "pre_reminder", "missed_followup", "missed_followup_2"] },
        })).map(String),
    );
    const plan = planCatchUp({
        items: input.items,
        nowMinutes: input.nowMinutes,
        attempted,
        parse: parseTimeToMinutes,
        missedBecause: (item) => {
            const at = parseTimeToMinutes(item.time);
            if (at != null && inGap(input.gaps, doseAt(dateKey, at))) return "down";
            return held.has(item.scheduleId) ? "held" : null;
        },
        createdTodayAt: (item) => {
            if (!item.createdAt) return null;
            const at = new Date(item.createdAt);
            return toDateKeyIST(at) === dateKey ? getISTParts(at).minutesSinceMidnight : null;
        },
    });
    let sent = 0;

    for (const item of plan.onTime) {
        handled.add(item.scheduleId);
        const ok = await deliverCareNudge({
            familyId: c.familyId, recipientUserId: c.recipientUserId, displayName: input.displayName, scheduleId: item.scheduleId,
            title: item.title, time: item.time, nudgeKind: "dose_due", dateKey, preferredChannel: c.preferredChannel,
            preferredLanguage: input.preferredLanguage, medicine: true,
        });
        if (ok) sent += 1;
    }

    if (plan.late.length) {
        const { canSendProactiveNudge } = await import("./saheliNudgeGate.service");
        const gate = await canSendProactiveNudge({ familyId: c.familyId, recipientUserId: c.recipientUserId, medicine: true });
        if (!gate.ok) {
            // an order or login page is open: try again next minute (until it is too late, then it is noted)
            for (const item of plan.late) handled.add(item.scheduleId);
            plan.late = [];
        }
    }
    if (plan.late.length) {
        const claims: Array<{ id: string; item: (typeof plan.late)[number] }> = [];
        for (const item of plan.late) {
            handled.add(item.scheduleId);
            const id = await claimNudgeAttempt(
                { familyId: c.familyId, recipientUserId: c.recipientUserId, scheduleId: item.scheduleId, dateKey, nudgeKind: "missed_followup" },
                `late reminder: ${item.title} ${item.time}`,
            );
            if (id) claims.push({ id, item });
        }
        if (claims.length) {
            const hindi = /hindi|hinglish/i.test(input.preferredLanguage);
            const text = lateDoseText(claims.map((x) => x.item), input.displayName, hindi);
            const target = await resolveRecipientChannel(c.familyId, c.recipientUserId, c.preferredChannel);
            const { clockTime } = await import("./whatsappTemplates.service");
            const one = claims.length === 1 ? claims[0]!.item : null;
            const template = {
                purpose: "reminder" as const,
                params: [claims.map((x) => x.item.title).join(", "), clockTime(claims[0]!.item.time)],
                ...(one ? { quickReplyPayloads: [`done:${one.scheduleId}`] } : {}),
            };
            const first = claims[0]!;
            const delivery: { delivered: boolean; channel: string; reason?: string; messageIds?: string[] } = target && target.channel !== "dashboard"
                ? await deliverOutboundMessage({ purpose: "proactive", familyId: c.familyId, recipientUserId: c.recipientUserId, content: text,
                                                 channel: target.channel, channelIdentifier: target.channelIdentifier, template,
                                                 delivery: { kind: "dose_followup", refId: doseSlotKey(first.item.scheduleId, dateKey), nudgeId: first.id,
                                                             dueAt: slotTime(dateKey, first.item.time) } })
                : { delivered: false, channel: "dashboard" as const, reason: "invalid_recipient" as const };
            for (const x of claims) {
                await finalizeNudgeAttempt(x.id, {
                    delivered: delivery.delivered, channel: delivery.channel,
                    terminal: !delivery.delivered, reason: delivery.delivered ? undefined : `late_reminder_${delivery.reason ?? "failed"}`,
                    messagePreview: text,
                    ...(x === first ? { wamid: delivery.messageIds?.[0] } : {}),
                });
                const slot = doseSlotKey(x.item.scheduleId, dateKey);
                if (delivery.delivered) await noteDueSent(slot, { wamid: x === first ? delivery.messageIds?.[0] : undefined, late: true });
                else await noteDueFailed(slot, `late reminder: ${delivery.reason ?? "failed"}`);
            }
            if (delivery.delivered) sent += 1;
        }
    }

    for (const item of plan.tooLate) {
        handled.add(item.scheduleId);
        // claimed so it is noted once; terminal, so nothing tries to send it later
        const id = await claimNudgeAttempt(
            { familyId: c.familyId, recipientUserId: c.recipientUserId, scheduleId: item.scheduleId, dateKey, nudgeKind: "missed_followup" },
            `not sent (Kavach was down): ${item.title} ${item.time}`,
        );
        if (!id) continue;
        await finalizeNudgeAttempt(id, { delivered: false, channel: "dashboard", terminal: true, reason: `missed_while_down: ${item.why}` });
        await noteDueMissed(doseSlotKey(item.scheduleId, dateKey), `Kavach was down; not sent late (${item.why})`);
        void import("./activityLog.service").then(({ logActivity }) =>
            logActivity({
                familyId: c.familyId, recipientUserId: c.recipientUserId, kind: "reminder",
                title: `Reminder not sent: ${item.title} (${item.time})`,
                detail: `Kavach was down when this reminder was due, and ${item.why}, so Saheli did not send it late (a late reminder ` +
                        `could lead to a double dose). Please check whether it was taken.`,
            }),
        ).catch(() => undefined);
    }
    return { sent, handled };
}

export async function runCareNudgeTick(now = clockNow()): Promise<{ sent: number; scanned: number }> {
    const gaps = await noteTick(now);
    const companions = await listEnabledCompanions();
    let sent = 0;
    let scanned = 0;
    const dateKey = toDateKeyIST(now);
    const nowMinutes = getISTParts(now).minutesSinceMidnight;

    for (const companion of companions) {
        if (isWithinQuietHours(companion, now)) {
            const { holdRecentDoses } = await import("./dueList.service");
            await holdRecentDoses(companion.familyId, companion.recipientUserId, "quiet hours", now);
            continue;
        }

        scanned += 1;
        try {
            const one = await nudgeOneCompanion(companion, now, dateKey, nowMinutes, { gaps });
            sent += one;
        } catch (err) {
            console.warn(
                `Care nudge skipped for ${companion.recipientUserId}:`,
                err instanceof Error ? err.message : err,
            );
        }
    }

    // Self care: caregivers who keep their own schedule get the same dose reminders, gently, with no family alerts.
    try {
        for (const target of await listSelfCareTargets()) {
            if (isQuietHourIST(nowMinutes)) {
                const { holdRecentDoses } = await import("./dueList.service");
                await holdRecentDoses(target.familyId, target.recipientUserId, "quiet hours (22:00-07:00)", now);
                continue;
            }
            scanned += 1;
            try {
                sent += await nudgeOneCompanion(target, now, dateKey, nowMinutes, { selfCare: true, gaps });
            } catch (err) {
                console.warn(`Self-care nudge skipped for ${target.recipientUserId}:`, err instanceof Error ? err.message : err);
            }
        }
    } catch (err) {
        console.warn("Self-care nudge scan failed:", err instanceof Error ? err.message : err);
    }

    return { sent, scanned };
}

function isQuietHourIST(nowMinutes: number): boolean {
    return nowMinutes >= 22 * 60 || nowMinutes < 7 * 60;
}

/** Caregivers (primary or co) with active schedule rows about themselves. */
export async function listSelfCareTargets(): Promise<NudgeTarget[]> {
    const CareSchedule = (await import("../models/careSchedule.model")).default;
    const Family = (await import("../models/family.model")).default;
    const { FamilyRole, FamilyMemberStatus } = await import("../types/family.types");
    const rows = (await CareSchedule.aggregate([
        { $match: { active: true } },
        { $group: { _id: { familyId: "$familyId", recipientUserId: "$recipientUserId" } } },
    ])) as Array<{ _id: { familyId: string; recipientUserId: string } }>;
    const byFamily = new Map<string, string[]>();
    for (const r of rows) byFamily.set(r._id.familyId, [...(byFamily.get(r._id.familyId) ?? []), r._id.recipientUserId]);
    const out: NudgeTarget[] = [];
    const { default: SaheliCompanion } = await import("../models/saheliCompanion.model");
    for (const [familyId, userIds] of byFamily) {
        const family = await Family.findOne({ familyId, status: "ACTIVE" }).lean();
        if (!family) continue;
        for (const userId of userIds) {
            const m = family.members.find((x) => x.userId === userId && x.status === FamilyMemberStatus.JOINED);
            if (m && (m.role === FamilyRole.PRIMARY_CAREGIVER || m.role === FamilyRole.CO_CAREGIVER)) {
                // their own setting (trust plan B2.4: no longer always gentle); gentle when they never chose
                const own = await SaheliCompanion.findOne({ familyId, recipientUserId: userId }, { nudgeIntensity: 1, preferredLanguage: 1, preferredChannel: 1 })
                    .lean<{ nudgeIntensity?: NudgeTarget["nudgeIntensity"]; preferredLanguage?: NudgeTarget["preferredLanguage"]; preferredChannel?: NudgeTarget["preferredChannel"] }>()
                    .catch(() => null);
                out.push({ familyId, recipientUserId: userId, nudgeIntensity: own?.nudgeIntensity ?? "gentle", preferredLanguage: own?.preferredLanguage ?? "english",
                    preferredChannel: own?.preferredChannel ?? "whatsapp" });
            }
        }
    }
    return out;
}

type NudgeTarget = Pick<
    Awaited<ReturnType<typeof listEnabledCompanions>>[number],
    "familyId" | "recipientUserId" | "nudgeIntensity" | "preferredLanguage" | "preferredChannel"
>;

async function nudgeOneCompanion(
    companion: NudgeTarget,
    _now: Date,
    dateKey: string,
    nowMinutes: number,
    opts: { selfCare?: boolean; gaps?: Array<{ from: Date; to: Date }> } = {},
): Promise<number> {
    let sent = 0;
        const day = await getScheduleDayStatuses(
            companion.familyId,
            companion.recipientUserId,
            companion.recipientUserId,
            dateKey,
        );

        const members = await getFamilyMembersList(
            companion.familyId,
            companion.recipientUserId,
        );
        const displayName = resolveRecipientName(members.members, companion.recipientUserId);
        const intensity = companion.nudgeIntensity ?? "standard";
        const preferredLanguage = companion.preferredLanguage ?? "english";

        const upcomingToday = day.items.filter(
            (i) => i.status === "upcoming" || i.status === "due",
        );
        // The day's schedule goes at 07:30 IST (the engine's regular nudges learn each person's hours, trust plan A5).
        const winStart = 7 * 60 + 30;
        if (
            inWindow(nowMinutes, winStart, winStart + 60) &&
            upcomingToday.length > 0
        ) {
            const scheduleBody = formatScheduleSection(upcomingToday.slice(0, 8), "Today");
            const ok = await deliverCareNudge({
                familyId: companion.familyId,
                recipientUserId: companion.recipientUserId,
                displayName,
                scheduleId: "daily_schedule",
                title: scheduleBody,
                time: "",
                nudgeKind: "daily_schedule",
                dateKey,
                preferredChannel: companion.preferredChannel,
                preferredLanguage,
            });
            if (ok) sent += 1;
        }

        // Reminders the backend missed while it was down or restarting (see reminderCatchUp.service).
        const caught = await catchUpMissedDoses({
            gaps: opts.gaps ?? [], companion, items: day.items, nowMinutes, dateKey, displayName, preferredLanguage,
        }).catch((err) => {
            console.warn(`Reminder catch-up failed for ${companion.recipientUserId}:`, err instanceof Error ? err.message : err);
            return { sent: 0, handled: new Set<string>() };
        });
        sent += caught.sent;

        for (const item of day.items) {
            if (caught.handled.has(item.scheduleId)) continue;
            const scheduleMinutes = parseTimeToMinutes(item.time);
            if (scheduleMinutes == null) {
                console.warn(
                    `Skipping nudge — unparseable schedule time "${item.time}" (${item.scheduleId})`,
                );
                continue;
            }

            const minutesUntil = scheduleMinutes - nowMinutes;
            const minutesSince = nowMinutes - scheduleMinutes;
            const due = medicineDueWindow(minutesSince, item.status);
            if (item.type === "MEDICINE" && item.status === "completed" && minutesSince >= 0 && minutesSince <= 4) {
                // marked taken before its reminder: not needed, held by rule (shown in the report, never alerted)
                await noteDueHeld(doseSlotKey(item.scheduleId, dateKey), "already marked taken");
            }

            if (due === "dose_due" && item.type === "MEDICINE") {
                const ok = await deliverCareNudge({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    displayName,
                    scheduleId: item.scheduleId,
                    title: item.title,
                    time: item.time,
                    nudgeKind: "dose_due",
                    dateKey,
                    preferredChannel: companion.preferredChannel,
                    preferredLanguage,
                    medicine: true,
                });
                if (ok) sent += 1;
            }

            if (item.status === "upcoming" && inWindow(minutesUntil, 5, 20)) {
                const ok = await deliverCareNudge({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    displayName,
                    scheduleId: item.scheduleId,
                    title: item.title,
                    time: item.time,
                    nudgeKind: "pre_reminder",
                    dateKey,
                    preferredChannel: companion.preferredChannel,
                    preferredLanguage,
                });
                if (ok) sent += 1;
            }

            if (
                intensity !== "gentle" &&
                (item.status === "missed" || item.status === "due") &&
                inWindow(minutesSince, 15, 60)
            ) {
                const ok = await deliverCareNudge({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    displayName,
                    scheduleId: item.scheduleId,
                    title: item.title,
                    time: item.time,
                    nudgeKind: "missed_followup",
                    dateKey,
                    preferredChannel: companion.preferredChannel,
                    preferredLanguage,
                    medicine: item.type === "MEDICINE",
                });
                if (ok) sent += 1;
            }

            if (
                intensity === "persistent" &&
                (item.status === "missed" || item.status === "due") &&
                inWindow(minutesSince, 55, 95) &&
                (await firstFollowupWentAWhileAgo(companion, item.scheduleId, dateKey, _now))
            ) {
                // the second follow-up has its own slot (trust plan B2.4): under the first's slot key it never sent
                const ok = await deliverCareNudge({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    displayName,
                    scheduleId: item.scheduleId,
                    title: item.title,
                    time: item.time,
                    nudgeKind: "missed_followup_2",
                    dateKey,
                    preferredChannel: companion.preferredChannel,
                    preferredLanguage,
                    medicine: item.type === "MEDICINE",
                });
                if (ok) sent += 1;
            }

            if (
                item.type === "APPOINTMENT" &&
                item.status === "upcoming" &&
                inWindow(minutesUntil, 25, 70)
            ) {
                const ok = await deliverCareNudge({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    displayName,
                    scheduleId: item.scheduleId,
                    title: item.title,
                    time: item.time,
                    nudgeKind: "appointment_prep",
                    dateKey,
                    preferredChannel: companion.preferredChannel,
                    preferredLanguage,
                });
                if (ok) sent += 1;
            }

            if (
                item.status === "completed" &&
                item.type === "MEDICINE" &&
                inWindow(minutesSince, 0, 20)
            ) {
                const ok = await deliverCareNudge({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    displayName,
                    scheduleId: item.scheduleId,
                    title: item.title,
                    time: item.time,
                    nudgeKind: "completion_praise",
                    dateKey,
                    preferredChannel: companion.preferredChannel,
                    preferredLanguage,
                });
                if (ok) sent += 1;
            }
        }

        const missed = day.items.filter((i) => i.status === "missed" || i.status === "due");
        // A caregiver's own self care never alerts the rest of the family.
        if (!opts.selfCare && missed.length >= 2 && nowMinutes >= 17 * 60) {
            await checkCaregiverAlertsForMissedTasks({
                familyId: companion.familyId,
                recipientUserId: companion.recipientUserId,
                missedCount: missed.length,
                missedTitles: missed.map((m) => m.title),
            });
        }
    return sent;
}
