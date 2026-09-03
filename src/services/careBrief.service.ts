import { appendCareRecordEvent, listCareRecordEvents } from "./careRecord.service";
import { aiPostCareBrief } from "../clients/aiEngine.client";
import { getFamilyMembersList } from "./familyMember.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { getFamilyForActor, requireCareRecipient, requirePermission } from "./careRecordAuth.service";

export async function generateCareBrief(
    familyId: string,
    subjectUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");
    requireCareRecipient(family, subjectUserId);

    const events = await listCareRecordEvents({
        familyId,
        subjectUserId,
        limit: 80,
    });

    const members = await getFamilyMembersList(familyId, actorUserId);
    const subject = members.members.find((m) => m.userId === subjectUserId);
    const subjectName = subject?.name?.trim() || "Care recipient";

    const timeline = events
        .slice()
        .reverse()
        .map((e) => `${e.type}: ${e.title} — ${e.detail.slice(0, 160)}`)
        .join("\n");

    let narrative = "";
    try {
        const result = await aiPostCareBrief({
            subjectName,
            timeline,
        });
        narrative = result.brief;
    } catch {
        narrative = buildFallbackBrief(subjectName, events);
    }

    return {
        subjectName,
        generatedAt: new Date().toISOString(),
        sections: {
            narrative,
            recentSignals: events.filter((e) => e.type === CareRecordEventType.CONTEXT_SIGNAL),
            recentOrders: events.filter((e) => e.type.startsWith("order_")),
            recentDocuments: events.filter((e) => e.type === CareRecordEventType.DOCUMENT),
        },
        eventCount: events.length,
    };
}

function buildFallbackBrief(
    subjectName: string,
    events: Awaited<ReturnType<typeof listCareRecordEvents>>,
): string {
    const lines = [`Care Brief for ${subjectName}`, ""];
    const latestVital = events.find((e) => e.type === CareRecordEventType.VITAL);
    if (latestVital) lines.push(`Latest vitals: ${latestVital.detail}`);
    const latestCheckIn = events.find((e) => e.type === CareRecordEventType.CHECK_IN);
    if (latestCheckIn) lines.push(`Last check-in: ${latestCheckIn.detail}`);
    const signal = events.find((e) => e.type === CareRecordEventType.CONTEXT_SIGNAL);
    if (signal) lines.push(`Context note: ${signal.detail}`);
    lines.push("", "Reported only — nothing invented.");
    return lines.join("\n");
}

export async function logCareBriefGenerated(
    familyId: string,
    subjectUserId: string,
    actorUserId: string,
    briefPreview: string,
) {
    await appendCareRecordEvent({
        familyId,
        subjectUserId,
        actorUserId,
        type: CareRecordEventType.SYSTEM,
        source: CareRecordSource.SYSTEM,
        channel: ChannelType.DASHBOARD,
        title: "Care Brief generated",
        detail: briefPreview.slice(0, 280),
        skipSignalCheck: true,
    });
}
