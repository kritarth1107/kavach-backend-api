/**
 * Synthetic WhatsApp test families for cross-family smoke tests (secret-gated mock only).
 * Phones use the unassigned +999 ITU code, so whatsappRecipientGuard refuses every Meta
 * send to them — nothing reaches a real person. Fixed phones only; no user input.
 */
const FIXTURES = [
    {
        phone: "+999100000001",
        name: "Smoke Elder A",
        family: "Smoke Test Family A",
        address: "Flat 12, Lake View Apartments, Shyamla Hills, Bhopal, Madhya Pradesh 462002",
        // Extra family-book places (created directly; the legacy row above tests migration).
        places: [
            { nickname: "Beta's flat", address: "B-7, Silver Oak Residency, Vijay Nagar, Indore, Madhya Pradesh 452010" },
            { nickname: "Clinic", address: "Shop 3, Arera Medical Plaza, Arera Colony, Bhopal, Madhya Pradesh 462016" },
        ],
    },
    { phone: "+999100000002", name: "Smoke Elder B", family: "Smoke Test Family B", address: "H-5, Connaught Place, New Delhi, Delhi 110001" },
    { phone: "+999100000003", name: "Smoke Elder C", family: "Smoke Test Family C", address: null },
    {
        phone: "+999100000004",
        name: "Smoke Elder D",
        family: "Smoke Test Family D",
        address: "Flat 4, Lake View Apartments, Shyamla Hills, Bhopal, Madhya Pradesh 462002",
        // Health profile (AI engine memory) for the conversational / health-aware ordering tests.
        health: [
            "Smoke Elder D has lactose intolerance — milk and dairy upset her stomach.",
            "Smoke Elder D has type 2 diabetes and is advised to avoid sugary sweets.",
        ],
    },
];

/** Exactly one of the fixed fixture phones above (never a real or random placeholder number). */
export function isSmokeFixturePhone(raw: string | undefined | null): boolean {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return FIXTURES.some((f) => f.phone.replace(/\D/g, "") === digits);
}

export async function manageSmokeFixtures(mode: "create" | "delete"): Promise<string[]> {
    const out: string[] = [];
    const User = (await import("../models/users.model")).default;
    const Family = (await import("../models/family.model")).default;
    const ChannelIdentity = (await import("../models/channelIdentity.model")).default;
    const WhatsappSession = (await import("../models/whatsappSession.model")).default;
    const RecipientDeliveryAddress = (await import("../models/recipientDeliveryAddress.model")).default;
    const { default: FamilyAddress, FamilyAddressChoice } = await import("../models/familyAddress.model");
    const { createPlace } = await import("./familyAddressBook.service");
    const { FamilyRole, FamilyMemberStatus } = await import("../types/family.types");
    const { ChannelType } = await import("../types/careRecord.types");
    const { randomUUID } = await import("crypto");
    const { buildCosmosSafePhonePlaceholder, phoneFieldsFromNormalized } = await import("../utils/phone.util");

    if (mode === "delete") {
        for (const f of FIXTURES) {
            const ids = await ChannelIdentity.find({ channelIdentifier: f.phone }).lean();
            for (const id of ids) {
                const fam = await Family.findOne({ familyId: id.familyId }).lean();
                const userIds = (fam?.members || []).map((m: { userId: string }) => m.userId);
                await RecipientDeliveryAddress.deleteMany({ familyId: id.familyId });
                await FamilyAddress.deleteMany({ familyId: id.familyId });
                await FamilyAddressChoice.deleteMany({ familyId: id.familyId });
                const SaheliProactiveNudge = (await import("../models/saheliProactiveNudge.model")).default;
                const SaheliCompanion = (await import("../models/saheliCompanion.model")).default;
                const ActivityLog = (await import("../models/activityLog.model")).default;
                await SaheliProactiveNudge.deleteMany({ familyId: id.familyId });
                await SaheliCompanion.deleteMany({ familyId: id.familyId });
                await ActivityLog.deleteMany({ familyId: id.familyId });
                // Seeded health memories (AI engine) + the tenant link.
                const AiTenant = (await import("../models/aiTenant.model")).default;
                const link = await AiTenant.findOne({ familyId: id.familyId }).lean();
                if (link) {
                    const { aiListFamilyMemories, aiForgetMemory } = await import("../clients/aiEngine.client");
                    for (const el of link.elders || []) {
                        const mem = await aiListFamilyMemories({ aiFamilyId: link.aiFamilyId, aiElderId: el.aiElderId, limit: 100 }).catch(() => ({ memories: [] }));
                        for (const m of mem.memories) await aiForgetMemory({ factId: m.id, forgottenBy: "smoke-fixtures" }).catch(() => undefined);
                    }
                    await AiTenant.deleteOne({ familyId: id.familyId });
                }
                await Family.deleteOne({ familyId: id.familyId });
                await User.deleteMany({ userId: { $in: userIds }, email: /@smoke\.kavach\.test$/ });
            }
            await ChannelIdentity.deleteMany({ channelIdentifier: f.phone });
            await WhatsappSession.deleteMany({ phone: f.phone });
        }
        out.push("deleted smoke fixtures");
        return out;
    }

    for (const f of FIXTURES) {
        if (await ChannelIdentity.exists({ channelIdentifier: f.phone })) {
            out.push(`${f.phone} exists`);
            continue;
        }
        const mk = (first: string, tag: string) =>
            User.create({
                userId: randomUUID(),
                email: `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@smoke.kavach.test`,
                firstName: first,
                passwordHash: "x-disabled",
                emailVerified: true,
                ...phoneFieldsFromNormalized(buildCosmosSafePhonePlaceholder()),
            });
        const cg = await mk("Smoke Caregiver", "cg");
        const elder = await mk(f.name, "elder");
        const fam = await Family.create({
            name: f.family,
            createdBy: cg.userId,
            members: [
                { userId: cg.userId, role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED },
                { userId: elder.userId, role: FamilyRole.CARE_RECIPIENT, status: FamilyMemberStatus.JOINED, name: f.name },
            ],
        });
        await ChannelIdentity.create({
            channelType: ChannelType.WHATSAPP,
            channelIdentifier: f.phone,
            familyId: fam.familyId,
            userId: elder.userId,
            role: FamilyRole.CARE_RECIPIENT,
            active: true,
        });
        if (f.address) {
            const pin = f.address.match(/\b\d{6}\b/)![0];
            await RecipientDeliveryAddress.create({
                familyId: fam.familyId,
                recipientUserId: elder.userId,
                address: f.address,
                pincode: pin,
                source: "caregiver",
                setByUserId: cg.userId,
            });
        }
        for (const pl of (f as { places?: Array<{ nickname: string; address: string }> }).places || []) {
            await createPlace(fam.familyId, { nickname: pl.nickname, address: pl.address }, { actorUserId: cg.userId, source: "dashboard" });
        }
        const health = (f as { health?: string[] }).health || [];
        let seeded = 0;
        if (health.length) {
            try {
                const { ensureAiContext } = await import("./aiTenant.service");
                const { aiInboxMemory } = await import("../clients/aiEngine.client");
                const ctx = await ensureAiContext(fam.familyId, elder.userId, f.name);
                for (const content of health) {
                    const r = await aiInboxMemory({ aiFamilyId: ctx.aiFamilyId, aiElderId: ctx.aiElderId, content, category: "health", topic: "health", sourceRole: "caregiver" });
                    if (r.saved) seeded++;
                }
            } catch (err) {
                out.push(`health seed failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
            }
        }
        out.push(`${f.phone} → family …${fam.familyId.slice(-4)}${f.address ? " (legacy address set)" : " (no address)"}${health.length ? ` (health facts: ${seeded}/${health.length})` : ""}`);
    }
    return out;
}
