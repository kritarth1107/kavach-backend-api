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
}): Promise<boolean> {
    const P = await import("./profile/elderProfile.service").catch(() => null);
    const w = { familyId: input.familyId, recipientUserId: input.recipientUserId };
    const tuning = P ? await P.profileTuning(w).catch(() => undefined) : undefined;
    let text = buildCareNudgeText({
        nudgeKind: input.nudgeKind,
        title: input.title,
        time: input.time,
        displayName: input.displayName,
        preferredLanguage: input.preferredLanguage,
        addressAs: tuning?.addressAs,
    });
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
            input.nudgeKind === "daily_schedule"
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
        const gate = await canSendProactiveNudge({ familyId: input.familyId, recipientUserId: input.recipientUserId });
        if (!gate.ok) {
            console.log(`Care nudge deferred (${gate.reason}) for ${input.recipientUserId} (${input.nudgeKind})`);
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
        const gate = await canSendProactiveNudge({ familyId: input.familyId, recipientUserId: input.recipientUserId });
        if (!gate.ok) {
            console.log(`Care nudge dropped at send (${gate.reason}) for ${input.recipientUserId}`);
            await finalizeNudgeAttempt(attemptId, {
                delivered: false,
                channel: target.channel,
                terminal: false,
                reason: `gated:${gate.reason}`,
            });
            return false;
        }
    }
    const delivery = await deliverOutboundMessage({
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

export async function runCareNudgeTick(now = new Date()): Promise<{ sent: number; scanned: number }> {
    const companions = await listEnabledCompanions();
    let sent = 0;
    let scanned = 0;
    const dateKey = toDateKeyIST(now);
    const nowMinutes = getISTParts(now).minutesSinceMidnight;

    for (const companion of companions) {
        if (isWithinQuietHours(companion, now)) continue;

        scanned += 1;
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

        for (const item of day.items) {
            const scheduleMinutes = parseTimeToMinutes(item.time);
            if (scheduleMinutes == null) {
                console.warn(
                    `Skipping nudge — unparseable schedule time "${item.time}" (${item.scheduleId})`,
                );
                continue;
            }

            const minutesUntil = scheduleMinutes - nowMinutes;
            const minutesSince = nowMinutes - scheduleMinutes;

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
        if (missed.length >= 2 && nowMinutes >= 17 * 60) {
            await checkCaregiverAlertsForMissedTasks({
                familyId: companion.familyId,
                recipientUserId: companion.recipientUserId,
                missedCount: missed.length,
                missedTitles: missed.map((m) => m.title),
            });
        }
    }

    return { sent, scanned };
}
