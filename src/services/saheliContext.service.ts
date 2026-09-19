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
    const parts: string[] = [];

    if (bundle.channel === "whatsapp") {
        parts.push(
            "[Channel] User is on WhatsApp — keep replies short, warm, Hindi-English OK, no dashboard links unless needed.",
        );
    }

    parts.push(`[Today ${bundle.dateKey} IST schedule]`);
    parts.push(formatScheduleSection(bundle.missed, "Missed") || "Missed: none");
    parts.push(formatScheduleSection(bundle.upcoming, "Upcoming") || "Upcoming: none");
    parts.push(formatScheduleSection(bundle.completed, "Completed") || "Completed: none");
    if (bundle.adherencePercent != null) {
        parts.push(`Adherence today: ${bundle.adherencePercent}%`);
    }

    if (bundle.lastHeardLine) {
        parts.push(
            `[Last heard] ${bundle.lastHeardAt ?? "recently"}: "${bundle.lastHeardLine.slice(0, 280)}"`,
        );
    }
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

    parts.push(`[Care record]\n${bundle.careRecordContext}`);
    parts.push(`[Companion profile]\n${JSON.stringify(bundle.companionProfile)}`);

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
    const careRecordContext = await getCareRecordContextForSaheli(
        input.familyId,
        input.recipientUserId,
        input.careRecordLimit ?? 30,
    );
    const connectedPartners = await listFamilyConnectedPartners(
        input.familyId,
        input.actorUserId,
    );
    const defaultAddressCount = await countDefaultAddresses(input.familyId, input.actorUserId);

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
    };
}
