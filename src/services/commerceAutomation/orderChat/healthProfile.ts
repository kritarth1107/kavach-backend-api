/**
 * The elder's Kavach health profile for ordering: conditions / allergies / diet notes live in the
 * AI engine memory (category "health"/"preference", family + elder scoped); medicines are the
 * family's MEDICINE care schedules. Nothing is invented — empty data → empty profile.
 */
import AiTenant from "../../../models/aiTenant.model";

export type HealthProfile = { notes: string[]; medicines: string[]; profileMd: string };

const cache = new Map<string, { at: number; p: HealthProfile }>();
const TTL = 10 * 60_000;

export function forgetHealthProfile(familyId: string, recipientUserId: string): void {
    cache.delete(`${familyId}:${recipientUserId}`);
}

const HEALTHY_WORDS = /\b(allerg|intoleran|diabet|sugar|bp\b|blood pressure|hypertens|cholesterol|kidney|renal|heart|cardiac|thyroid|gout|uric|celiac|gluten|lactose|dairy|veg|vegetarian|vegan|jain|egg|onion|garlic|diet|avoid|salt|sodium|fried|oily|spicy|acidity|gastric|ulcer|liver|pregnan|asthma|warfarin|metformin|insulin|statin|medicine|tablet|condition)/i;

export async function loadHealthProfile(familyId: string, recipientUserId: string): Promise<HealthProfile> {
    const key = `${familyId}:${recipientUserId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return hit.p;
    const p: HealthProfile = { notes: [], medicines: [], profileMd: "" };
    const tasks: Array<Promise<void>> = [];
    tasks.push(
        (async () => {
            const { default: CareSchedule } = await import("../../../models/careSchedule.model");
            const rows = (await CareSchedule.find({ familyId, recipientUserId, type: "MEDICINE" }).limit(20).lean()) as Array<{ title?: string; enabled?: boolean; active?: boolean }>;
            p.medicines = [...new Set(rows.filter((r) => r.enabled !== false && r.active !== false).map((r) => String(r.title || "").trim()).filter(Boolean))].slice(0, 12);
        })().catch(() => undefined),
    );
    tasks.push(
        (async () => {
            const link = await AiTenant.findOne({ familyId }).lean();
            const elder = link?.elders?.find((e: { recipientUserId: string }) => e.recipientUserId === recipientUserId) as { aiElderId?: string } | undefined;
            if (!link?.aiFamilyId || !elder?.aiElderId) return;
            const { aiListFamilyMemories, aiGetMemoryProfile } = await import("../../../clients/aiEngine.client");
            const [mem, prof] = await Promise.all([
                aiListFamilyMemories({ aiFamilyId: link.aiFamilyId, aiElderId: elder.aiElderId, limit: 80 }).catch(() => ({ memories: [] })),
                aiGetMemoryProfile({ aiFamilyId: link.aiFamilyId, aiElderId: elder.aiElderId }).catch(() => ({ profile_md: "" })),
            ]);
            p.notes = mem.memories
                .filter((m) => !m.superseded_by && (m.category === "health" || (m.category === "preference" && HEALTHY_WORDS.test(m.content))))
                .map((m) => m.content.trim().slice(0, 200))
                .filter(Boolean)
                .slice(0, 15);
            // Only the health-ish lines of the curated profile (never the whole biography).
            p.profileMd = String(prof.profile_md || "")
                .split("\n")
                .filter((l) => HEALTHY_WORDS.test(l))
                .join("\n")
                .slice(0, 1200);
        })().catch(() => undefined),
    );
    await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, 3500))]);
    cache.set(key, { at: Date.now(), p });
    return p;
}

export function healthProfileText(p: HealthProfile): string {
    const lines = [
        ...p.notes.map((n) => `- ${n}`),
        ...(p.medicines.length ? [`- Medicines on schedule: ${p.medicines.join(", ")}`] : []),
        ...(p.profileMd ? [p.profileMd] : []),
    ];
    return lines.length ? lines.join("\n") : "(no health data on file — do NOT assume any condition)";
}
