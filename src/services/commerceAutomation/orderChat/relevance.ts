/**
 * Search-result relevance: drop condiments, sachets, add-ons, extras, token-priced items for
 * meals and mismatches, then let Gemini keep only what matches the elder's intent. Nothing
 * relevant → [] (the caller offers alternatives instead of listing junk).
 */
import { vertexGenerateText, parseJsonLoose, vertexFlashModel } from "../../../clients/vertexGemini.client";

const JUNK =
    /\b(ketchup|sauce|sachets?|dips?|mayo(?:nnaise)?|chutney|extra|add[\s-]?ons?|addon|cutlery|carry\s*bag|packaging|seasoning|oregano|chil+i\s*flakes|straws?|napkins?|tissue|raita\s*cup|pickle\s*sachet|salt\s*sachet|sugar\s*sachet|water\s*bottle\s*200|gift\s*card|donation|tip)\b/i;

export type Rankable = { name: string; pricePaise?: number; restaurantName?: string };

/** Pure pre-filter (unit-tested): condiments/add-ons unless asked for; items < ₹20 for meals. */
export function prefilter<T extends Rankable>(query: string, items: T[], opts: { food: boolean }): T[] {
    const askedJunk = JUNK.test(query);
    return items.filter((it) => {
        if (!askedJunk && JUNK.test(it.name)) return false;
        if (opts.food && typeof it.pricePaise === "number" && it.pricePaise > 0 && it.pricePaise < 2000) return false;
        return true;
    });
}

export async function filterRelevant<T extends Rankable>(intent: string, query: string, items: T[], opts: { food: boolean }): Promise<T[]> {
    const pre = prefilter(query, items, opts);
    if (!pre.length) return [];
    const list = pre.map((it, i) => `${i + 1}. ${it.name}${it.restaurantName ? ` (${it.restaurantName})` : ""}${typeof it.pricePaise === "number" ? ` ₹${Math.round(it.pricePaise / 100)}` : ""}`).join("\n");
    const raw = await vertexGenerateText({
        model: process.env.VERTEX_ROUTER_MODEL?.trim() || vertexFlashModel(),
        system:
            "You filter store search results for an elderly shopper. Keep ONLY items that genuinely match what she wants (the intent), best match first. Drop condiments, sachets, add-ons, extras, sides that aren't the dish, combos/meals far from the ask, non-food items for food asks, and anything that doesn't match (wrong product type, wrong flavour, wrong diet, e.g. non-veg for a veg ask, sugary for a sugar-free ask). If nothing matches, return an empty list. Return JSON {keep: [item numbers]}.",
        prompt: `Intent: ${intent}\nSearch words: ${query}\nResults:\n${list}`,
        responseSchema: { type: "OBJECT", properties: { keep: { type: "ARRAY", items: { type: "INTEGER" } } }, required: ["keep"] },
        timeoutMs: 6000,
        maxOutputTokens: 1024,
        thinkingLevel: "low",
    }).catch(() => null);
    const p = parseJsonLoose<{ keep?: number[] }>(raw);
    if (!p || !Array.isArray(p.keep)) return pre; // model down → the deterministic filter only
    const seen = new Set<number>();
    return p.keep
        .map((n) => Math.floor(Number(n)) - 1)
        .filter((i) => i >= 0 && i < pre.length && !seen.has(i) && (seen.add(i), true))
        .map((i) => pre[i]!);
}
