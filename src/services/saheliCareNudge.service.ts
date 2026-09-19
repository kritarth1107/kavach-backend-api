import { randomUUID } from "crypto";
import SaheliNudgeLog, { type SaheliNudgeKind } from "../models/saheliNudgeLog.model";
import {
    getScheduleDayStatuses,
    parseTimeToMinutes,
} from "./careScheduleCompletion.service";
import { listEnabledCompanions, isWithinQuietHours } from "./saheliCompanion.service";
import { deliverOutboundMessage, resolveRecipientChannel } from "./channelOutbound.service";
import { getFamilyMembersList } from "./familyMember.service";
import { buildCareNudgeMessages } from "./whatsappMessageComposer.service";
import { checkCaregiverAlertsForMissedTasks } from "./saheliCaregiverAlert.service";
import { getISTParts, toDateKeyIST } from "../utils/istTime.util";

function resolveRecipientName(
    members: Awaited<ReturnType<typeof getFamilyMembersList>>["members"],
    recipientUserId: string,
): string {
    return members.find((m) => m.userId === recipientUserId)?.name?.trim() || "there";
}

async function nudgeAlreadySent(input: {
    familyId: string;
    recipientUserId: string;
    scheduleId: string;
    dateKey: string;
    nudgeKind: SaheliNudgeKind;
}): Promise<boolean> {
    const existing = await SaheliNudgeLog.findOne({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        scheduleId: input.scheduleId,
        dateKey: input.dateKey,
        nudgeKind: input.nudgeKind,
    }).lean();
    return Boolean(existing);
}

async function recordNudge(input: {
    familyId: string;
    recipientUserId: string;
    scheduleId?: string;
    dateKey: string;
    nudgeKind: SaheliNudgeKind;
    delivered: boolean;
    channel: string;
    messagePreview: string;
}) {
    try {
        await SaheliNudgeLog.create({
            nudgeId: randomUUID(),
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            scheduleId: input.scheduleId,
            dateKey: input.dateKey,
            nudgeKind: input.nudgeKind,
            delivered: input.delivered,
            channel: input.channel,
            messagePreview: input.messagePreview.slice(0, 200),
        });
    } catch {
        // duplicate nudge for same slot
    }
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
}): Promise<boolean> {
    if (
        await nudgeAlreadySent({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            scheduleId: input.scheduleId,
            dateKey: input.dateKey,
            nudgeKind: input.nudgeKind,
        })
    ) {
        return false;
    }

    const text =
        input.nudgeKind === "pre_reminder"
            ? `Reminder: ${input.title} at ${input.time} is coming up soon.`
            : input.nudgeKind === "missed_followup"
              ? `Just checking — did you get a chance to do ${input.title} (${input.time})?`
              : input.nudgeKind === "completion_praise"
                ? `Well done on completing ${input.title} today.`
                : `Reminder: ${input.title} at ${input.time}.`;

    const payloads = buildCareNudgeMessages({
        text,
        nudgeKind: input.nudgeKind,
        scheduleId: input.scheduleId,
        title: input.title,
        time: input.time,
    });

    const target = await resolveRecipientChannel(
        input.familyId,
        input.recipientUserId,
        input.preferredChannel,
    );
    if (!target || target.channel === "dashboard") {
        await recordNudge({
            ...input,
            delivered: false,
            channel: "dashboard",
            messagePreview: text,
        });
        return false;
    }

    const delivery = await deliverOutboundMessage({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        content: text,
        channel: target.channel,
        channelIdentifier: target.channelIdentifier,
        whatsappPayloads: payloads,
    });

    await recordNudge({
        ...input,
        delivered: delivery.delivered,
        channel: target.channel,
        messagePreview: text,
    });
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

        for (const item of day.items) {
            const scheduleMinutes = parseTimeToMinutes(item.time);
            if (scheduleMinutes == null) continue;

            if (item.status === "upcoming" && scheduleMinutes - nowMinutes === 15) {
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
                });
                if (ok) sent += 1;
            }

            if (
                (item.status === "missed" || item.status === "due") &&
                nowMinutes - scheduleMinutes >= 30 &&
                nowMinutes - scheduleMinutes <= 45
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
                });
                if (ok) sent += 1;
            }

            if (item.status === "completed" && item.type === "MEDICINE") {
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
