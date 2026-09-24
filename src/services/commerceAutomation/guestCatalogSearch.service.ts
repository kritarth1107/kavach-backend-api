/**
 * Guest / public catalog search — NO login, NO OTP, NO Continue click.
 * Used to WhatsApp exact product name + price before opening partner login.
 *
 * Sources:
 * - Apollo: public accessToken + search-service/v5/fullSearch
 * - PharmEasy: public /api/search/search
 * - Instamart / Swiggy / Zepto: MCP search when already connected (no new SMS)
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
    source: "apollo_public" | "pharmeasy_public" | "mcp" | "none";
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
        // Boost classic OTC Vit C brands / SKUs (Limcee name has no "vitamin" token)
        if (/vitamin\s*c|vit\s*c|ascorbic/i.test(query)) {
            if (/\blimcee\b/i.test(n) && !/zinc/i.test(n)) s += 20;
            else if (/\bcelin\b|\bsukcee\b|\blimcee\b/i.test(n)) s += 14;
            if (/vitamin[-\s]*c|ascorbic/i.test(n) && /500/i.test(n) && /tablet|chewable/i.test(n)) s += 6;
            // Prefer compact tablet strips over large bottles for default "vitamin c"
            if (/\b(15|10|20)\b/.test(n) && /tablet|strip|chewable/i.test(n) && !/bottle|60|effervescent/i.test(n)) {
                s += 4;
            }
            if (/vitamin\s*e\b|\bevion\b/i.test(n) && !/vitamin\s*c/i.test(n)) s -= 12;
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

async function searchApolloPublic(query: string): Promise<GuestCatalogHit[]> {
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
            pincode: "",
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
            productUrl: urlKey ? `https://www.apollopharmacy.in/otc/${urlKey}` : undefined,
            source: "apollo_public",
        });
        if (hits.length >= 8) break;
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
}): Promise<GuestCatalogSearchResult> {
    const partner = String(input.partner || "").toLowerCase() as CommercePartnerKey;
    const query = input.query.trim().slice(0, 120);
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
            const hits = filterWeakHits(query, rankGuestHits(query, await searchApolloPublic(query)));
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
            if (/vitamin\s*c|vit\s*c|ascorbic/i.test(query)) {
                const brandHits = await searchPharmeasyPublic("limcee");
                raw = dedupeHits([...raw, ...brandHits]);
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
        if (partner === "instamart" || partner === "swiggy" || partner === "zepto") {
            const hits = await searchMcpGuest({
                partner: partner as McpPartnerKey,
                familyId: input.familyId,
                userId: input.userId,
                query,
            });
            if (hits.length) {
                return { hits: rankGuestHits(query, hits), searched: true, partner, query };
            }
            return {
                hits: [],
                searched: true,
                unavailableReason: `${partner} live prices need a connected account (or address). Reply *confirm* to open ${partner} in the private browser (OTP may be asked), or connect ${partner} in Integrations for guest-free search.`,
                partner,
                query,
            };
        }
        // Blinkit / Zomato / BigBasket / etc. — no guest catalog wired yet.
        return {
            hits: [],
            searched: true,
            unavailableReason: `Live guest prices for ${partner} aren't wired yet. Reply *confirm* to open the site and find the exact item (login/OTP may be asked) — I won't invent a price.`,
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
    } else {
        lines.push(`Found on *${input.partnerLabel}* for "${input.query}":`);
        top.forEach((h, i) => {
            lines.push(`${i + 1}. ${h.name} — ${formatInr(h.pricePaise)}`);
        });
        lines.push("");
        lines.push(
            `Reply *1* / *2* / *3*, or *confirm* for #1. Login/OTP only after you pick. Or send another name.`,
        );
    }
    lines.push(`_I only help order what you ask — I don't diagnose or suggest treatments._`);
    return lines.join("\n");
}

export function formatPriceLabel(paise?: number): string {
    return formatInr(paise) || "price TBD";
}
