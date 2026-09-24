/**
 * Resolve commerce siteKey / domain / startUrl from freeform WA text or a product URL.
 * MCP partners (instamart/swiggy/zepto) stay on MCP when connected — browser when named
 * non-MCP site, URL paste, "any site", or explicit browse.
 */
import type { CommercePartnerKey } from "./types";

export type CommerceSiteKey = CommercePartnerKey | "generic";

export type ResolvedSite = {
    siteKey: CommerceSiteKey;
    startUrl: string;
    domain?: string;
    /** Prefer MCP path when this is an MCP grocery/food partner (unless forceBrowser). */
    preferMcp: boolean;
    label: string;
};

const MCP_KEYS = new Set<string>(["swiggy", "instamart", "zepto"]);

const SITE_TABLE: Array<{
    key: CommerceSiteKey;
    label: string;
    startUrl: string;
    domains: RegExp;
    names: RegExp;
    preferMcp?: boolean;
}> = [
    {
        key: "amazon",
        label: "Amazon.in",
        startUrl: "https://www.amazon.in/",
        domains: /amazon\.in|amzn\.in|amazon\.com/i,
        names: /\bamazon(?:\.in)?\b/i,
    },
    {
        key: "flipkart",
        label: "Flipkart",
        startUrl: "https://www.flipkart.com/",
        domains: /flipkart\.com|dl\.flipkart\.com/i,
        names: /\bflipkart\b/i,
    },
    {
        key: "myntra",
        label: "Myntra",
        startUrl: "https://www.myntra.com/",
        domains: /myntra\.com/i,
        names: /\bmyntra\b/i,
    },
    {
        key: "bigbasket",
        label: "BigBasket",
        startUrl: "https://www.bigbasket.com/",
        domains: /bigbasket\.com/i,
        names: /\bbig\s*basket|bigbasket\b/i,
    },
    {
        key: "jiomart",
        label: "JioMart",
        startUrl: "https://www.jiomart.com/",
        domains: /jiomart\.com/i,
        names: /\bjio\s*mart|jiomart\b/i,
    },
    {
        key: "dmart",
        label: "DMart Ready",
        startUrl: "https://www.dmart.in/",
        domains: /dmart\.in|dmartready/i,
        names: /\bd\s*mart|dmart(?:\s*ready)?\b/i,
    },
    {
        key: "natures_basket",
        label: "Nature's Basket",
        startUrl: "https://www.naturesbasket.co.in/",
        domains: /naturesbasket\.co\.in|naturesbasket/i,
        names: /\bnature'?s\s*basket|natures\s*basket\b/i,
    },
    {
        key: "blinkit",
        label: "Blinkit",
        startUrl: "https://blinkit.com/",
        domains: /blinkit\.com/i,
        names: /\bblinkit\b/i,
    },
    {
        key: "apollo",
        label: "Apollo",
        startUrl: "https://www.apollopharmacy.in/",
        domains: /apollopharmacy\.in|apollo\.in/i,
        names: /\bapollo\b/i,
    },
    {
        key: "pharmeasy",
        label: "PharmEasy",
        startUrl: "https://pharmeasy.in/",
        domains: /pharmeasy\.in/i,
        names: /\bpharm\s*easy|pharmeasy\b/i,
    },
    {
        key: "tata_1mg",
        label: "Tata 1mg",
        startUrl: "https://www.1mg.com/",
        domains: /1mg\.com/i,
        names: /\b1\s*mg|tata\s*1mg\b/i,
    },
    {
        key: "instamart",
        label: "Instamart",
        startUrl: "https://www.swiggy.com/instamart",
        domains: /swiggy\.com\/instamart|instamart/i,
        names: /\binstamart\b/i,
        preferMcp: true,
    },
    {
        key: "swiggy",
        label: "Swiggy",
        startUrl: "https://www.swiggy.com/",
        domains: /swiggy\.com/i,
        names: /\bswiggy\b/i,
        preferMcp: true,
    },
    {
        key: "zepto",
        label: "Zepto",
        startUrl: "https://www.zeptonow.com/",
        domains: /zeptonow\.com|zepto\.co/i,
        names: /\bzepto\b/i,
        preferMcp: true,
    },
    {
        key: "zomato",
        label: "Zomato",
        startUrl: "https://www.zomato.com/",
        domains: /zomato\.com/i,
        names: /\bzomato\b/i,
    },
];

const PRODUCT_URL_RE = /https?:\/\/[^\s<>"']+/i;

const GROCERY_HINT =
    /\b(grocery|groceries|kirana|vegetables?|veggies|milk|atta|dal|rice|eggs?|bread|oats|fruits?)\b/i;

export function extractProductUrl(text: string): string | null {
    const m = text.match(PRODUCT_URL_RE);
    if (!m) return null;
    try {
        const u = new URL(m[0].replace(/[),.]+$/, ""));
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        return u.toString();
    } catch {
        return null;
    }
}

export function siteLabel(siteKey: string): string {
    const row = SITE_TABLE.find((s) => s.key === siteKey);
    if (row) return row.label;
    if (siteKey === "generic_grocery") return "grocery site";
    if (siteKey === "generic") return "the web";
    return siteKey.replace(/_/g, " ");
}

/**
 * Map freeform text / URL → site. Unknown HTTPS shop → generic with that startUrl.
 */
export function resolveSiteFromMessage(
    text: string,
    opts?: { forceBrowser?: boolean },
): ResolvedSite {
    const url = extractProductUrl(text);
    if (url) {
        try {
            const host = new URL(url).hostname.replace(/^www\./, "");
            for (const row of SITE_TABLE) {
                if (row.domains.test(host) || row.domains.test(url)) {
                    return {
                        siteKey: row.key,
                        startUrl: url,
                        domain: host,
                        preferMcp: Boolean(row.preferMcp) && !opts?.forceBrowser,
                        label: row.label,
                    };
                }
            }
            return {
                siteKey: "generic",
                startUrl: url,
                domain: host,
                preferMcp: false,
                label: host || "the web",
            };
        } catch {
            /* fall through */
        }
    }

    for (const row of SITE_TABLE) {
        if (row.names.test(text)) {
            return {
                siteKey: row.key,
                startUrl: row.startUrl,
                preferMcp: Boolean(row.preferMcp) && !opts?.forceBrowser,
                label: row.label,
            };
        }
    }

    const fromShop = text.match(
        /\b(?:from|on|via|at)\s+([a-z0-9][a-z0-9._-]{1,40})(?:\.(?:com|in|co\.in))?\b/i,
    );
    if (fromShop) {
        const token = fromShop[1].toLowerCase();
        if (!/^(me|my|the|this|home|here|whatsapp|wa)$/.test(token)) {
            const q = encodeURIComponent(`site:${token}.in OR ${token}`);
            return {
                siteKey: GROCERY_HINT.test(text) ? "generic_grocery" : "generic",
                startUrl: `https://www.google.com/search?q=${q}`,
                preferMcp: false,
                label: token,
            };
        }
    }

    if (GROCERY_HINT.test(text) && /\b(order|buy|get|purchase)\b/i.test(text)) {
        return {
            siteKey: "generic_grocery",
            startUrl: "https://www.google.com/search?q=grocery+delivery+india",
            preferMcp: false,
            label: "grocery site",
        };
    }

    return {
        siteKey: "generic",
        startUrl: "https://www.google.com/",
        preferMcp: false,
        label: "the web",
    };
}

/** True when WA text should use private-browser order path (not MCP grocery). */
export function messageLooksLikeAnySiteBrowserOrder(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (extractProductUrl(t)) return true;
    if (
        /\b(any\s*site|any\s*website|via\s+browser|private\s+browser|browse\s+and\s+(shop|order))\b/i.test(
            t,
        )
    ) {
        return true;
    }
    const resolved = resolveSiteFromMessage(t);
    if (resolved.siteKey !== "generic" && resolved.siteKey !== "generic_grocery" && !resolved.preferMcp) {
        if (/\b(order|buy|get|purchase|shop|add\s+to\s+cart)\b/i.test(t) || extractProductUrl(t)) {
            return true;
        }
        if (/\b(open|browse|find|search|go\s+to|visit|look\s+up)\b/i.test(t)) return true;
    }
    if (
        resolved.siteKey === "generic_grocery" &&
        /\b(order|buy|get)\b/i.test(t) &&
        !/\b(instamart|swiggy|zepto)\b/i.test(t)
    ) {
        return true;
    }
    if (
        /\b(order|buy|get|purchase)\b/i.test(t) &&
        /\b(amazon|flipkart|myntra|big\s*basket|bigbasket|jiomart|jio\s*mart|dmart|nature'?s\s*basket|blinkit|apollo|pharmeasy|1\s*mg)\b/i.test(
            t,
        )
    ) {
        return true;
    }
    return false;
}

export function isMcpPreferSite(siteKey: string): boolean {
    return MCP_KEYS.has(siteKey);
}

export function siteKeyToPartnerKey(
    siteKey: CommerceSiteKey | string,
): CommercePartnerKey | "generic" {
    if (siteKey === "generic") return "generic";
    return siteKey as CommercePartnerKey;
}
