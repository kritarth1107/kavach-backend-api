import AiTenant from "../models/aiTenant.model";
import { CareRecordEventType } from "../types/careRecord.types";
import { companionProfilePayload, getCompanionProfile } from "./saheliCompanion.service";
import { getFamilyMembersList } from "./familyMember.service";
import { listCareRecordEvents } from "./careRecord.service";

export type SaheliMemoryContext = {
    familyId: string;
    recipientUserId: string;
    aiFamilyId: string;
    aiElderId: string;
    companion_profile: Record<string, unknown>;
    family_roster: Array<{ userId: string; name: string; role?: string }>;
    care_record_context: string;
};

export async function buildSaheliMemoryContext(
    familyId: string,
    recipientUserId: string,
): Promise<SaheliMemoryContext | null> {
    const link = await AiTenant.findOne({ familyId }).lean();
    if (!link) return null;
    const elderLink = link.elders.find((e) => e.recipientUserId === recipientUserId);
    if (!elderLink) return null;

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [events, membersPayload, companion] = await Promise.all([
        listCareRecordEvents({ familyId, subjectUserId: recipientUserId, limit: 120 }),
        getFamilyMembersList(familyId, recipientUserId),
        getCompanionProfile(familyId, recipientUserId),
    ]);

    const recent = events.filter((e) => {
        const at = e.at ? new Date(e.at).getTime() : 0;
        return at >= since.getTime();
    });
    const lines: string[] = [];

    for (const e of recent) {
        const payload = (e.payload ?? {}) as Record<string, unknown>;
        if (
            e.type === CareRecordEventType.CHECK_IN &&
            payload.action === "schedule_completed"
        ) {
            lines.push(`Schedule completed: ${e.title} — ${e.detail.slice(0, 120)}`);
        } else if (e.type === CareRecordEventType.DOSE) {
            lines.push(`Medicine dose: ${e.title} — ${e.detail.slice(0, 120)}`);
        } else if (e.type.startsWith("order_")) {
            lines.push(`Order event: ${e.title} — ${e.detail.slice(0, 120)}`);
        } else if (e.type === CareRecordEventType.CHECK_IN) {
            lines.push(`Check-in: ${e.detail.slice(0, 160)}`);
        } else if (e.type === CareRecordEventType.VITAL) {
            lines.push(`Vitals: ${e.detail.slice(0, 120)}`);
        } else if (e.type === CareRecordEventType.DOCUMENT) {
            lines.push(`Lab/document: ${e.title}`);
        }
    }

    return {
        familyId,
        recipientUserId,
        aiFamilyId: link.aiFamilyId,
        aiElderId: elderLink.aiElderId,
        companion_profile: companionProfilePayload(companion),
        family_roster: membersPayload.members
            .filter((m): m is typeof m & { userId: string } => Boolean(m.userId))
            .map((m) => ({
                userId: m.userId,
                name: m.name ?? "Member",
                role: String(m.role),
            })),
        care_record_context: lines.slice(0, 40).join("\n"),
    };
}

export async function buildSaheliMemoryContextByAiIds(
    aiFamilyId: string,
    aiElderId: string,
): Promise<SaheliMemoryContext | null> {
    const link = await AiTenant.findOne({ aiFamilyId }).lean();
    if (!link) return null;
    const elderLink = link.elders.find((e) => e.aiElderId === aiElderId);
    if (!elderLink) return null;
    return buildSaheliMemoryContext(link.familyId, elderLink.recipientUserId);
}
