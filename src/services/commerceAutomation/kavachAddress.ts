/**
 * The care recipient's saved Kavach delivery address — the ONLY address Saheli orders to.
 * Store-account addresses (Swiggy/Zepto/Instamart saved addresses, MCP defaults) are never
 * shown or used. Kavach has no per-recipient address field yet, so this is the address the
 * family saved for the care recipient (Raipur).
 */
export const KAVACH_DELIVERY_ADDRESS =
    "C504, SUNITA PARK, LABHANDIH, NEAR TULIP AREA HOTEL, RAIPUR, CHHATTISGARH, 492001";
export const KAVACH_DELIVERY_PINCODE = "492001";
export const KAVACH_DELIVERY_SHORT = "C504, Sunita Park, Labhandih, Raipur 492001";

/** Area query used to set the site's location (no flat number / landmark). */
export function locationQueryFor(address: string = KAVACH_DELIVERY_ADDRESS): string {
    const parts = address
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => !/^[a-z]?-?\s?\d+[a-z]?$/i.test(p)) // C504 / 12B
        .filter((p) => !/^near\b/i.test(p))
        .filter((p) => !/^\d{6}$/.test(p))
        .filter((p) => !/^(india|chhattisgarh)$/i.test(p));
    return parts.slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
}

export function pincodeOf(text: string | null | undefined): string | undefined {
    return String(text || "").match(/\b([1-9]\d{5})\b/)?.[1];
}

/** True when a site-shown address is the Kavach address (same pincode). */
export function isKavachAddress(text: string | null | undefined): boolean {
    return pincodeOf(text) === KAVACH_DELIVERY_PINCODE;
}

/**
 * Elder mentions an address. Returns "same" when it points at the saved Kavach address
 * (home / ghar / C504 / Sunita Park / Labhandih / Raipur / 492001), "other" for a different
 * explicit address, null when the message isn't about the address.
 */
export function classifyAddressMention(text: string): "same" | "other" | null {
    const t = text.toLowerCase();
    const about =
        /\b(deliver(?:ed|y|ing)?|address|home|ghar|pin\s*code|pincode|location|flat|house|send\s+(?:it\s+)?to|bhej\s*do|c\s*-?\s*504|sunita\s*park|labhandih|raipur)\b/.test(
            t,
        ) || /\b\d{6}\b/.test(t);
    if (!about) return null;
    if (/\bc\s*-?\s*504\b|sunita\s*park|labhandih|\braipur\b|492001|\bhome\b|\bghar\b|\bmy\s+address\b|saved\s+address/.test(t)) {
        const pin = pincodeOf(t);
        if (pin && pin !== KAVACH_DELIVERY_PINCODE) return "other";
        return "same";
    }
    const pin = pincodeOf(t);
    if (pin && pin !== KAVACH_DELIVERY_PINCODE) return "other";
    // "deliver to Gurgaon / office / sector 5" etc.
    if (/\b(deliver(?:ed|y)?\s+(?:it\s+)?to|address\s+is|send\s+(?:it\s+)?to)\s+\S+/.test(t)) return "other";
    return "same";
}

/** Strip delivery/address phrases so they never become a product or restaurant query. */
export function stripAddressPhrases(text: string): string {
    return text
        .replace(
            /\b(?:and\s+)?(?:i\s+want\s+it\s+|please\s+)?(?:deliver(?:ed|y)?|send|bhej(?:na|o|do)?)\s+(?:it\s+)?(?:to|at|on)\s+.*$/i,
            " ",
        )
        .replace(/\b(?:to|at|in|near|for)\s+(?:my\s+)?(?:home|ghar|house|flat)?\s*(?:address\s*)?(?:of\s+|in\s+|at\s+)?(?:raipur|c\s*-?\s*504|sunita\s*park|labhandih|492001)(?:\s+(?:address|home|c\s*-?\s*504|raipur))*\b/gi, " ")
        .replace(/\b(?:to|at)\s+my\s+(?:home\s+)?address\b/gi, " ")
        .replace(/\b(?:my\s+)?(?:home|ghar)\s+address\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}
