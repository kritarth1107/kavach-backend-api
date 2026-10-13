import { appendCareRecordEvent, listCareRecordEvents } from "./careRecord.service";
import { aiEngineJson, aiPostDoctorBrief } from "../clients/aiEngine.client";
import { getFamilyMembersList } from "./familyMember.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { getFamilyForActor, requireCareSubject, requirePermission } from "./careRecordAuth.service";

export async function generateCareBrief(
    familyId: string,
    subjectUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");
    requireCareSubject(family, subjectUserId, actorUserId);

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

    // The engine's brief over the care record (trust plan A1: one memory), not the retired Instinct inbox.
    let narrative = "";
    try {
        const report = await aiEngineJson<{ narrative?: string }>(
            "GET",
            `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(subjectUserId)}/report?days=7&name=${encodeURIComponent(subjectName)}`,
            undefined,
            60_000,
        );
        narrative = String(report.narrative || "").trim();
    } catch {
        narrative = "";
    }
    if (!narrative) narrative = buildFallbackBrief(subjectName, events);

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

export async function generateDoctorBrief(
    familyId: string,
    subjectUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");
    requireCareSubject(family, subjectUserId, actorUserId);

    const events = await listCareRecordEvents({
        familyId,
        subjectUserId,
        limit: 100,
    });

    const members = await getFamilyMembersList(familyId, actorUserId);
    const subject = members.members.find((m) => m.userId === subjectUserId);
    const subjectName = subject?.name?.trim() || "Care recipient";

    const timeline = events
        .slice()
        .reverse()
        .map((e) => `${e.at ? new Date(e.at).toISOString().slice(0, 10) : "?"} · ${e.type}: ${e.title} — ${e.detail.slice(0, 160)}`)
        .join("\n");

    // The engine reads the current care record itself (family_id + subject_id); the retired Instinct inbox is not read.
    const staleHealthBlock = "";
    const memoryProfile = "";
    let narrative = "";
    try {
        const result = await aiPostDoctorBrief({
            subjectName,
            timeline,
            staleHealth: staleHealthBlock,
            memoryProfile,
            familyId,
            subjectUserId,
        });
        narrative = result.brief;
    } catch {
        narrative = buildFallbackDoctorBrief(subjectName, events, staleHealthBlock);
    }

    return {
        audience: "doctor" as const,
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

function buildFallbackDoctorBrief(
    subjectName: string,
    events: Awaited<ReturnType<typeof listCareRecordEvents>>,
    staleHealth = "",
): string {
    const lines = [`Doctor brief — ${subjectName}`, "", "Reported only — not a clinical assessment.", ""];
    if (staleHealth.trim()) {
        lines.push("Open health-memory review items:", staleHealth, "");
    }
    const latestVital = events.find((e) => e.type === CareRecordEventType.VITAL);
    if (latestVital) lines.push(`Vitals: ${latestVital.detail}`);
    const latestCheckIn = events.find((e) => e.type === CareRecordEventType.CHECK_IN);
    if (latestCheckIn) lines.push(`Check-in: ${latestCheckIn.detail}`);
    const docs = events.filter((e) => e.type === CareRecordEventType.DOCUMENT).slice(0, 5);
    if (docs.length) {
        lines.push("Documents:");
        for (const d of docs) lines.push(`- ${d.title}`);
    }
    lines.push("", "Gaps: full history not summarized in fallback mode.");
    return lines.join("\n");
}
