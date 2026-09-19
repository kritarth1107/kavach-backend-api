import { randomUUID } from "crypto";
import SaheliCompanion, {
    ISaheliCompanion,
    OUTREACH_SLOT_HOURS,
    OutreachSlot,
} from "../models/saheliCompanion.model";
import { AppError } from "../middleware/error.middleware";
import Family from "../models/family.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

const DEFAULT_COMPANION: Omit<ISaheliCompanion, "familyId" | "recipientUserId"> = {
    enabled: true,
    childName: "Saheli",
    relationshipLabel: "your child",
    outreachSlots: ["morning", "afternoon", "evening"],
    outreachTopics: ["day_life", "family", "hobbies", "food", "mood", "memories"],
    shareWithFamily: true,
    preferredChannel: "whatsapp",
    timezone: "Asia/Kolkata",
};

export function serializeCompanionForApi(doc: ISaheliCompanion) {
    return {
        enabled: doc.enabled,
        childName: doc.childName,
        relationshipLabel: doc.relationshipLabel,
        personaNotes: doc.personaNotes ?? "",
        outreachSlots: doc.outreachSlots,
        outreachTopics: doc.outreachTopics,
        shareWithFamily: doc.shareWithFamily,
        preferredChannel: doc.preferredChannel,
        timezone: doc.timezone,
        quietHoursStart: doc.quietHoursStart ?? "",
        quietHoursEnd: doc.quietHoursEnd ?? "",
        nudgeIntensity: doc.nudgeIntensity ?? "standard",
        preferredLanguage: doc.preferredLanguage ?? "english",
        birthday: doc.birthday ?? "",
        importantDates: doc.importantDates ?? [],
        lastOutreachAt: doc.lastOutreachAt?.toISOString?.() ?? null,
        lastWhatsAppInboundAt: doc.lastWhatsAppInboundAt?.toISOString?.() ?? null,
    };
}

export function companionProfilePayload(doc: ISaheliCompanion) {
    return {
        child_name: doc.childName,
        childName: doc.childName,
        relationship_label: doc.relationshipLabel,
        relationshipLabel: doc.relationshipLabel,
        persona_notes: doc.personaNotes ?? "",
        outreach_topics: doc.outreachTopics,
        outreachTopics: doc.outreachTopics,
        share_with_family: doc.shareWithFamily,
        preferred_language: doc.preferredLanguage ?? "english",
        preferredLanguage: doc.preferredLanguage ?? "english",
    };
}

export async function getCompanionProfile(
    familyId: string,
    recipientUserId: string,
): Promise<ISaheliCompanion> {
    let doc = await SaheliCompanion.findOne({ familyId, recipientUserId }).lean<ISaheliCompanion>();
    if (!doc) {
        const created = await SaheliCompanion.create({
            familyId,
            recipientUserId,
            ...DEFAULT_COMPANION,
        });
        doc = created.toObject() as ISaheliCompanion;
    }
    return doc;
}

export async function updateCompanionProfile(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    patch: Partial<ISaheliCompanion>,
): Promise<ISaheliCompanion> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }
    const actor = family.members.find((m) => m.userId === actorUserId);
    if (
        !actor ||
        (actor.role !== FamilyRole.PRIMARY_CAREGIVER && actor.role !== FamilyRole.CO_CAREGIVER)
    ) {
        throw new AppError("Only caregivers can update Saheli companion settings", 403);
    }

    const allowed: Partial<ISaheliCompanion> = {};
    if (patch.enabled !== undefined) allowed.enabled = patch.enabled;
    if (patch.childName !== undefined) allowed.childName = patch.childName.slice(0, 40);
    if (patch.relationshipLabel !== undefined) {
        allowed.relationshipLabel = patch.relationshipLabel.slice(0, 80);
    }
    if (patch.personaNotes !== undefined) allowed.personaNotes = patch.personaNotes.slice(0, 500);
    if (patch.outreachSlots !== undefined) allowed.outreachSlots = patch.outreachSlots;
    if (patch.outreachTopics !== undefined) allowed.outreachTopics = patch.outreachTopics;
    if (patch.shareWithFamily !== undefined) allowed.shareWithFamily = patch.shareWithFamily;
    if (patch.preferredChannel !== undefined) allowed.preferredChannel = patch.preferredChannel;
    if (patch.timezone !== undefined) allowed.timezone = patch.timezone;
    if (patch.quietHoursStart !== undefined) allowed.quietHoursStart = patch.quietHoursStart;
    if (patch.quietHoursEnd !== undefined) allowed.quietHoursEnd = patch.quietHoursEnd;
    if (patch.nudgeIntensity !== undefined) allowed.nudgeIntensity = patch.nudgeIntensity;
    if (patch.preferredLanguage !== undefined) allowed.preferredLanguage = patch.preferredLanguage;
    if (patch.birthday !== undefined) allowed.birthday = patch.birthday;
    if (patch.importantDates !== undefined) allowed.importantDates = patch.importantDates;

    const doc = await SaheliCompanion.findOneAndUpdate(
        { familyId, recipientUserId },
        { $set: allowed, $setOnInsert: { familyId, recipientUserId, ...DEFAULT_COMPANION } },
        { upsert: true, new: true },
    ).lean();

    if (!doc) throw new AppError("Failed to save companion settings", 500);
    return doc as ISaheliCompanion;
}

export function localDateParts(timezone: string, at = new Date()) {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "numeric",
        hour12: false,
    });
    const parts = fmt.formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        hour: Number(get("hour")),
    };
}

export function dueOutreachSlot(
    companion: ISaheliCompanion,
    at = new Date(),
): OutreachSlot | null {
    if (!companion.enabled) return null;
    const { date, hour } = localDateParts(companion.timezone || "Asia/Kolkata", at);
    void date;

    for (const slot of companion.outreachSlots) {
        const target = OUTREACH_SLOT_HOURS[slot];
        if (hour >= target && hour < target + 2) return slot;
    }
    return null;
}

export function slotDateKey(timezone: string, at = new Date()): string {
    return localDateParts(timezone, at).date;
}

export async function listEnabledCompanions() {
    return SaheliCompanion.find({ enabled: true }).lean();
}

export async function markCompanionOutreach(familyId: string, recipientUserId: string) {
    await SaheliCompanion.updateOne(
        { familyId, recipientUserId },
        { $set: { lastOutreachAt: new Date() } },
    );
}

export async function ensureRecipientInFamily(familyId: string, recipientUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) throw new AppError("Family not found", 404);
    const member = family.members.find(
        (m) =>
            m.userId === recipientUserId &&
            m.status === FamilyMemberStatus.JOINED &&
            m.role === FamilyRole.CARE_RECIPIENT,
    );
    if (!member) throw new AppError("Care recipient not found", 404);
    return family;
}

export function newOutreachLogId() {
    return randomUUID();
}

function parseHourMinute(value?: string): number | null {
    if (!value?.trim()) return null;
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
}

export function isWithinQuietHours(
    companion: ISaheliCompanion,
    at = new Date(),
): boolean {
    const start = parseHourMinute(companion.quietHoursStart);
    const end = parseHourMinute(companion.quietHoursEnd);
    if (start == null || end == null) return false;

    const { hour, minute } = (() => {
        const fmt = new Intl.DateTimeFormat("en-GB", {
            timeZone: companion.timezone || "Asia/Kolkata",
            hour: "numeric",
            minute: "numeric",
            hour12: false,
        });
        const parts = fmt.formatToParts(at);
        const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
        return { hour: get("hour"), minute: get("minute") };
    })();
    const now = hour * 60 + minute;

    if (start <= end) return now >= start && now < end;
    return now >= start || now < end;
}

export async function touchWhatsAppInbound(familyId: string, recipientUserId: string) {
    await SaheliCompanion.updateOne(
        { familyId, recipientUserId },
        { $set: { lastWhatsAppInboundAt: new Date() } },
    );
}

export type SaheliLanguage = "english" | "hinglish" | "hindi" | "tamil";

const LANGUAGE_LABELS: Record<SaheliLanguage, string> = {
    english: "English",
    hindi: "Hindi",
    hinglish: "Hinglish",
    tamil: "Tamil",
};

export function languageInstruction(lang: SaheliLanguage): string {
    switch (lang) {
        case "hindi":
            return "Reply in simple Hindi (Devanagari script) only.";
        case "hinglish":
            return "Reply in natural Hinglish (simple Hindi-English mix).";
        case "tamil":
            return "Reply in simple Tamil only.";
        default:
            return "Reply in clear, simple English only.";
    }
}

export function buildWhatsAppElderChannelContext(lang: SaheliLanguage): string {
    return [
        "The user IS the care recipient (elder) on WhatsApp — NOT a caregiver.",
        'Address them as "you" only. Never third person.',
        languageInstruction(lang),
        "Answer ONLY what was asked — nothing extra.",
        "Max 1-3 short sentences unless listing schedule items or lab values they asked for.",
        "No menus, no bullet lists of capabilities, no follow-up questions, no unprompted suggestions.",
        "Proactive reminders are sent separately — do not nudge or check in unless they asked.",
    ].join(" ");
}

export function parseLanguageChangeMessage(text: string): SaheliLanguage | null {
    const q = text.trim().toLowerCase();
    if (
        !/\b(change|switch|set|use|speak|talk|reply|respond|language|lang|bhasha|bolo|baat)\b/i.test(
            q,
        ) &&
        !/\b(english|hindi|hinglish|tamil|tamizh)\b/i.test(q)
    ) {
        return null;
    }

    if (/\b(english|angrezi|angreji)\b/i.test(q)) return "english";
    if (/\b(hinglish|mix(ed)?)\b/i.test(q)) return "hinglish";
    if (/\b(tamil|tamizh|thamizh)\b/i.test(q)) return "tamil";
    if (/\b(hindi|devanagari)\b/i.test(q)) return "hindi";
    return null;
}

export function languageChangeConfirmation(lang: SaheliLanguage): string {
    return `Got it — I'll talk to you in ${LANGUAGE_LABELS[lang]} from now on.`;
}
