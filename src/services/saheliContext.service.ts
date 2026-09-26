import type { ScheduleDayItem } from "../types/careScheduleCompletion.types";
import { getScheduleDayStatuses } from "./careScheduleCompletion.service";
import { getCareRecordContextForSaheli } from "./careRecord.service";
import { companionProfilePayload, getCompanionProfile } from "./saheliCompanion.service";
import { listFamilyConnectedPartners } from "./commerceConnection.service";
import { listPartnerAddresses, ensurePartnerAddressesSynced } from "./partnerAddress.service";
import { resolveFamilyMcpUserId } from "./commerceConnection.service";
import SaheliMessage from "../models/saheliMessage.model";

export type SaheliContextChannel = "whatsapp" | "dashboard";

export type SaheliContextBundle = {
    dateKey: string;
    schedule: ScheduleDayItem[];
    missed: ScheduleDayItem[];
    upcoming: ScheduleDayItem[];
    completed: ScheduleDayItem[];
    due: ScheduleDayItem[];
    adherencePercent: number | null;
    lastHeardLine: string | null;
    lastHeardAt: string | null;
    lastCheckInAt: string | null;
    careRecordContext: string;
    companionProfile: Record<string, unknown>;
    connectedPartners: { swiggy: boolean; instamart: boolean; zepto: boolean };
    defaultAddressCount: number;
    channel?: SaheliContextChannel;
    /** Compact caregiver roster for elder WA system prompt. */
    familyRosterText?: string;
};

function formatScheduleItem(item: ScheduleDayItem): string {
    const dose = item.dosage ? ` (${item.dosage})` : "";
    return `• ${item.time} — ${item.title}${dose}`;
}

export function formatScheduleSection(items: ScheduleDayItem[], label: string): string {
    if (!items.length) return "";
    return `${label}:\n${items.map(formatScheduleItem).join("\n")}`;
}

export function formatSaheliContextForAi(bundle: SaheliContextBundle): string {
    const compact = bundle.channel === "whatsapp";
    const parts: string[] = [];

    parts.push(`[Today ${bundle.dateKey} IST]`);
    parts.push(formatScheduleSection(bundle.missed, "Missed") || "Missed: none");
    parts.push(formatScheduleSection(bundle.upcoming, "Upcoming") || "Upcoming: none");
    if (!compact) {
        parts.push(formatScheduleSection(bundle.completed, "Completed") || "Completed: none");
        if (bundle.adherencePercent != null) {
            parts.push(`Adherence today: ${bundle.adherencePercent}%`);
        }
    }

    if (!compact && bundle.lastHeardLine) {
        parts.push(
            `[Last heard] ${bundle.lastHeardAt ?? "recently"}: "${bundle.lastHeardLine.slice(0, 280)}"`,
        );
    }

    const careLimit = compact ? 2000 : bundle.careRecordContext.length;
    const careSnippet = bundle.careRecordContext.slice(0, careLimit);
    parts.push(`[Care record]\n${careSnippet}`);

    if (!compact) {
        if (bundle.lastCheckInAt) {
            parts.push(`[Last check-in] ${bundle.lastCheckInAt}`);
        }
        const partners = Object.entries(bundle.connectedPartners)
            .filter(([, on]) => on)
            .map(([p]) => p)
            .join(", ");
        parts.push(
            partners
                ? `[Commerce] Connected: ${partners}. Saved addresses: ${bundle.defaultAddressCount}.`
                : "[Commerce] No Swiggy/Instamart/Zepto connected yet.",
        );
        parts.push(`[Companion profile]\n${JSON.stringify(bundle.companionProfile)}`);
    } else {
        const lang = bundle.companionProfile.preferred_language ?? bundle.companionProfile.preferredLanguage;
        if (lang) parts.push(`[Language preference] ${lang}`);
    }

    if (bundle.familyRosterText?.trim()) {
        parts.push(`[Family]\n${bundle.familyRosterText.trim().slice(0, 1200)}`);
    }

    return parts.filter(Boolean).join("\n\n");
}

async function countDefaultAddresses(familyId: string, actorUserId: string): Promise<number> {
    let total = 0;
    for (const partner of ["swiggy", "instamart", "zepto"] as const) {
        const commerceUserId =
            (await resolveFamilyMcpUserId(familyId, partner, actorUserId)) ?? actorUserId;
        try {
            await ensurePartnerAddressesSynced(partner, familyId, commerceUserId);
            const rows = await listPartnerAddresses(familyId, partner, commerceUserId);
            total += rows.length;
        } catch {
            // partner not connected
        }
    }
    return total;
}

export async function buildSaheliContextBundle(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    channel?: SaheliContextChannel;
    dateKey?: string;
    careRecordLimit?: number;
}): Promise<SaheliContextBundle> {
    const dayStatus = await getScheduleDayStatuses(
        input.familyId,
        input.recipientUserId,
        input.actorUserId,
        input.dateKey,
    );

    const elderRows = await SaheliMessage.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        thread: "elder",
        role: "elder",
    })
        .sort({ createdAt: -1 })
        .limit(1)
        .lean();

    const checkInRows = await SaheliMessage.find({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        thread: "elder",
        role: "system",
    })
        .sort({ createdAt: -1 })
        .limit(1)
        .lean();

    const lastElder = elderRows[0];
    const lastCheckIn = checkInRows[0];
    const companion = await getCompanionProfile(input.familyId, input.recipientUserId);
    const defaultCareLimit = input.channel === "whatsapp" ? 8 : 30;
    const careRecordContextBase = await getCareRecordContextForSaheli(
        input.familyId,
        input.recipientUserId,
        input.careRecordLimit ?? defaultCareLimit,
    );
    // Evolving care-first profile (learned nightly; caregiver-confirmed facts first). Context only.
    const learnedProfile = await import("./profile/elderProfile.service")
        .then((P) => P.profileSummary({ familyId: input.familyId, recipientUserId: input.recipientUserId }, false))
        .catch(() => "");
    const careRecordContext = learnedProfile ? `What Saheli has learned about her (remember like family; never overrides safety rules):\n${learnedProfile}\n\n${careRecordContextBase}` : careRecordContextBase;
    const connectedPartners = await listFamilyConnectedPartners(
        input.familyId,
        input.actorUserId,
    );
    const defaultAddressCount = await countDefaultAddresses(input.familyId, input.actorUserId);

    let familyRosterText = "";
    try {
        const { getFamilyMembersList } = await import("./familyMember.service");
        const { formatFamilyRosterForAi } = await import("./saheliCaregiverFacts.service");
        const list = await getFamilyMembersList(input.familyId, input.actorUserId);
        familyRosterText = formatFamilyRosterForAi(list.members);
    } catch {
        familyRosterText = "";
    }

    const items = dayStatus.items;
    return {
        dateKey: dayStatus.dateKey,
        schedule: items,
        missed: items.filter((i) => i.status === "missed"),
        upcoming: items.filter((i) => i.status === "upcoming"),
        completed: items.filter((i) => i.status === "completed"),
        due: items.filter((i) => i.status === "due"),
        adherencePercent: dayStatus.adherencePercent,
        lastHeardLine: lastElder?.content ?? null,
        lastHeardAt: lastElder?.createdAt?.toISOString?.() ?? null,
        lastCheckInAt: lastCheckIn?.createdAt?.toISOString?.() ?? null,
        careRecordContext,
        companionProfile: companionProfilePayload(companion),
        connectedPartners,
        defaultAddressCount,
        channel: input.channel,
        familyRosterText,
    };
}
