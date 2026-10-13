/**
 * What the backend needs to know about a person to write to them itself (trust plan A1, A3): the name to use and the
 * names never to use, and the language / voice setting. The engine's care record is the truth (GET /v2/person/…, which
 * reads app/care/naming.py for_person and the language:preferred fact); this keeps a copy for 60 s, dropped at once
 * when the engine says it changed (host tool `person_memory_changed`). The backend runs as one instance, so the cache
 * can live in memory.
 */
import { aiEngineJson } from "./aiEngine.client";

export type EnginePerson = {
    name: string | null;
    avoid: string[];
    language: string | null;
    dialect: string | null;
    script: "native" | "roman" | null;
    voice: "auto" | "always" | "never" | null;
    /** The engine has a saved language/voice fact for them. */
    known: boolean;
};

export const PERSON_CACHE_MS = 60_000;
const EMPTY: EnginePerson = { name: null, avoid: [], language: null, dialect: null, script: null, voice: null, known: false };
const cache = new Map<string, { at: number; p: EnginePerson }>();

const key = (familyId: string, userId: string) => `${familyId}|${userId}`;

/** The engine's view of this person (cached 60 s). On an engine error: the last copy, else empty (never throws). */
export async function getEnginePerson(familyId: string, userId: string, opts: { now?: number; timeoutMs?: number } = {}): Promise<EnginePerson> {
    const now = opts.now ?? Date.now();
    const hit = cache.get(key(familyId, userId));
    if (hit && now - hit.at < PERSON_CACHE_MS) return hit.p;
    try {
        const got = await aiEngineJson<Partial<EnginePerson>>(
            "GET",
            `/v2/person/${encodeURIComponent(familyId)}/${encodeURIComponent(userId)}`,
            undefined,
            opts.timeoutMs ?? 4000,
        );
        const p: EnginePerson = {
            name: typeof got.name === "string" && got.name.trim() ? got.name.trim() : null,
            avoid: Array.isArray(got.avoid) ? got.avoid.filter((w): w is string => typeof w === "string" && Boolean(w.trim())) : [],
            language: got.language ?? null,
            dialect: got.dialect ?? null,
            script: got.script === "roman" || got.script === "native" ? got.script : null,
            voice: got.voice === "auto" || got.voice === "always" || got.voice === "never" ? got.voice : null,
            known: Boolean(got.known),
        };
        cache.set(key(familyId, userId), { at: now, p });
        return p;
    } catch (err) {
        console.warn(`[engine-person] read failed: ${err instanceof Error ? err.message : err}`);
        return hit?.p ?? EMPTY;
    }
}

/** The engine changed this person's naming or language fact: the next read asks again. */
export function forgetEnginePerson(familyId: string, userId: string): void {
    cache.delete(key(familyId, userId));
}

/** Tests only. */
export function resetEnginePersonCache(): void {
    cache.clear();
}

/**
 * Saheli's own text with every name the person asked never to be called taken out (a code check on her output against
 * the care record's avoid list, never on what people said). An avoided name used as an address ("Maa, time for…") is
 * replaced by the name to use, or dropped with its comma.
 */
export function withoutAvoidedNames(text: string, person: Pick<EnginePerson, "name" | "avoid">): string {
    let out = text;
    for (const raw of person.avoid) {
        const w = raw.trim();
        if (!w) continue;
        const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const word = new RegExp(`(^|[^\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "giu");
        out = out.replace(word, (_m, pre: string) => `${pre}${person.name ?? ""}`);
    }
    return out
        .replace(/\s+([,!?.।])/g, "$1")
        .replace(/(^|[\n(])\s*[,،]\s*/g, "$1")
        .replace(/,\s*,/g, ",")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}
