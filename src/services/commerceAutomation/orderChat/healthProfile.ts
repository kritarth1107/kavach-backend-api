/**
 * The elder's Kavach health profile for ordering: conditions, allergies, diet rules and target ranges come from her care
 * record in the engine (structured domains, trust plan A1: the one memory); medicines are the family's MEDICINE care
 * schedules. Nothing is invented — empty data → empty profile.
 */

export type HealthProfile = { notes: string[]; medicines: string[]; profileMd: string };

const cache = new Map<string, { at: number; p: HealthProfile }>();
const TTL = 10 * 60_000;

/** Tests/evals only: seed a profile without the DB / AI engine. */
export function primeHealthProfile(familyId: string, recipientUserId: string, p: HealthProfile): void {
    cache.set(`${familyId}:${recipientUserId}`, { at: Date.now(), p });
}

export function forgetHealthProfile(familyId: string, recipientUserId: string): void {
    cache.delete(`${familyId}:${recipientUserId}`);
}

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
            const { careFacts } = await import("../../engineCareFacts.service");
            const facts = await careFacts(familyId, recipientUserId, ["condition", "allergy", "diet", "vital_target"]);
            p.notes = facts.map((f) => f.text.trim().slice(0, 200)).filter(Boolean).slice(0, 15);
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
