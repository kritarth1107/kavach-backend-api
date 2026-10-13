/**
 * The old memory stores, read once for the move into the engine's care record (trust plan A1). Read only: the engine
 * job /v2/jobs/memory-unify calls the host tool `export_legacy_memory` for the list of families, then for each family,
 * and decides what moves (app/care/memory_unify.py). Nothing here writes; nothing here is read on a live path.
 *
 * Stores: ElderProfile (facts, tuning, allergies, diet rules, medicines), ElderUsuals (items, brand preferences),
 * SaheliCompanion (birthday, important dates), VoicePreference (the copy of language and voice), SaheliPermissions, and
 * the AiTenant link to the Instinct ids (the engine reads its own Instinct tables with it).
 */
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

type Lean = Record<string, unknown>;

async function models() {
    const [ElderProfile, ElderUsuals, SaheliCompanion, VoicePreference, SaheliPermissions, AiTenant, Family, CareSchedule] = await Promise.all([
        import("../models/elderProfile.model").then((m) => m.default),
        import("../models/elderUsuals.model").then((m) => m.default),
        import("../models/saheliCompanion.model").then((m) => m.default),
        import("../models/voicePreference.model").then((m) => m.default),
        import("../models/saheliPermissions.model").then((m) => m.default),
        import("../models/aiTenant.model").then((m) => m.default),
        import("../models/family.model").then((m) => m.default),
        import("../models/careSchedule.model").then((m) => m.default),
    ]);
    return { ElderProfile, ElderUsuals, SaheliCompanion, VoicePreference, SaheliPermissions, AiTenant, Family, CareSchedule };
}

type Member = { userId?: string; role?: string; status?: string };

function joined(members: Member[] | undefined): Member[] {
    return (members || []).filter((m) => m.userId && m.status === FamilyMemberStatus.JOINED);
}

/** Every active family that holds anything in an old store, with a member to act as (the engine's tool calls need one). */
export async function legacyMemoryFamilies(): Promise<Array<{ family_id: string; actor_id: string }>> {
    const M = await models();
    const ids = new Set<string>();
    const add = (rows: unknown[]) => (rows as Array<{ familyId?: unknown }>).forEach((r) => r.familyId && ids.add(String(r.familyId)));
    add(await M.ElderProfile.find({}, { familyId: 1 }).lean());
    add(await M.ElderUsuals.find({}, { familyId: 1 }).lean());
    add(await M.SaheliCompanion.find({ $or: [{ birthday: { $nin: [null, ""] } }, { "importantDates.0": { $exists: true } }] }, { familyId: 1 }).lean());
    add(await M.VoicePreference.find({}, { familyId: 1 }).lean());
    add(await M.SaheliPermissions.find({}, { familyId: 1 }).lean());
    add(await M.AiTenant.find({}, { familyId: 1 }).lean());
    const out: Array<{ family_id: string; actor_id: string }> = [];
    for (const familyId of [...ids].sort()) {
        const fam = (await M.Family.findOne({ familyId, status: "ACTIVE" }).lean()) as { members?: Member[] } | null;
        const people = joined(fam?.members);
        const actor = people.find((m) => m.role === FamilyRole.CARE_RECIPIENT) ?? people[0];
        if (actor?.userId) out.push({ family_id: familyId, actor_id: actor.userId });
    }
    return out;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v ?? null);

/** One family's old memory, per person, for the move. */
export async function exportLegacyMemory(familyId: string): Promise<Lean> {
    const M = await models();
    const fam = (await M.Family.findOne({ familyId, status: "ACTIVE" }).lean()) as { members?: Member[] } | null;
    const people = joined(fam?.members);
    const caregiverIds = people
        .filter((m) => m.role === FamilyRole.PRIMARY_CAREGIVER || m.role === FamilyRole.CO_CAREGIVER)
        .map((m) => String(m.userId));
    const tenant = (await M.AiTenant.findOne({ familyId }).lean()) as { aiFamilyId?: string; elders?: Array<{ recipientUserId: string; aiElderId: string }> } | null;
    const perms = (await M.SaheliPermissions.findOne({ familyId }).lean()) as Lean | null;
    const out: Lean[] = [];
    for (const m of people) {
        const userId = String(m.userId);
        const [profile, usuals, companion, voice, schedules] = await Promise.all([
            M.ElderProfile.findOne({ familyId, recipientUserId: userId }).lean() as Promise<Lean | null>,
            M.ElderUsuals.findOne({ familyId, recipientUserId: userId }).lean() as Promise<Lean | null>,
            M.SaheliCompanion.findOne({ familyId, recipientUserId: userId }).lean() as Promise<Lean | null>,
            M.VoicePreference.findOne({ userId }).lean() as Promise<Lean | null>,
            M.CareSchedule.find({ familyId, recipientUserId: userId, active: true }, { title: 1, type: 1 }).lean() as Promise<Lean[]>,
        ]);
        const link = tenant?.elders?.find((e) => e.recipientUserId === userId);
        out.push({
            id: userId,
            role: m.role,
            caregiver_ids: caregiverIds,
            profile: profile
                ? {
                      id: String(profile._id),
                      facts: ((profile.facts as Lean[]) || []).map((f) => ({
                          id: f.id, category: f.category, text: f.text, status: f.status, pinned: Boolean(f.pinned), blocked: Boolean(f.blocked),
                          editedBy: f.editedBy ?? null, confidence: f.confidence, firstSeen: iso(f.firstSeen), lastConfirmed: iso(f.lastConfirmed),
                      })),
                      tuning: profile.tuning ?? {},
                      nameToUse: profile.nameToUse ?? null,
                      allergies: profile.allergies ?? [],
                      dietRules: profile.dietRules ?? [],
                      medicines: profile.medicines ?? [],
                  }
                : null,
            usuals: usuals
                ? {
                      id: String(usuals._id),
                      items: ((usuals.items as Lean[]) || []).map((i) => ({ key: i.key, name: i.name, partner: i.partner, category: i.category, count: i.count, lastAt: iso(i.lastAt) })),
                      brandPrefs: ((usuals.brandPrefs as Lean[]) || []).map((b) => ({ key: b.key, brand: b.brand, item: b.item ?? "", text: b.text, at: iso(b.at) })),
                  }
                : null,
            companion: companion && (companion.birthday || (companion.importantDates as unknown[] | undefined)?.length)
                ? { id: String(companion._id), birthday: companion.birthday ?? null, importantDates: companion.importantDates ?? [] }
                : null,
            voice: voice
                ? { id: String(voice._id), language: voice.language ?? null, dialect: voice.dialect ?? null, script: voice.script ?? null, mode: voice.mode ?? null, updatedBy: voice.updatedBy ?? null }
                : null,
            schedules: (schedules || []).map((s) => ({ title: s.title, type: s.type })),
            instinct: tenant?.aiFamilyId && link?.aiElderId ? { aiFamilyId: tenant.aiFamilyId, aiElderId: link.aiElderId } : null,
        });
    }
    return {
        family_id: familyId,
        people: out,
        permissions: perms
            ? { groceries: perms.groceries, food: perms.food, medicines: perms.medicines, rides: perms.rides, spendSoftLimitInr: perms.spendSoftLimitInr ?? null }
            : null,
    };
}
