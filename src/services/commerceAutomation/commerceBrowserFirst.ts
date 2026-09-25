/**
 * Feature flag: route Swiggy / Zomato / Blinkit / Zepto / Instamart WA orders
 * through Saheli private browser (Playwright) instead of MCP.
 *
 * MCP adapters + OAuth stay in the codebase; flip this flag (or partner list)
 * to re-enable MCP as the primary path without deleting code.
 *
 * Env:
 *   COMMERCE_BROWSER_FIRST=1|true|on|yes   (default ON)
 *   COMMERCE_BROWSER_FIRST=0|false|off|no  → MCP preferred again for listed partners
 *   COMMERCE_BROWSER_FIRST_PARTNERS=swiggy,zomato,blinkit,zepto,instamart
 *     (comma list; default = the five food/grocery partners above)
 */
import type { CommercePartnerKey } from "./types";

export const DEFAULT_BROWSER_FIRST_PARTNERS: readonly CommercePartnerKey[] = [
    "swiggy",
    "zomato",
    "blinkit",
    "zepto",
    "instamart",
] as const;

function parseEnvBool(raw: string | undefined, defaultOn: boolean): boolean {
    if (raw === undefined || raw.trim() === "") return defaultOn;
    const v = raw.trim().toLowerCase();
    if (["0", "false", "off", "no", "mcp"].includes(v)) return false;
    if (["1", "true", "on", "yes", "browser"].includes(v)) return true;
    return defaultOn;
}

/** Default ON — MCP place is unreliable; private browser is the primary WA path. */
export function isCommerceBrowserFirstEnabled(): boolean {
    return parseEnvBool(process.env.COMMERCE_BROWSER_FIRST, true);
}

export function browserFirstPartnerSet(): Set<string> {
    const raw = process.env.COMMERCE_BROWSER_FIRST_PARTNERS?.trim();
    if (!raw) return new Set(DEFAULT_BROWSER_FIRST_PARTNERS);
    return new Set(
        raw
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    );
}

/**
 * HARD: food/grocery (Instamart/Swiggy/Zepto/Blinkit/Zomato) always order through the
 * direct browser path — MCP ordering never successfully placed an order. The env flags are
 * ignored for these five (kept only for backwards-compatible reads elsewhere).
 */
export function shouldPreferBrowserForPartner(partner: string | null | undefined): boolean {
    if (!partner) return false;
    const key = partner.toLowerCase();
    if ((DEFAULT_BROWSER_FIRST_PARTNERS as readonly string[]).includes(key)) return true;
    if (!isCommerceBrowserFirstEnabled()) return false;
    return browserFirstPartnerSet().has(key);
}

/** MCP is never the ordering path any more (read-only search at most). */
export function shouldPreferMcpForPartner(_partner: string | null | undefined): boolean {
    return false;
}

export function browserFirstPartnerRegexSource(): string {
    const keys = [...browserFirstPartnerSet()];
    // Longest-first so "instamart" wins over partials; escape none needed (alnum/_).
    keys.sort((a, b) => b.length - a.length);
    return keys.map((k) => k.replace(/_/g, "\\s*")).join("|");
}
