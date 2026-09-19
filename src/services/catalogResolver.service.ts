import type { McpCatalogHit } from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { normalizeOrderText } from "./saheliOrder.service";

const AUTO_RESOLVE_MIN = 0.82;
const DISAMBIGUATION_GAP = 0.12;

export type CatalogCandidate = {
    candidateId: string;
    name: string;
    matchedName?: string;
    pricePaise?: number;
    kind: "restaurant" | "dish" | "product";
    restaurantId?: string;
    restaurantName?: string;
    itemId?: string;
    spinId?: string;
    productId?: string;
    confidence: number;
};

export type CatalogResolveResult =
    | { status: "resolved"; candidate: CatalogCandidate; hit: McpCatalogHit }
    | { status: "disambiguation_required"; query: string; candidates: CatalogCandidate[] }
    | { status: "not_found"; query: string; message: string };

function tokenize(text: string): string[] {
    return normalizeOrderText(text)
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1);
}

function scoreHit(query: string, hit: McpCatalogHit, partner: McpPartnerKey): number {
    const qTokens = tokenize(query);
    const name = (hit.matchedName ?? hit.name).toLowerCase();
    if (!qTokens.length) return 0.1;

    const qNorm = qTokens.join(" ");
    if (name === qNorm) return 1;
    if (name.includes(qNorm)) return 0.92;
    if (qNorm.includes(name) && name.length > 4) return 0.88;

    let matched = 0;
    for (const t of qTokens) {
        if (name.includes(t)) matched += 1;
    }
    const overlap = matched / qTokens.length;
    let score = overlap * 0.75;
    if (matched === qTokens.length) score += 0.15;
    if (hit.pricePaise && hit.pricePaise > 0) score += 0.05;

    if (partner === "instamart" && hit.kind === "product") score += 0.08;
    if (partner === "swiggy" && hit.kind === "dish") score += 0.08;
    if (partner === "swiggy" && hit.kind === "restaurant" && qTokens.length <= 2) score -= 0.1;

    const sizeMatch = query.match(/\b(\d+)\s*(ml|l|ltr|litre|kg|g|gm|pack)\b/i);
    if (sizeMatch && name.includes(sizeMatch[0].toLowerCase())) score += 0.1;

    return Math.min(Math.max(score, 0), 1);
}

export function candidateIdForHit(hit: McpCatalogHit, index: number): string {
    return hit.itemId ?? hit.spinId ?? hit.productId ?? hit.restaurantId ?? `idx:${index}`;
}

export function rankCatalogHits(
    query: string,
    hits: McpCatalogHit[],
    partner: McpPartnerKey,
    limit = 10,
): CatalogCandidate[] {
    return hits
        .map((hit, index) => ({
            candidateId: candidateIdForHit(hit, index),
            name: hit.matchedName ?? hit.name,
            matchedName: hit.matchedName,
            pricePaise: hit.pricePaise ?? hit.costForTwoPaise,
            kind: (hit.kind ?? "product") as CatalogCandidate["kind"],
            restaurantId: hit.restaurantId,
            restaurantName: hit.restaurantName,
            itemId: hit.itemId,
            spinId: hit.spinId,
            productId: hit.productId,
            confidence: scoreHit(query, hit, partner),
        }))
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, limit);
}

export function resolveCatalogFromHits(
    query: string,
    hits: McpCatalogHit[],
    partner: McpPartnerKey,
): CatalogResolveResult {
    const ranked = rankCatalogHits(query, hits, partner, 8);
    const priced = ranked.filter((c) => c.kind !== "restaurant" && (c.pricePaise ?? 0) > 0);
    const pool = priced.length ? priced : ranked.filter((c) => c.kind !== "restaurant");
    const browse = pool.length ? pool : ranked;

    if (!browse.length) {
        return {
            status: "not_found",
            query,
            message: `No results for "${query}". Try a different name.`,
        };
    }

    const top = browse[0]!;
    const second = browse[1];
    const gap = second ? top.confidence - second.confidence : 1;

    if (top.confidence >= AUTO_RESOLVE_MIN && gap >= DISAMBIGUATION_GAP) {
        const hit =
            hits.find((h, i) => candidateIdForHit(h, i) === top.candidateId) ??
            hits[0]!;
        return { status: "resolved", candidate: top, hit };
    }

    if (top.confidence >= 0.95 && !second) {
        const hit =
            hits.find((h, i) => candidateIdForHit(h, i) === top.candidateId) ??
            hits[0]!;
        return { status: "resolved", candidate: top, hit };
    }

    return {
        status: "disambiguation_required",
        query,
        candidates: browse.slice(0, 5),
    };
}

export function findHitForCandidate(
    candidate: CatalogCandidate,
    hits: McpCatalogHit[],
): McpCatalogHit | undefined {
    return hits.find((h, i) => candidateIdForHit(h, i) === candidate.candidateId);
}
