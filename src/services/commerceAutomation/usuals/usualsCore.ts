/**
 * Pure helpers for the usuals profile (no DB) — concept keys, matching, choice count, copy.
 */
import type { UsualItem, UsualRejection } from "../../../models/elderUsuals.model";

/** Hindi/Hinglish → concept. Small on purpose: the key only has to match her own past asks. */
const SYN: Array<[RegExp, string]> = [
    [/\b(doodh|dudh|milk)\b|दूध/i, "milk"],
    [/\b(anda|ande|anday|eggs?)\b|अंडे?/i, "eggs"],
    [/\b(dahi|curd|yogh?urt)\b|दही/i, "curd"],
    [/\b(paneer)\b|पनीर/i, "paneer"],
    [/\b(bread|double\s*roti|pav)\b/i, "bread"],
    [/\b(atta|aata|flour)\b|आटा/i, "atta"],
    [/\b(chawal|rice)\b|चावल/i, "rice"],
    [/\b(chai\s*patti|tea\s*(?:leaves|powder)?|chai)\b|चाय/i, "tea"],
    [/\b(cheeni|chini|sugar)\b|शक्कर/i, "sugar"],
    [/\b(makhan|butter)\b|मक्खन/i, "butter"],
    [/\b(sabzi|sabji|vegetables?)\b|सब्ज़ी/i, "vegetables"],
    [/\b(phal|fruits?)\b|फल/i, "fruits"],
    [/\b(biscuits?|biskut)\b/i, "biscuits"],
    [/\b(namkeen)\b/i, "namkeen"],
    [/\b(pani|water\s*bottle|bisleri)\b/i, "water"],
];
const STOP = /\b(mangwa|mangva|mangao|manga|do|dena|de|chahiye|chaiye|please|pls|order|karo|kar|lao|la|mujhe|mere|liye|se|from|some|a|an|the|ek|thoda|aur|bhi|wala|wali|usual|hamesha|jo|roz|daily|wahi|same)\b/gi;

export function conceptKey(text: string | null | undefined): string {
    const t = String(text || "").toLowerCase();
    for (const [re, key] of SYN) if (re.test(t)) return key;
    return t.replace(STOP, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);

/** Does this ask name something different from the usual ("Amul Gold" vs usual Lactose Free)? */
export function asksForDifferentProduct(query: string, usual: UsualItem): boolean {
    const key = conceptKey(query);
    const q = words(query.replace(STOP, " ")).filter((w) => !new RegExp(`\\b${key}\\b`).test(w) && w !== key);
    const name = usual.name.toLowerCase();
    // Extra specific words (brand/variant) that the usual doesn't have → a different product.
    return q.some((w) => !name.includes(w) && !usual.aliases.some((a) => a.toLowerCase().includes(w)) && !/^(doodh|dudh|milk|litre|liter|ltr|packet|pack)$/.test(w));
}

/** Same product, ignoring pack size / brackets ("Amul Taaza Toned Milk" ≈ "Amul Taaza Toned Milk (1 ltr)"). */
const coreWords = (x: string) => new Set(words(x.replace(/\([^)]*\)/g, " ")).filter((w) => !/^\d/.test(w) && !/^(ltr|litre|liter|pcs|pack|gm|kg|ml)$/.test(w)));
/** Her query names this exact product (every core word of it). */
export function namesProduct(query: string, item: string): boolean {
    const q = coreWords(query), i = coreWords(item);
    return i.size > 0 && [...i].every((w) => q.has(w));
}
export function sameProduct(a: string, b: string): boolean {
    const t = (x: string) => new Set(words(x.replace(/\([^)]*\)/g, " ")).filter((w) => !/^\d/.test(w) && !/^(ltr|litre|liter|pcs|pack|gm|kg|ml)$/.test(w)));
    const A = t(a), B = t(b);
    if (!A.size || !B.size) return false;
    const [s, l] = A.size <= B.size ? [A, B] : [B, A];
    return [...s].every((w) => l.has(w));
}

export function recentlyRejected(item: string, rejections: UsualRejection[], since?: Date): UsualRejection | null {
    const cutoff = Date.now() - 60 * 86_400_000;
    const hits = rejections.filter((r) => r.item && sameProduct(item, r.item) && new Date(r.at).getTime() > cutoff && (!since || new Date(r.at) > since));
    return hits.length ? hits[hits.length - 1]! : null;
}

/**
 * Match a familiar ask to a usual. Only concrete, repeated-or-recent usuals; a named different
 * product, another platform, or a decline after the last order all mean "not the usual".
 */
export function matchUsual(
    items: UsualItem[],
    rejections: UsualRejection[],
    ask: { query?: string | null; text: string; category?: string | null; partners?: string[] },
): UsualItem | null {
    const q = ask.query || ask.text;
    const key = conceptKey(q);
    if (!key) return null;
    const cands = items
        .filter((u) => u.key === key || u.aliases.some((a) => conceptKey(a) === key))
        .filter((u) => !ask.category || ask.category === "other" || u.category === ask.category || (ask.category === "food" && u.category === "grocery" && key !== "food"))
        .filter((u) => !ask.partners?.length || ask.partners.includes(u.partner))
        .filter((u) => !recentlyRejected(u.name, rejections, new Date(u.lastAt)))
        .sort((a, b) => b.count - a.count || +new Date(b.lastAt) - +new Date(a.lastAt));
    const best = cands[0];
    if (!best) return null;
    if (asksForDifferentProduct(q, best)) return null;
    return best;
}

const toks = (s: string) => words(s).filter((w) => !/^(the|and|with|pack|of)$/.test(w));

/**
 * How many choices to show: the usual → just it; a clear ask where exactly one result has every
 * word she said → 1; otherwise at most 3 (never 5). Past declines are dropped unless she named them.
 */
export function shapeChoices<T extends { name: string }>(query: string, opts: T[], ctx: { usual?: { name: string } | null; rejections?: UsualRejection[] } = {}): { shown: T[]; usualHit: boolean } {
    let list = opts;
    if (ctx.rejections?.length) {
        const kept = list.filter((o) => {
            const r = recentlyRejected(o.name, ctx.rejections!);
            return !r || namesProduct(query, r.item);
        });
        if (kept.length) list = kept;
    }
    if (ctx.usual) {
        const u = toks(ctx.usual.name);
        const scored = list.map((o) => ({ o, s: u.filter((w) => o.name.toLowerCase().includes(w)).length / Math.max(1, u.length) })).sort((a, b) => b.s - a.s);
        if (scored[0] && scored[0].s >= 0.6) return { shown: [scored[0].o], usualHit: true };
    }
    const q = toks(query);
    if (q.length >= 2) {
        const full = list.filter((o) => q.every((w) => o.name.toLowerCase().includes(w.replace(/s$/, ""))));
        if (full.length === 1) return { shown: full, usualHit: false };
    }
    return { shown: list.slice(0, 3), usualHit: false };
}

const EMOJI: Record<string, string> = { milk: "🥛", eggs: "🥚", curd: "🥣", bread: "🍞", tea: "🍵", fruits: "🍎", vegetables: "🥬", paneer: "🧀", water: "💧" };
export function usualEmoji(key: string, category: string): string {
    return EMOJI[key] || (category === "food" ? "🍽️" : category === "pharmacy" ? "💊" : "🛒");
}

/** Instant first reply for a usual (no model call — sent right after routing). */
export function usualAck(u: UsualItem): string {
    const short = u.key && u.key.split(" ").length <= 2 ? u.key : u.name;
    return `Getting your usual ${short} ${usualEmoji(u.key, u.category)}`;
}
