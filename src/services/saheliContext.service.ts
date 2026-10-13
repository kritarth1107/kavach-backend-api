import type { ScheduleDayItem } from "../types/careScheduleCompletion.types";

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
