/**
 * Guest / public catalog search — NO login, NO OTP, NO Continue click.
 * Used to WhatsApp exact product name + price before opening partner login.
 *
 * Sources:
 * - Apollo: public accessToken + search-service/v5/fullSearch
 * - PharmEasy: public /api/search/search
 * - Instamart: our headless browser as guest, location set to the Kavach address (never MCP)
 * - Swiggy food: restaurant → dish flow (swiggyGuest.service), not a flat list
 * - Zepto / Blinkit / Zomato: no guest browsing yet — honest empty (never MCP, never invent prices)
 * - Others: honest empty result (never invent prices)
 */
import { randomUUID } from "crypto";
import type { CommercePartnerKey, SearchHit } from "./types";
import { searchMcpProduct } from "../../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../../partners/mcp/types";
import { getMcpConnectionStatus } from "../../partners/mcp/mcpClient.service";
import { resolveFamilyMcpUserId } from "../commerceConnection.service";
import { getDefaultPartnerAddressId } from "../partnerAddress.service";

export type GuestCatalogHit = SearchHit & {
    packLabel?: string;
    productUrl?: string;
    mrpPaise?: number;
    /** Live stock at the delivery pincode when the partner reports it. */
    inStock?: boolean;
    source: "apollo_public" | "pharmeasy_public" | "mcp" | "browser_guest" | "none";
};

export type GuestCatalogSearchResult = {
    hits: GuestCatalogHit[];
    /** True when a live catalog was queried (even if zero hits). */
    searched: boolean;
    /** Human reason when price/SKU cannot be shown without login. */
    unavailableReason?: string;
    partner: CommercePartnerKey | string;
    query: string;
};

const APOLLO_AUTH = "https://apigateway.apollo247.in/auth-service/accessToken";
const APOLLO_SEARCH = "https://apigateway.apollo247.in/search-service/v5/fullSearch";
const PHARMEASY_SEARCH = "https://pharmeasy.in/api/search/search/";

const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/** Short-lived Apollo public token cache (tokens last hours; refresh early). */
let apolloTokenCache: { token: string; expiresAtMs: number } | null = null;

function rupeesToPaise(raw: unknown): number | undefined {
    if (raw == null) return undefined;
    const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.round(n * 100);
}

function formatInr(paise?: number): string {
    if (typeof paise !== "number" || !Number.isFinite(paise)) return "";
    const rupees = paise / 100;
    return Number.isInteger(rupees) ? `₹${rupees}` : `₹${rupees.toFixed(2)}`;
}

/** "vitamin c", "vit c", typo "bitamic c", "vitamin-c", "ascorbic". */
export function isVitaminCQuery(query: string): boolean {
    return /\b[bv]i?t[a-z]{0,6}\s*-?\s*c\b|\bascorbic\b|\bvito-?c\b/i.test(query);
}

/** Query for "similar in-stock items" when the exact SKU is unavailable. */
export function alternativeQueryForSku(name: string): string {
    const n = (name || "").toLowerCase();
    if (isVitaminCQuery(n) || /\b(limcee|celin|sukcee|lemonsec)\b/.test(n)) return "vitamin c";
    const first = n.replace(/\(.*?\)/g, " ").replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((t) => t.length >= 3)[0];
    return first || n.slice(0, 40);
}

const NON_ORAL_RE = /\b(injection|inj|ampoule|vial|infusion|iv)\b/i;

/**
 * Strip ordering chatter so the catalog sees only the product:
 * "order vitamin c from apollo" → "vitamin c".
 */
export function normalizeCatalogQuery(raw: string): string {
    const q = (raw || "")
        .replace(/\b(?:from|on|via|at|using|with)\s+(?:apollo(?:\s*pharmacy)?|pharm\s*easy|tata\s*1\s*mg|1\s*mg|tata)\b/gi, " ")
        .replace(/\b(apollo\s*pharmacy|apollo|pharmeasy|pharm\s*easy|tata\s*1\s*mg|1mg)\b/gi, " ")
        .replace(/\b(order|buy|get|purchase|shop|please|pls|mujhe|chahiye|mangao|send|deliver|me|for)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    return q || (raw || "").trim();
}

const VIT_C_BRAND_RE = /\b(limcee|celin|sukcee|vito-?c|redoxon)\b/i;
const VIT_C_NAME_RE = /vitamin[-\s]*c\b|\bvit\.?\s*c\b|ascorbic/i;
/** Combos / other supplements that merely mention vitamin C somewhere in a long title. */
const VIT_C_NOISE_RE =
    /\b(multi|multivitamin|omega|cod\s*liver|fish\s*oil|glutathione|collagen|biotin|b-?12|b\s*complex|d3|calcium|iron|hair|skin|glow|serum|cream|gel|face|lotion|mask|toner|sunscreen|protein|whey|amla\s*juice)\b/i;

/** True single-ingredient-style vitamin C OTC product (Limcee, Celin, "Vitamin-C 500" …). */
export function isTrueVitaminCProduct(name: string): boolean {
    const n = name.toLowerCase();
    if (NON_ORAL_RE.test(n)) return false;
    if (VIT_C_BRAND_RE.test(n)) return true;
    const head = n.replace(/\(.*?\)/g, " ").slice(0, 60);
    if (!VIT_C_NAME_RE.test(head)) return false;
    return !VIT_C_NOISE_RE.test(n);
}

function vitaminCScore(query: string, h: GuestCatalogHit): number {
    const n = h.name.toLowerCase();
    let s = 0;
    if (/\blimcee\b/.test(n) && /500/.test(n) && !/zinc/.test(n)) s += 40;
    else if (/\bcelin\b/.test(n) && /500/.test(n)) s += 34;
    else if (/^vitamin[-\s]*c\s*500\b/.test(n)) s += 30;
    else if (/\blimcee\b|\bcelin\b|\bsukcee\b/.test(n)) s += 20;
    else s += 10;
    if (/\b(chewable|tablet|tablets|strip)\b/.test(n)) s += 6;
    if (/effervescent|bottle|gumm/.test(n)) s -= 4;
    if (/capsule/.test(n)) s += /capsule/i.test(query) ? 4 : -2;
    if (/\bzinc\b/.test(n) && !/zinc/i.test(query)) s -= 6;
    if (h.inStock === true) s += 3;
    return s;
}

/**
 * Vitamin C asks: only true vitamin C OTC oral products, in stock at the pincode,
 * never Rx / injections, ranked Limcee 500 → Celin 500 → Vitamin-C 500 chewable → rest.
 */
export function rankVitaminCHits(query: string, hits: GuestCatalogHit[]): GuestCatalogHit[] {
    const clean = hits.filter(
        (h) => !h.requiresRx && h.inStock !== false && isTrueVitaminCProduct(h.name),
    );
    return clean.sort(
        (a, b) =>
            vitaminCScore(query, b) - vitaminCScore(query, a) ||
            (a.pricePaise ?? 1e9) - (b.pricePaise ?? 1e9) ||
            a.name.length - b.name.length,
    );
}
/** "wet wipes", "baby wipes", "wipes". */
export function isWipesQuery(query: string): boolean {
    return /\bwipes?\b/i.test(query);
}

/** Wipes that aren't everyday baby / personal wet wipes (makeup, eyelid, surface, intimate, combos). */
const WIPES_NOISE_RE =
    /\b(make-?up|remover|niacinamide|hyaluronic|ocu-?wipes|eye|eyelid|intimate|feminine|vaginal|toilet|surface|disinfectant|floor|lens|glass|diapers?|combo|compo|pet|dog|cat)\b/i;
const WIPES_BRAND_RE =
    /\b(chicco|johnson'?s|himalaya|mother\s*sparsh|little'?s|apollo\s*(life|essentials|pharmacy)|luvlap|babio|pampers|huggies|mamy\s*poko|sebamed|mee\s*mee|savlon|baby\s*forest|doctor'?s\s*choice|dettol)\b/i;

/** Everyday OTC baby / personal wet wipes pack (not makeup / eyelid / surface / combo). */
export function isEverydayWetWipes(name: string): boolean {
    const n = name.replace(/\(.*?\)/g, " ");
    return /\bwipes?\b/i.test(n) && !WIPES_NOISE_RE.test(n);
}

/** Total wipes in the pack: "72 Count", "2x80", "30 Units", "(2x30 Wipes)". */
export function wipesCount(name: string): number | undefined {
    const x = name.match(/(\d{1,2})\s*x\s*(\d{1,3})/i);
    if (x) return Number(x[1]) * Number(x[2]);
    const c = name.match(/(\d{1,3})\s*(count|units?|wipes|pcs|pieces|s)\b/i);
    return c ? Number(c[1]) : undefined;
}

function wipesScore(query: string, h: GuestCatalogHit): number {
    const n = h.name.toLowerCase();
    let s = 0;
    if (WIPES_BRAND_RE.test(n)) s += 10;
    if (/\b(wet|baby)\s*wipes\b/.test(n)) s += 8;
    if (/\bbaby\b/i.test(query) && /\bbaby\b/.test(n)) s += 4;
    const count = wipesCount(h.name);
    if (typeof count === "number") {
        if (count >= 50 && count <= 100) s += 4;
        else if (count > 100) s += 1;
        else if (count < 25) s -= 2;
    }
    const p = h.pricePaise ?? 1e9;
    if (p <= 15_000) s += 4;
    else if (p <= 25_000) s += 1;
    else if (p > 40_000) s -= 4;
    if (h.inStock === true) s += 3;
    return s;
}

/** Wet-wipes asks: everyday OTC wipes in stock at the pincode, known brands, mid-size, cheap first. */
export function rankWipesHits(query: string, hits: GuestCatalogHit[]): GuestCatalogHit[] {
    const clean = hits.filter((h) => !h.requiresRx && h.inStock !== false && isEverydayWetWipes(h.name));
    return clean.sort(
        (a, b) =>
            wipesScore(query, b) - wipesScore(query, a) ||
            (a.pricePaise ?? 1e9) - (b.pricePaise ?? 1e9) ||
            a.name.length - b.name.length,
    );
}

const TOPICAL_RE = /\b(cream|serum|gel|face\s*wash|lotion|toner|sunscreen|mask)\b/i;

/** Prefer names that contain query tokens (e.g. vitamin+c → Limcee Vit C, not Evion Vit E). */
function rankGuestHits(query: string, hits: GuestCatalogHit[]): GuestCatalogHit[] {
    const tokens = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 1 && !["mg", "ml", "the", "and", "for"].includes(t));
    const score = (name: string): number => {
        const n = name.toLowerCase();
        let s = 0;
        for (const tok of tokens) {
            if (n.includes(tok)) s += tok.length >= 3 ? 3 : 1;
        }
        const hit = hits.find((h) => h.name === name);
        const wantsInjection = NON_ORAL_RE.test(query) || /\brx\b/i.test(query);
        // Rx injections / vials never outrank OTC oral SKUs unless explicitly asked for
        if (!wantsInjection && (hit?.requiresRx || NON_ORAL_RE.test(n))) s -= 60;
        // Out of stock at the delivery pincode → bottom
        if (hit?.inStock === false) s -= 100;
        // Boost classic OTC Vit C brands / SKUs (Limcee name has no "vitamin" token)
        if (isVitaminCQuery(query)) {
            if (!TOPICAL_RE.test(query) && TOPICAL_RE.test(n)) s -= 12;
            if (/\b(tablet|chewable|capsule|effervescent)\b/i.test(n)) s += 3;
            if (/\blimcee\b/i.test(n) && !/zinc/i.test(n)) s += 20;
            else if (/\bcelin\b|\bsukcee\b|\blimcee\b/i.test(n)) s += 14;
            if (/vitamin[-\s]*c|ascorbic/i.test(n) && /500/i.test(n) && /tablet|chewable/i.test(n)) s += 6;
            // Prefer compact tablet strips over large bottles for default "vitamin c"
            if (/\b(15|10|20)\b/.test(n) && /tablet|strip|chewable/i.test(n) && !/bottle|60|effervescent/i.test(n)) {
                s += 4;
            }
            if (/vitamin\s*e\b|\bevion\b/i.test(n) && !/vitamin\s*c/i.test(n)) s -= 999;
        }
        if (typeof hits.find((h) => h.name === name)?.pricePaise === "number") s += 1;
        return s;
    };
    return [...hits].sort((a, b) => score(b.name) - score(a.name) || a.name.length - b.name.length);
}

/** Drop fuzzy catalog noise (e.g. "unicorn dust" → Unicorn syrup) — require token coverage. */
function filterWeakHits(query: string, hits: GuestCatalogHit[]): GuestCatalogHit[] {
    const tokens = query
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !["the", "and", "for", "with"].includes(t));
    if (tokens.length < 2 || !hits.length) return hits;
    const strong = hits.filter((h) => {
        const n = h.name.toLowerCase();
        const matched = tokens.filter((t) => n.includes(t)).length;
        return matched >= 2 || tokens.every((t) => n.includes(t));
    });
    return strong;
}

function dedupeHits(hits: GuestCatalogHit[]): GuestCatalogHit[] {
    const seen = new Set<string>();
    const out: GuestCatalogHit[] = [];
    for (const h of hits) {
        const key = `${(h.id || "").toLowerCase()}|${h.name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(h);
    }
    return out;
}

async function fetchJson(
    url: string,
    init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; json: unknown }> {
    const { timeoutMs = 12_000, ...rest } = init;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...rest, signal: ctrl.signal });
        const json = await res.json().catch(() => null);
        return { ok: res.ok, status: res.status, json };
    } catch {
        return { ok: false, status: 0, json: null };
    } finally {
        clearTimeout(t);
    }
}

async function mintApolloPublicToken(): Promise<string | null> {
    const now = Date.now();
    if (apolloTokenCache && apolloTokenCache.expiresAtMs > now + 60_000) {
        return apolloTokenCache.token;
    }
    const url = `${APOLLO_AUTH}?_nonce=${randomUUID()}`;
    const { ok, json } = await fetchJson(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "User-Agent": UA,
            "x-source-service": "PHARMA_AP_IN",
            "x-app-os": "web",
            Origin: "https://www.apollopharmacy.in",
            Referer: "https://www.apollopharmacy.in/",
        },
    });
    const token =
        (json as { accessToken?: string } | null)?.accessToken ||
        (json as { data?: { accessToken?: string } } | null)?.data?.accessToken ||
        null;
    if (!ok || !token) return null;
    // Public tokens are typically ~12h; refresh after 6h locally.
    apolloTokenCache = { token, expiresAtMs: now + 6 * 60 * 60 * 1000 };
    return token;
}

async function searchApolloPublic(query: string, pincode = ""): Promise<GuestCatalogHit[]> {
    const token = await mintApolloPublicToken();
    if (!token) return [];
    const { ok, json } = await fetchJson(APOLLO_SEARCH, {
        method: "POST",
        headers: {
            Accept: "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "User-Agent": UA,
            authorization: token,
            "x-source-service": "PHARMA_AP_IN",
            "x-app-os": "web",
            "x-device-id": randomUUID(),
            "x-token": "",
            Origin: "https://www.apollopharmacy.in",
            Referer: `https://www.apollopharmacy.in/search-medicines/${encodeURIComponent(query)}`,
        },
        body: JSON.stringify({
            query,
            page: 1,
            productsPerPage: 16,
            selSortBy: "relevance",
            filters: [],
            pincode: pincode || "",
        }),
    });
    if (!ok || !json) return [];
    const root = json as {
        errorCode?: number;
        data?: { productDetails?: { products?: Array<Record<string, unknown>> } };
    };
    if (root.errorCode && root.errorCode !== 0) return [];
    const products = root.data?.productDetails?.products ?? [];
    const hits: GuestCatalogHit[] = [];
    for (const p of products) {
        const name = String(p.name || p.productName || "").trim();
        if (!name) continue;
        const pricePaise =
            rupeesToPaise(p.specialPrice) ?? rupeesToPaise(p.price) ?? rupeesToPaise(p.sellingPrice);
        if (!pricePaise) continue;
        const labels = (p.additionalDetails as { labels?: string[] } | undefined)?.labels;
        const packLabel = Array.isArray(labels) ? labels.filter(Boolean).join(" · ") : undefined;
        const urlKey = p.urlKey ? String(p.urlKey) : undefined;
        hits.push({
            id: String(p.sku || p.id || name),
            name: packLabel ? `${name} (${packLabel})` : name,
            pricePaise,
            mrpPaise: rupeesToPaise(p.price) ?? rupeesToPaise(p.mrp),
            requiresRx: Number(p.isPrescriptionRequired) === 1,
            packLabel,
            inStock:
                pincode && typeof p.status === "string"
                    ? !/out[-\s]*of[-\s]*stock|unavailable/i.test(String(p.status))
                    : undefined,
            productUrl: urlKey ? `https://www.apollopharmacy.in/otc/${urlKey}` : undefined,
            source: "apollo_public",
        });
        if (hits.length >= 12) break;
    }
    return hits;
}

async function searchPharmeasyPublic(query: string): Promise<GuestCatalogHit[]> {
    const url = `${PHARMEASY_SEARCH}?q=${encodeURIComponent(query)}&page=1`;
    const { ok, json } = await fetchJson(url, {
        method: "GET",
        headers: {
            Accept: "application/json",
            "User-Agent": UA,
            Referer: "https://pharmeasy.in/",
        },
    });
    if (!ok || !json) return [];
    const products =
        ((json as { data?: { products?: Array<Record<string, unknown>> } }).data?.products as
            | Array<Record<string, unknown>>
            | undefined) ?? [];
    const hits: GuestCatalogHit[] = [];
    for (const p of products) {
        const name = String(p.name || "").trim();
        const pricePaise = rupeesToPaise(p.salePriceDecimal ?? p.salePrice ?? p.mrpDecimal);
        if (!name || !pricePaise) continue;
        // Skip category/lab stubs (entityType quirks / no real productId)
        if (!p.productId || Number(p.productId) <= 1) continue;
        const pack = p.measurementUnit ? String(p.measurementUnit) : undefined;
        const slug = p.slug ? String(p.slug) : undefined;
        hits.push({
            id: String(p.productId),
            name: pack ? `${name} (${pack})` : name,
            pricePaise,
            mrpPaise: rupeesToPaise(p.mrpDecimal),
            requiresRx: Number(p.isRxRequired) === 1,
            packLabel: pack,
            productUrl: slug ? `https://pharmeasy.in/p/${slug}` : undefined,
            source: "pharmeasy_public",
        });
        if (hits.length >= 8) break;
    }
    return hits;
}

async function searchMcpGuest(input: {
    partner: McpPartnerKey;
    familyId?: string;
    userId?: string;
    query: string;
}): Promise<GuestCatalogHit[]> {
    if (!input.familyId || !input.userId) return [];
    const mcpUserId =
        (await resolveFamilyMcpUserId(input.familyId, input.partner, input.userId)) ?? input.userId;
    const status = await getMcpConnectionStatus(input.partner, input.familyId, mcpUserId);
    if (!status.connected) return [];
    const addressId = await getDefaultPartnerAddressId(input.familyId, input.partner, mcpUserId);
    const result = await searchMcpProduct(input.partner, input.familyId, mcpUserId, input.query, {
        addressId: addressId ?? undefined,
    });
    if (result.error) return [];
    const hits: GuestCatalogHit[] = [];
    for (const h of result.items ?? []) {
        if (!h.name || !h.pricePaise) continue;
        hits.push({
            id: String(
                (h as { itemId?: string; id?: string }).itemId ??
                    (h as { id?: string }).id ??
                    h.name,
            ),
            name: h.name,
            pricePaise: h.pricePaise,
            source: "mcp",
        });
        if (hits.length >= 5) break;
    }
    return hits;
}

/**
 * Search partner catalog without login/OTP.
 * Never invents prices — empty hits + unavailableReason when live catalog unreachable.
 */
export async function searchGuestCatalog(input: {
    partner: CommercePartnerKey | string;
    query: string;
    familyId?: string;
    userId?: string;
    /** Delivery pincode — Apollo reports per-pincode stock; OOS SKUs are dropped. */
    pincode?: string;
}): Promise<GuestCatalogSearchResult> {
    const partner = String(input.partner || "").toLowerCase() as CommercePartnerKey;
    const query = normalizeCatalogQuery(input.query).slice(0, 120);
    if (!query) {
        return {
            hits: [],
            searched: false,
            unavailableReason: "Empty search query.",
            partner,
            query,
        };
    }

    try {
        if (partner === "apollo") {
            const pin = /^[1-9]\d{5}$/.test(String(input.pincode || "")) ? String(input.pincode) : "";
            if (isVitaminCQuery(query)) {
                // Canonical searches (typos like "bitamic c" / "vit c tablets" return junk upstream).
                const queries = Array.from(new Set(["vitamin c", "limcee", "celin", query.toLowerCase()]));
                const lists = await Promise.all(queries.map((q) => searchApolloPublic(q, pin)));
                const hits = rankVitaminCHits(query, dedupeHits(lists.flat()));
                return {
                    hits,
                    searched: true,
                    unavailableReason:
                        hits.length === 0
                            ? `No in-stock vitamin C tablets on Apollo${pin ? ` for ${pin}` : ""} right now. Try another name.`
                            : undefined,
                    partner,
                    query,
                };
            }
            if (isWipesQuery(query)) {
                // Canonical searches so "wet wipes" also sees everyday baby wipes (and vice versa).
                const queries = Array.from(new Set(["wet wipes", "baby wipes", query.toLowerCase()]));
                const lists = await Promise.all(queries.map((q) => searchApolloPublic(q, pin)));
                const hits = rankWipesHits(query, dedupeHits(lists.flat()));
                return {
                    hits,
                    searched: true,
                    unavailableReason:
                        hits.length === 0
                            ? `No in-stock wet wipes on Apollo${pin ? ` for ${pin}` : ""} right now. Try another name.`
                            : undefined,
                    partner,
                    query,
                };
            }
            let raw = await searchApolloPublic(query, pin);
            // Drop SKUs Apollo says are out of stock at this pincode (keep all if that empties the list)
            const stocked = raw.filter((h) => h.inStock !== false);
            if (stocked.length) raw = stocked;
            const hits = filterWeakHits(
                query,
                rankGuestHits(query, raw).filter((h) => {
                    // Never offer Vitamin E / Evion for a Vit C ask
                    if (isVitaminCQuery(query)) {
                        const n = h.name.toLowerCase();
                        if (/\bevion\b|vitamin\s*e\b/.test(n) && !/vitamin\s*c|ascorbic|limcee|celin/.test(n)) {
                            return false;
                        }
                    }
                    return true;
                }),
            );
            return {
                hits,
                searched: true,
                unavailableReason:
                    hits.length === 0
                        ? `No Apollo matches for "${query}" (guest search). Try another name.`
                        : undefined,
                partner,
                query,
            };
        }
        if (partner === "pharmeasy") {
            let raw = await searchPharmeasyPublic(query);
            // Vit C often returns Iron/Amla multi-vits on PE — also pull Limcee/Celin brand hits.
            if (isVitaminCQuery(query)) {
                const extra = await Promise.all(["vitamin c", "limcee", "celin"].map((q) => searchPharmeasyPublic(q)));
                raw = dedupeHits([...raw, ...extra.flat()]);
                const vc = rankVitaminCHits(query, raw);
                if (vc.length) {
                    return { hits: vc, searched: true, partner, query };
                }
            }
            const hits = filterWeakHits(query, rankGuestHits(query, raw));
            return {
                hits,
                searched: true,
                unavailableReason:
                    hits.length === 0
                        ? `No PharmEasy matches for "${query}" (guest search). Try another name.`
                        : undefined,
                partner,
                query,
            };
        }
        if (partner === "tata_1mg") {
            // No stable guest price API without login — do not invent.
            return {
                hits: [],
                searched: true,
                unavailableReason:
                    "Tata 1mg does not expose guest prices without login. Reply *confirm* to open 1mg (OTP may be asked), or try *Apollo* / *PharmEasy* for live guest prices.",
                partner,
                query,
            };
        }
        // Food / grocery: browser only (never MCP), location = the Kavach address.
        if (partner === "instamart") {
            const { instamartSearch } = await import("./swiggyGuest.service");
            const res = await instamartSearch({ query });
            if (!res.location.ok || !res.location.pincodeMatch) {
                return {
                    hits: [],
                    searched: true,
                    unavailableReason:
                        "I couldn't set Instamart's location to your saved address (C504, Sunita Park, Raipur 492001), so I won't show prices from another area. Please try again in a bit.",
                    partner,
                    query,
                };
            }
            const hits: GuestCatalogHit[] = rankGroceryItems(
                query,
                res.items.filter((i) => !i.sponsored),
            ).map((i, n) => ({
                id: `instamart:${n}:${i.name}`.slice(0, 120),
                name: i.pack ? `${i.name} (${i.pack})` : i.name,
                pricePaise: i.pricePaise,
                packLabel: i.pack,
                source: "browser_guest" as const,
            })) as GuestCatalogHit[];
            return {
                hits,
                searched: true,
                unavailableReason: hits.length ? undefined : `Instamart (Raipur 492001) shows nothing matching "${query}". Try another name.`,
                partner,
                query,
            };
        }
        if (partner === "swiggy") {
            // Restaurant food is chosen restaurant → dish (browserTaskWhatsApp food flow), not a flat item list.
            return {
                hits: [],
                searched: false,
                unavailableReason: "Swiggy food is picked by restaurant first — say *show me open restaurants on Swiggy*.",
                partner,
                query,
            };
        }
        if (partner === "zepto" || partner === "blinkit" || partner === "zomato") {
            const label = partner === "zepto" ? "Zepto" : partner === "blinkit" ? "Blinkit" : "Zomato";
            return {
                hits: [],
                searched: false,
                unavailableReason:
                    `I can't browse ${label} without signing in yet, so I can't show live items or prices for your address. ` +
                    (partner === "zomato"
                        ? `I can show open restaurants near you on *Swiggy* instead.`
                        : `Reply *confirm* to sign in to ${label} in my browser (an OTP SMS will come) and I'll search there for Raipur 492001 — or say *order ${query} from Instamart*.`),
                partner,
                query,
            };
        }
        // BigBasket / Amazon / etc. — no guest catalog wired yet.
        return {
            hits: [],
            searched: true,
            unavailableReason:
                `Live guest prices for ${partner} aren't wired yet. ` +
                `Reply *confirm* to open the site and find the exact item (login/OTP may be asked) — I won't invent a price.`,
            partner,
            query,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            hits: [],
            searched: true,
            unavailableReason: `Catalog search failed (${msg.slice(0, 80)}). Reply *confirm* to open the site, or try another name — I won't invent a price.`,
            partner,
            query,
        };
    }
}

const GROCERY_OFFTOPIC_RE = /\b(chocolate|choco|biscuits?|bikis|cookies?|bar|chips|whitener|creamer|shampoo|soap|lotion|cream|candy|toffee|ice\s*cream|cake)\b/i;

/** Relevance for grocery items: every query word must appear; snacks/sweets demoted unless asked. */
export function rankGroceryItems<T extends { name: string }>(query: string, items: T[]): T[] {
    const q = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
    if (!q.length) return items.slice(0, 5);
    const scored = items
        .map((it, idx) => {
            const n = it.name.toLowerCase();
            const hit = q.filter((t) => new RegExp(`\\b${t.replace(/s$/, "")}`).test(n)).length;
            let s = hit / q.length;
            const off = n.match(GROCERY_OFFTOPIC_RE)?.[0];
            if (off && !q.some((t) => off.startsWith(t.replace(/s$/, "")))) s -= 0.8;
            return { it, s, idx };
        })
        .filter((x) => x.s >= 0.99)
        .sort((a, b) => b.s - a.s || a.idx - b.idx);
    return scored.map((x) => x.it).slice(0, 5);
}

/** WA copy for found SKU(s). Prefer top hit; list up to 3 numbered options. */
export function formatGuestCatalogConfirmCopy(input: {
    partnerLabel: string;
    query: string;
    hits: GuestCatalogHit[];
    quantity?: number;
    addressLabel?: string;
}): string {
    const qty = input.quantity && input.quantity > 0 ? input.quantity : 1;
    const top = input.hits.slice(0, 3);
    const lines: string[] = [];
    if (top.length === 1) {
        const h = top[0];
        const price = formatInr(h.pricePaise);
        lines.push(`Found on *${input.partnerLabel}*:`);
        lines.push(`• ${h.name} — ${price} ×${qty}`);
        lines.push("");
        if (input.addressLabel) lines.push(`Deliver to: ${input.addressLabel}`);
        lines.push(`Reply *confirm* to order this (login/OTP next), or send another name.`);
        lines.push(`Prefer *COD* at checkout — I'll still ask confirm-before-pay.`);
    } else {
        lines.push(`Found on *${input.partnerLabel}* for "${input.query}":`);
        top.forEach((h, i) => {
            lines.push(`${i + 1}. ${h.name} — ${formatInr(h.pricePaise)}`);
        });
        lines.push("");
        lines.push(
            `Reply *1* / *2* / *3*, or *confirm* for #1. Login/OTP only after you pick. Or send another name.`,
        );
        lines.push(`Prefer *COD* at checkout — I'll still ask confirm-before-pay.`);
    }
    lines.push(`_I only help order what you ask — I don't diagnose or suggest treatments._`);
    return lines.join("\n");
}

export function formatPriceLabel(paise?: number): string {
    return formatInr(paise) || "price TBD";
}
