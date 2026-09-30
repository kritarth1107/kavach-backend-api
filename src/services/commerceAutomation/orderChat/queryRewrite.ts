/**
 * Catalog queries are rewritten from the conversation before a store search.
 * "10g" on a protein bar is the size, "berry" is the flavour — neither is a product name.
 * A follow-up keeps the brand and line already on the table (RiteBite Max Protein),
 * and a named flavour is never swapped for a different brand or flavour.
 */

const FILLER = new Set([
    "i", "want", "the", "one", "please", "a", "an", "flavor", "flavour", "flavored", "flavoured",
    "bar", "of", "me", "get", "order", "some", "max", "protein", "with", "for", "that", "this",
    "g", "and", "nut", "fruit", "protien",
]);

export function fixOrderTypos(text: string): string {
    return String(text || "")
        .replace(/\bprotien\b/gi, "protein")
        .replace(/\brite\s*bite\b/gi, "RiteBite")
        .replace(/\britebite\b/gi, "RiteBite");
}

/** Brand + line, when the text actually names one. Yoga Bar is never inferred from a RiteBite ask. */
export function brandLineOf(text: string): string | null {
    const t = fixOrderTypos(text);
    if (/\britebite\b/i.test(t) && /\bmax\b/i.test(t)) return "RiteBite Max Protein";
    if (/\britebite\b/i.test(t)) return "RiteBite";
    if (/\byoga\s*bar\b/i.test(t)) return "Yoga Bar";
    return null;
}

const FLAVOURS: Array<[string, RegExp]> = [
    ["fruit and nut", /fruit\s*(?:&|and)\s*nut/i],
    ["blueberry", /\bblueberry\b/i],
    ["berry", /\bberr(?:y|ies)\b/i],
    ["chocolate", /\b(?:chocolate|choco)\b/i],
    ["almond", /\balmond\b/i],
    ["brownie", /\bbrownie\b/i],
    ["mango", /\bmango\b/i],
];

export function flavourOf(text: string): string | null {
    const t = fixOrderTypos(text);
    for (const [name, re] of FLAVOURS) if (re.test(t)) return name;
    return null;
}

export function gramsOf(text: string): string | null {
    const m = fixOrderTypos(text).match(/\b(\d+)\s*g\b/i);
    return m ? `${m[1]}g` : null;
}

function nameHasFlavour(name: string, flavour: string): boolean {
    const t = name.toLowerCase();
    if (flavour === "berry") return /\bberr(?:y|ies)\b/.test(t);
    if (flavour === "fruit and nut") return /fruit\s*(?:&|and)\s*nut/.test(t);
    if (flavour === "chocolate") return /\b(?:chocolate|choco)\b/.test(t);
    return new RegExp(`\\b${flavour}\\b`, "i").test(name);
}

function nameHasGrams(name: string, grams: string): boolean {
    const n = grams.replace(/g$/i, "");
    return new RegExp(`\\b${n}\\s*g\\b`, "i").test(name);
}

/** A short follow-up ("the 10g berry one") refers to the product already on the table. */
export function isReferentialFollowUp(utterance: string): boolean {
    const said = fixOrderTypos(utterance);
    if (/\b(the|that|this)\b/i.test(said) && /\bone\b/i.test(said)) return true;
    if (!flavourOf(said) && !gramsOf(said)) return false;
    const drop = new Set(FILLER);
    const flav = flavourOf(said);
    if (flav) for (const w of flav.split(/\s+/)) drop.add(w);
    const left = said
        .toLowerCase()
        .replace(/\d+\s*g\b/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w && !drop.has(w) && w !== "ritebite");
    return left.length === 0;
}

function contextBrand(priorQuery: string | null | undefined, shownNames: string[]): string | null {
    const fromPrior = priorQuery ? brandLineOf(priorQuery) : null;
    if (fromPrior) return fromPrior;
    const counts = new Map<string, number>();
    for (const name of shownNames) {
        const b = brandLineOf(name);
        if (!b) continue;
        counts.set(b, (counts.get(b) || 0) + 1);
    }
    let best: string | null = null;
    let n = 0;
    for (const [b, c] of counts) {
        if (c > n) {
            best = b;
            n = c;
        }
    }
    return best;
}

/**
 * Search string: brand + line + flavour + size.
 * The router query is kept when this message is a new product (amul milk stays amul milk).
 */
/** Hindi catalog words the stores don't search. Everything else in Devanagari is dropped, not guessed. */
export function latinCatalogQuery(query: string): string {
    let t = String(query || "");
    t = t.replace(/प्रोटीन\s*बार/gi, "protein bar");
    t = t.replace(/प्रोटीन/gi, "protein");
    t = t.replace(/[\u0900-\u097F]+/g, " ");
    return fixOrderTypos(t).replace(/\s+/g, " ").trim();
}

/**
 * Queries to send a linked store, in order.
 * A Hindi protein ask is searched as "protein bar", then once as "RiteBite Max Protein"
 * if that first search does not come back with items.
 */
export function catalogSearchQueries(query: string): string[] {
    const raw = String(query || "").trim();
    if (!raw) return [];
    const latin = latinCatalogQuery(raw);
    const first = (latin || raw).slice(0, 80);
    const out = [first];
    if (/protein|प्रोटीन/i.test(`${raw} ${first}`)) {
        for (const extra of ["protein bar", "RiteBite Max Protein"]) {
            if (!out.some((x) => x.toLowerCase() === extra.toLowerCase())) out.push(extra);
        }
    }
    return out;
}

/** A follow-up while she is still confirming the address keeps the brand already on the table. */
export function refinePendingQuery(prior: string, routerQuery: string, utterance: string): string {
    const next = rewriteProductQuery(routerQuery, utterance, { priorQuery: prior });
    return (next || prior || routerQuery).slice(0, 80);
}

export function rewriteProductQuery(
    routerQuery: string,
    utterance: string,
    ctx: { priorQuery?: string | null; shownNames?: string[] } = {},
): string {
    const said = utterance || routerQuery || "";
    const flavour = flavourOf(said);
    const grams = gramsOf(said);
    const saidBrand = brandLineOf(said);
    const brand = saidBrand || (isReferentialFollowUp(said) ? contextBrand(ctx.priorQuery, ctx.shownNames || []) : null);
    if (brand && (flavour || grams)) {
        return [brand, flavour, grams].filter(Boolean).join(" ").slice(0, 80);
    }
    const base = fixOrderTypos(routerQuery || utterance).replace(/\s+/g, " ").trim();
    return base.slice(0, 80);
}

function missText(query: string, brand: string, sameLine: { name: string }[]): string {
    const head = `I couldn't find ${query}.`;
    if (!sameLine.length) return `${head}\nI won't substitute a different brand.`;
    const lines = sameLine.slice(0, 3).map((h, i) => `${i + 1}. ${h.name} — not an exact match`);
    return `${head}\nThese are other ${brand} options, not an exact match:\n${lines.join("\n")}`;
}

/** Drop other brands and other flavours. A miss lists only the same line, labelled as not exact. */
export function applyFaithfulHits<T extends { name: string }>(
    query: string,
    hits: T[],
): { hits: T[]; miss: string | null } {
    const brand = brandLineOf(query);
    if (!brand) return { hits, miss: null };
    const flavour = flavourOf(query);
    const grams = gramsOf(query);
    const same = hits.filter((h) => {
        const b = brandLineOf(h.name);
        if (!b) return false;
        if (brand === "RiteBite Max Protein") return b === "RiteBite Max Protein" || b === "RiteBite";
        return b === brand;
    });
    const exact = same.filter((h) => {
        if (flavour && !nameHasFlavour(h.name, flavour)) return false;
        if (grams && !nameHasGrams(h.name, grams)) return false;
        return true;
    });
    if ((flavour || grams) && exact.length === 0) return { hits: [], miss: missText(query, brand, same) };
    if (exact.length) return { hits: exact, miss: null };
    if (same.length) return { hits: same, miss: null };
    return { hits: [], miss: missText(query, brand, []) };
}
