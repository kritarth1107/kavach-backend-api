import type { CommercePartnerKey } from "./types";
import {
    resolveSiteFromMessage,
    siteLabel,
    type CommerceSiteKey,
} from "./siteResolve";

export type BrowserPlaybook = {
    /** Site key (partner or freeform). */
    partner: CommercePartnerKey | "generic";
    siteKey: CommerceSiteKey;
    startUrl: string;
    searchHint: string;
    otpHint: string;
    confirmHint: string;
    category: "grocery" | "pharmacy" | "retail" | "food" | "generic";
};

const CONFIRM =
    "Before any pay/UPI, stop and ask WhatsApp confirm of item + total + address. Never silent pay.";
const OTP =
    "If the site SMS an OTP for login — ask the user to paste it in WhatsApp. Never read device SMS.";

function groceryPlaybook(
    partner: CommercePartnerKey | "generic",
    startUrl: string,
    searchHint: string,
): BrowserPlaybook {
    return {
        partner,
        siteKey: partner === "generic" ? "generic_grocery" : (partner as CommerceSiteKey),
        startUrl,
        searchHint,
        otpHint: OTP,
        confirmHint: CONFIRM,
        category: "grocery",
    };
}

function retailPlaybook(partner: CommercePartnerKey | "generic", startUrl: string, hint: string): BrowserPlaybook {
    return {
        partner,
        siteKey: (partner === "generic" ? "generic" : partner) as CommerceSiteKey,
        startUrl,
        searchHint: hint,
        otpHint: OTP,
        confirmHint: CONFIRM,
        category: "retail",
    };
}

function pharmacyPlaybook(partner: CommercePartnerKey, startUrl: string): BrowserPlaybook {
    return {
        partner,
        siteKey: partner,
        startUrl,
        searchHint: "Use site search to find the medicine/OTC item the user asked for. Never diagnose.",
        otpHint: OTP,
        confirmHint: CONFIRM,
        category: "pharmacy",
    };
}

const PLAYBOOKS: Record<string, BrowserPlaybook> = {
    apollo: pharmacyPlaybook("apollo", "https://www.apollopharmacy.in/"),
    pharmeasy: pharmacyPlaybook("pharmeasy", "https://pharmeasy.in/"),
    tata_1mg: pharmacyPlaybook("tata_1mg", "https://www.1mg.com/"),
    instamart: groceryPlaybook(
        "instamart",
        "https://www.swiggy.com/instamart",
        "Open Instamart via Swiggy web; search the grocery item; add to cart.",
    ),
    swiggy: {
        partner: "swiggy",
        siteKey: "swiggy",
        startUrl: "https://www.swiggy.com/",
        searchHint: "Search restaurants/dishes the user asked for; add to cart.",
        otpHint: OTP,
        confirmHint: CONFIRM,
        category: "food",
    },
    zepto: groceryPlaybook("zepto", "https://www.zeptonow.com/", "Search Zepto for the grocery item; add to cart."),
    blinkit: groceryPlaybook("blinkit", "https://blinkit.com/", "Search Blinkit for the grocery item; add to cart."),
    bigbasket: groceryPlaybook(
        "bigbasket",
        "https://www.bigbasket.com/",
        "Search BigBasket for the grocery item; add to cart. Prefer user's delivery pin if asked.",
    ),
    jiomart: groceryPlaybook(
        "jiomart",
        "https://www.jiomart.com/",
        "Search JioMart for the grocery item; add to cart.",
    ),
    dmart: groceryPlaybook(
        "dmart",
        "https://www.dmart.in/",
        "Open DMart Ready / dmart.in; search the grocery item; add to cart.",
    ),
    natures_basket: groceryPlaybook(
        "natures_basket",
        "https://www.naturesbasket.co.in/",
        "Search Nature's Basket for the item; add to cart.",
    ),
    amazon: retailPlaybook(
        "amazon",
        "https://www.amazon.in/",
        "If a product URL was given, open it; else use Amazon.in search for the item; add to cart.",
    ),
    flipkart: retailPlaybook(
        "flipkart",
        "https://www.flipkart.com/",
        "If a product URL was given, open it; else use Flipkart search; add to cart.",
    ),
    myntra: retailPlaybook(
        "myntra",
        "https://www.myntra.com/",
        "If a product URL was given, open it; else use Myntra search; add to cart.",
    ),
    zomato: {
        partner: "zomato",
        siteKey: "zomato",
        startUrl: "https://www.zomato.com/",
        searchHint: "Search Zomato for the dish/restaurant; add to cart.",
        otpHint: OTP,
        confirmHint: CONFIRM,
        category: "food",
    },
    generic_grocery: groceryPlaybook(
        "generic_grocery",
        "https://www.google.com/search?q=grocery+delivery+india",
        "User wants groceries but site unknown — Google a grocery delivery site or ask once which site (BigBasket / JioMart / DMart / Blinkit), then search and add to cart.",
    ),
    generic: {
        partner: "generic",
        siteKey: "generic",
        startUrl: "https://www.google.com/",
        searchHint:
            "Any HTTPS shop: open the product URL if given, else Google the shop/product, open the product page, add to cart. Confirm before pay.",
        otpHint: OTP,
        confirmHint: CONFIRM,
        category: "generic",
    },
};

export function resolvePlaybook(
    partner?: CommercePartnerKey | "generic" | null,
    goal?: string,
    startUrlOverride?: string | null,
): BrowserPlaybook {
    if (partner && PLAYBOOKS[partner]) {
        const base = PLAYBOOKS[partner];
        if (startUrlOverride) return { ...base, startUrl: startUrlOverride };
        return base;
    }

    if (goal) {
        const resolved = resolveSiteFromMessage(goal);
        const key = resolved.siteKey;
        const base = PLAYBOOKS[key] || PLAYBOOKS.generic;
        return {
            ...base,
            startUrl: startUrlOverride || resolved.startUrl || base.startUrl,
            siteKey: resolved.siteKey,
            partner:
                key === "generic" || key === "generic_grocery"
                    ? (key as CommercePartnerKey | "generic")
                    : ((PLAYBOOKS[key]?.partner ?? "generic") as CommercePartnerKey | "generic"),
        };
    }

    const generic = PLAYBOOKS.generic;
    if (startUrlOverride) return { ...generic, startUrl: startUrlOverride };
    return generic;
}

export function partnerLabel(partner: string): string {
    return siteLabel(partner);
}

export function listSupportedBrowserSites(): string[] {
    return [
        "Amazon.in",
        "Flipkart",
        "Myntra",
        "BigBasket",
        "JioMart",
        "DMart Ready",
        "Nature's Basket",
        "Blinkit",
        "Instamart (browser fallback)",
        "Zepto (browser fallback)",
        "Swiggy (browser fallback)",
        "Apollo / PharmEasy / Tata 1mg",
        "Generic grocery (unknown domain)",
        "Generic any HTTPS shop (URL or Google site search)",
    ];
}
