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
