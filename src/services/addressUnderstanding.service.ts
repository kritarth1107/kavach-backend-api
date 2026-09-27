/**
 * Gemini understanding of a typed delivery-address reply ("560092 home", a comma-less full
 * address, "74 4th cross … bangalore"). Returns the parts she actually wrote (never invented),
 * the place name she gave ("home" → Home), and whether it's complete enough to deliver to.
 * Code keeps the checks: the pincode must be in her text (or already known), street words must
 * come from her text. null → the rule parser is the fallback.
 */
import { vertexGenerateText, parseJsonLoose, vertexFlashModel } from "../clients/vertexGemini.client";

export type AddressUnderstanding = {
    /** 6-digit pincode from her text (or the one she gave earlier). */
    pincode: string | null;
    /** What she calls the place ("Home", "Beti ka ghar"), tidied; null if she didn't name it. */
    label: string | null;
    /** House/flat/building + street, in her words. */
    line1: string | null;
    locality: string | null;
    city: string | null;
    state: string | null;
    /** Street-level address present (house/flat/building or street AND area) with a pincode. */
    complete: boolean;
};

const SCHEMA = {
    type: "OBJECT",
    properties: {
        pincode: { type: "STRING", nullable: true },
        label: { type: "STRING", nullable: true },
        line1: { type: "STRING", nullable: true },
        locality: { type: "STRING", nullable: true },
        city: { type: "STRING", nullable: true },
        state: { type: "STRING", nullable: true },
        complete: { type: "BOOLEAN" },
    },
    required: ["complete"],
};

const SYSTEM = `You read one WhatsApp reply to "send your delivery address" from an elderly Indian user (English/Hindi/Hinglish, typos, no commas). Split ONLY what they wrote — never invent or correct words, never add a city/state they didn't write.
- pincode: the 6-digit Indian pincode in the message (else the known pincode given in context, else null).
- label: the name they give the place ("home", "ghar", "mera ghar" → "Home"; "beti ka ghar" → "Beti ka ghar"; "office", "clinic"). null if none. A label is not part of the street.
- line1: house/flat/plot number + building/society + street/cross/main road, in their words. null if missing.
- locality: area / sector / layout / nagar words. city, state: only if written ("bangalore", "karnataka"). Drop "india".
- complete: true only when line1 has a house/flat/building or street AND there is a locality or city, AND a pincode (from the message or known). "560092 home" alone → complete=false.
Return JSON only.`;

function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, " ").trim();
}

/** Every part must come from her own words (guards against a model "fixing" the address). */
function fromText(part: string | null | undefined, text: string): string | null {
    const p = (part || "").replace(/\s+/g, " ").trim();
    if (!p) return null;
    const t = ` ${norm(text)} `;
    const words = norm(p).split(" ").filter(Boolean);
    if (!words.length) return null;
    const hit = words.filter((w) => t.includes(` ${w} `)).length;
    return hit / words.length >= 0.8 ? p : null;
}

export function tidyLabel(s: string | null | undefined): string | null {
    const t = String(s || "")
        .replace(/^["'\s]+|["'.!\s]+$/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    if (!t) return null;
    return t.charAt(0).toUpperCase() + t.slice(1);
}

export async function understandAddressText(
    text: string,
    known: { pincode?: string; nickname?: string } = {},
): Promise<AddressUnderstanding | null> {
    const msg = String(text || "").trim().slice(0, 400);
    if (!msg) return null;
    const raw = await vertexGenerateText({
        model: process.env.VERTEX_ROUTER_MODEL?.trim() || vertexFlashModel(),
        system: SYSTEM,
        responseSchema: SCHEMA,
        timeoutMs: Number(process.env.VERTEX_ADDRESS_TIMEOUT_MS) || 6000,
        maxOutputTokens: 1024,
        thinkingLevel: "low",
        prompt: [
            known.pincode || known.nickname ? `Known from their earlier message: ${[known.pincode ? `pincode ${known.pincode}` : "", known.nickname ? `place name "${known.nickname}"` : ""].filter(Boolean).join(", ")}` : "",
            `Message: ${msg}`,
        ]
            .filter(Boolean)
            .join("\n"),
    }).catch(() => null);
    const p = parseJsonLoose<Partial<AddressUnderstanding>>(raw);
    if (!p || typeof p.complete !== "boolean") return null;
    const digits = String(p.pincode || "").replace(/\D/g, "");
    const inText = new RegExp(`\\b${digits}\\b`).test(msg);
    const pincode = /^[1-9]\d{5}$/.test(digits) && (inText || digits === known.pincode) ? digits : known.pincode && /^[1-9]\d{5}$/.test(known.pincode) ? known.pincode : null;
    const line1 = fromText(p.line1, msg);
    const locality = fromText(p.locality, msg);
    const city = fromText(p.city, msg);
    const state = fromText(p.state, msg);
    // A name she gave must be in her words ("ghar" / "home" → Home is the one translation allowed).
    const saidHome = /\b(home|ghar)\b|घर/i.test(msg);
    const label = p.label ? (fromText(p.label, msg) || (/^home$/i.test(p.label.trim()) && saidHome) ? tidyLabel(p.label) : null) : null;
    const complete = Boolean(p.complete && pincode && line1 && (locality || city));
    return { pincode, label, line1, locality, city, state, complete };
}

/** "line1, locality, city, state pincode" — parts deduped so nothing repeats. */
export function composeAddress(u: Pick<AddressUnderstanding, "line1" | "locality" | "city" | "state" | "pincode">): string {
    const out: string[] = [];
    for (const part of [u.line1, u.locality, u.city]) {
        const p = (part || "").trim();
        if (!p) continue;
        const joined = norm(out.join(" "));
        if (joined && ` ${joined} `.includes(` ${norm(p)} `)) continue;
        out.push(p);
    }
    const tail = [u.state && !norm(out.join(" ")).includes(norm(u.state)) ? u.state : "", u.pincode].filter(Boolean).join(" ");
    return [...out, tail].filter(Boolean).join(", ");
}
