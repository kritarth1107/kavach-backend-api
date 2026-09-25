/**
 * HARD allowlist for Saheli browser ordering / booking. Code-enforced (WA entry,
 * runBrowserTask entry, Saheli tools) — the agent cannot talk its way past it.
 */
export const ALLOWED_ORDER_SITES = [
    "apollo",
    "pharmeasy",
    "instamart",
    "swiggy",
    "zepto",
    "blinkit",
    "zomato",
    "uber",
] as const;

export type AllowedOrderSite = (typeof ALLOWED_ORDER_SITES)[number];

/** Food / grocery: ordered ONLY through the direct browser path (never MCP). */
export const FOOD_GROCERY_BROWSER_ONLY: readonly string[] = [
    "instamart",
    "swiggy",
    "zepto",
    "blinkit",
    "zomato",
];

const ALLOWED = new Set<string>(ALLOWED_ORDER_SITES);

export function isAllowedOrderSite(partner: string | null | undefined): partner is AllowedOrderSite {
    return Boolean(partner) && ALLOWED.has(String(partner).toLowerCase());
}

export function isFoodGroceryBrowserOnly(partner: string | null | undefined): boolean {
    return Boolean(partner) && FOOD_GROCERY_BROWSER_ONLY.includes(String(partner).toLowerCase());
}

const PRETTY: Record<string, string> = {
    amazon: "Amazon",
    flipkart: "Flipkart",
    myntra: "Myntra",
    bigbasket: "BigBasket",
    jiomart: "JioMart",
    dmart: "DMart",
    natures_basket: "Nature's Basket",
    tata_1mg: "Tata 1mg",
    ola: "Ola",
    rapido: "Rapido",
};

/** Honest refusal copy for anything outside the allowlist. */
export function refuseSiteCopy(partner?: string | null): string {
    const name = partner && partner !== "generic" && partner !== "generic_grocery" ? PRETTY[partner] || partner : "that site";
    return (
        `Sorry, I can't order from ${name} 🙏\n` +
        `I can order medicines from *Apollo* or *PharmEasy*, groceries & food from *Instamart, Swiggy, Zepto, Blinkit* or *Zomato*, and book an *Uber*.`
    );
}

export const MCP_ORDERING_DISABLED_COPY = (label: string, query?: string) =>
    `I order ${label} on the website now 🛒 Say *order ${query?.trim() || "…"} from ${label}* and I'll show you the item and total first — Cash on Delivery only.`;
