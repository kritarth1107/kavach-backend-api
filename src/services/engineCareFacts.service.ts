/**
 * The person's care record facts from Saheli's memory in the engine (the one truth since the memory move, trust plan
 * A1), for backend code that needs a short health context (the order chat, cart suggestions). Read only, cached 5 min,
 * by structured domain (medicine, allergy, condition, diet…): no word lists over what people said.
 */
import { aiEngineJson } from "../clients/aiEngine.client";

export type EngineFact = { key: string; domain: string; text: string; status: string; value?: Record<string, unknown> };

const cache = new Map<string, { at: number; facts: EngineFact[] }>();
const TTL = 5 * 60_000;

export async function careFacts(familyId: string, subjectId: string, domains?: string[]): Promise<EngineFact[]> {
    const k = `${familyId}|${subjectId}`;
    const hit = cache.get(k);
    let facts = hit && Date.now() - hit.at < TTL ? hit.facts : null;
    if (!facts) {
        const got = await aiEngineJson<{ facts?: EngineFact[] }>(
            "GET",
            `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(subjectId)}/overview`,
            undefined,
            4000,
        );
        facts = (got.facts || []).filter((f) => f.status === "active");
        cache.set(k, { at: Date.now(), facts });
    }
    return domains ? facts.filter((f) => domains.includes(f.domain)) : facts;
}

/** Tests only. */
export function primeCareFacts(familyId: string, subjectId: string, facts: EngineFact[]): void {
    cache.set(`${familyId}|${subjectId}`, { at: Date.now(), facts });
}
