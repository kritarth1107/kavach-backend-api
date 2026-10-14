/**
 * Words a family's voice notes are likely to carry that a speech engine gets wrong without help: their medicine names
 * and the names of the people in the family. Scribe v2 takes them as key terms (STT bake-off 14 Oct 2026: "Thyronorm"
 * came back "Khaironom" without them and right with them). Data only: nothing here reads what anyone said.
 */
import CareSchedule from "../models/careSchedule.model";
import Family from "../models/family.model";
import User from "../models/users.model";
import { CareScheduleType } from "../types/careSchedule.types";

/** ElevenLabs takes up to 100 key terms; a short list of the family's own words is the useful part. */
export const MAX_KEYTERMS = 40;
const MAX_TERM_CHARS = 40;

/** Clean, de-duplicated key terms: medicine names first (the costly mistakes), then people. */
export function keytermsFrom(medicines: Array<string | undefined | null>, people: Array<string | undefined | null>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of [...medicines, ...people]) {
        const term = String(raw ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_TERM_CHARS)
            .trim();
        const key = term.toLowerCase();
        if (term.length < 2 || seen.has(key)) continue;
        seen.add(key);
        out.push(term);
        if (out.length >= MAX_KEYTERMS) break;
    }
    return out;
}

/** The medicine titles on the family's active schedule and the first and full names of its members. */
export async function familyKeyterms(familyId: string | undefined | null): Promise<string[]> {
    if (!familyId) return [];
    const [meds, family] = await Promise.all([
        CareSchedule.find({ familyId, type: CareScheduleType.MEDICINE, active: true }, { title: 1 })
            .limit(80)
            .lean<Array<{ title?: string }>>(),
        Family.findOne({ familyId }, { members: 1 }).lean<{ members?: Array<{ userId: string }> }>(),
    ]);
    const ids = (family?.members ?? []).map((m) => m.userId).filter(Boolean);
    const users = ids.length
        ? await User.find({ userId: { $in: ids } }, { firstName: 1, lastName: 1 }).lean<Array<{ firstName?: string; lastName?: string }>>()
        : [];
    const people = users.flatMap((u) => [u.firstName, [u.firstName, u.lastName].filter(Boolean).join(" ")]);
    return keytermsFrom(meds.map((m) => m.title), people);
}
