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
    const P = await import("./profile/elderProfile.service").catch(() => null);
    const w = { familyId: input.familyId, recipientUserId: input.recipientUserId };
    const tuning = P ? await P.profileTuning(w).catch(() => undefined) : undefined;
    const avoidMaa = Boolean((tuning as { avoidMaa?: boolean } | undefined)?.avoidMaa);
    let text = buildCareNudgeText({
        nudgeKind: input.nudgeKind,
        title: input.title,
        time: input.time,
        displayName: input.displayName,
        preferredLanguage: input.preferredLanguage,
        addressAs: avoidMaa ? undefined : tuning?.addressAs,
    });
    if (avoidMaa) {
        const { stripMaa } = await import("./saheliFactGuard.service");
        text = stripMaa(text);
    }
    // Evolving profile: ONE care line from today's care actions (follow up on her knee, ask about
    // her walk, a sip of water) — like her own child remembering yesterday. Offers stay offers.
    if (input.nudgeKind === "daily_schedule" && P) {
        const care = await P.takeCareLine(w).catch(() => "");
        if (care) text = `${text}\n\n${care}`;
    }
    // Instinct: a due usual (medicine top-up / milk) rides inside the once-a-day schedule
    // message — no extra nudge, no question ending.
    if (input.nudgeKind === "daily_schedule") {
        const line = await import("./commerceAutomation/usuals/usuals.service")
            .then((U) => U.reorderOfferLine({ familyId: input.familyId, recipientUserId: input.recipientUserId }, input.preferredLanguage))
            .catch(() => "");
        if (line) text = `${text}\n\n${line}`;
    }

    const payloads = buildCareNudgeMessages({
        text,
        nudgeKind:
            input.nudgeKind === "daily_schedule" || input.nudgeKind === "dose_due"
                ? "pre_reminder"
                : input.nudgeKind,
        scheduleId: input.scheduleId,
        title: input.title,
        time: input.time,
    });

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
            if (input.medicine && input.nudgeKind === "dose_due") await rememberHeldDose(input, gate.reason || "gate");
            return false;
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
        return false;
    }

    {
        const { canSendProactiveNudge } = await import("./saheliNudgeGate.service");
        const gate = await canSendProactiveNudge({ familyId: input.familyId, recipientUserId: input.recipientUserId, medicine: input.medicine });
        if (!gate.ok) {
            console.log(`Care nudge dropped at send (${gate.reason}) for ${input.recipientUserId}`);
            if (input.medicine && input.nudgeKind === "dose_due") await rememberHeldDose(input, gate.reason || "gate");
            await finalizeNudgeAttempt(attemptId, {
                delivered: false,
                channel: target.channel,
                terminal: false,
                reason: `gated:${gate.reason}`,
            });
            return false;
        }
    }
    const delivery = await deliverOutboundMessage({ purpose: "proactive",
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        content: text,
        channel: target.channel,
        channelIdentifier: target.channelIdentifier,
        whatsappPayloads: payloads,
    });

    await finalizeNudgeAttempt(attemptId, {
        delivered: delivery.delivered,
        channel: target.channel,
        terminal: delivery.reason === "invalid_recipient",
        reason: delivery.delivered ? undefined : delivery.reason ?? "send_failed",
    });

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
            nudgeKind: { $in: ["dose_due", "pre_reminder", "missed_followup"] },
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
            const delivery = target && target.channel !== "dashboard"
                ? await deliverOutboundMessage({ purpose: "proactive", familyId: c.familyId, recipientUserId: c.recipientUserId, content: text,
                                                 channel: target.channel, channelIdentifier: target.channelIdentifier })
                : { delivered: false, channel: "dashboard" as const, reason: "invalid_recipient" as const };
            for (const x of claims) {
                await finalizeNudgeAttempt(x.id, {
                    delivered: delivery.delivered, channel: delivery.channel,
                    terminal: !delivery.delivered, reason: delivery.delivered ? undefined : `late_reminder_${delivery.reason ?? "failed"}`,
                    messagePreview: text,
                });
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

export async function runCareNudgeTick(now = new Date()): Promise<{ sent: number; scanned: number }> {
    const gaps = await noteTick(now);
    const companions = await listEnabledCompanions();
    let sent = 0;
    let scanned = 0;
    const dateKey = toDateKeyIST(now);
    const nowMinutes = getISTParts(now).minutesSinceMidnight;

    for (const companion of companions) {
        if (isWithinQuietHours(companion, now)) continue;

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
            if (isQuietHourIST(nowMinutes)) break;
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
    for (const [familyId, userIds] of byFamily) {
        const family = await Family.findOne({ familyId, status: "ACTIVE" }).lean();
        if (!family) continue;
        for (const userId of userIds) {
            const m = family.members.find((x) => x.userId === userId && x.status === FamilyMemberStatus.JOINED);
            if (m && (m.role === FamilyRole.PRIMARY_CAREGIVER || m.role === FamilyRole.CO_CAREGIVER)) {
                out.push({ familyId, recipientUserId: userId, nudgeIntensity: "gentle", preferredLanguage: "english", preferredChannel: "whatsapp" });
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
        // Learned tuning: send the day's schedule around the hour she actually replies (6–11 IST).
        const pref = await import("./profile/elderProfile.service")
            .then((P) => P.profileTuning({ familyId: companion.familyId, recipientUserId: companion.recipientUserId }))
            .then((t) => t?.preferredNudgeHour)
            .catch(() => undefined);
        const winStart = pref && pref >= 6 && pref <= 11 ? pref * 60 : 7 * 60 + 30;
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
                inWindow(minutesSince, 55, 95)
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
