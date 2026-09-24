import type { CommercePartnerKey } from "./types";

export type BrowserPlaybook = {
    partner: CommercePartnerKey | "generic";
    startUrl: string;
    searchHint: string;
    otpHint: string;
    confirmHint: string;
};

const APOLLO: BrowserPlaybook = {
    partner: "apollo",
    startUrl: "https://www.apollopharmacy.in/",
    searchHint: "Use the site search to find the medicine/OTC item the user asked for.",
    otpHint: "Apollo may SMS an OTP for login — ask the user to paste it in WhatsApp.",
    confirmHint: "Before any pay/UPI, stop and ask WhatsApp confirm of item + total + address.",
};

const INSTAMART: BrowserPlaybook = {
    partner: "instamart",
    startUrl: "https://www.swiggy.com/instamart",
    searchHint: "Open Instamart via Swiggy web; search the grocery item; add to cart.",
    otpHint: "Swiggy may SMS an OTP — ask the user to paste it in WhatsApp.",
    confirmHint: "Before pay, confirm item + total + address in WhatsApp.",
};

const GENERIC: BrowserPlaybook = {
    partner: "generic",
    startUrl: "https://www.google.com/",
    searchHint: "Navigate to help the user browse / find / open what they asked.",
    otpHint: "If a site asks for OTP, ask the user to paste the SMS code in WhatsApp.",
    confirmHint: "Never complete payment without explicit WhatsApp confirm.",
};

export function resolvePlaybook(
    partner?: CommercePartnerKey | "generic" | null,
    goal?: string,
): BrowserPlaybook {
    if (partner === "apollo") return APOLLO;
    if (partner === "instamart" || partner === "swiggy") return INSTAMART;
    if (partner === "pharmeasy") {
        return {
            ...APOLLO,
            partner: "pharmeasy",
            startUrl: "https://pharmeasy.in/",
            otpHint: "PharmEasy may SMS an OTP — paste it in WhatsApp.",
        };
    }
    if (partner === "tata_1mg") {
        return {
            ...APOLLO,
            partner: "tata_1mg",
            startUrl: "https://www.1mg.com/",
            otpHint: "1mg may SMS an OTP — paste it in WhatsApp.",
        };
    }
    if (partner === "blinkit") {
        return {
            ...INSTAMART,
            partner: "blinkit",
            startUrl: "https://blinkit.com/",
        };
    }
    if (partner === "zepto") {
        return {
            ...INSTAMART,
            partner: "zepto",
            startUrl: "https://www.zeptonow.com/",
        };
    }
    // Infer from goal text
    const g = (goal || "").toLowerCase();
    if (/\bapollo\b/.test(g)) return APOLLO;
    if (/\binstamart|swiggy\b/.test(g)) return INSTAMART;
    if (/\bpharmeasy\b/.test(g)) return resolvePlaybook("pharmeasy");
    if (/\b1\s*mg|tata\b/.test(g)) return resolvePlaybook("tata_1mg");
    return GENERIC;
}

export function partnerLabel(partner: string): string {
    if (partner === "tata_1mg") return "Tata 1mg";
    if (partner === "pharmeasy") return "PharmEasy";
    if (partner === "apollo") return "Apollo";
    if (partner === "instamart") return "Instamart";
    if (partner === "generic") return "the web";
    return partner.replace(/_/g, " ");
}
