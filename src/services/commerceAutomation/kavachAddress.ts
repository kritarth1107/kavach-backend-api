/**
 * Address helpers. There is NO default address here: the delivery address is always the
 * current care recipient's own saved address (recipientAddress.service), passed in explicitly.
 */

/** Area query used to set a site's location (no flat number / landmark / pincode / state). */
export function locationQueryFor(address: string): string {
    const parts = address
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => !/^(?:flat|house|h\.?\s*no\.?)?\s*[a-z]?-?\s?\d+[a-z]?$/i.test(p))
        .filter((p) => !/^near\b/i.test(p))
        .filter((p) => !/^\d{6}$/.test(p))
        .filter((p) => !/^india$/i.test(p))
        .map((p) => p.replace(/\s*-?\s*\b\d{6}\b/, "").trim())
        .filter(Boolean);
    return parts.slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
}

/** City guess for picking the right location suggestion (token before state / pincode). */
export function cityOf(address: string): string | undefined {
    const parts = address
        .split(",")
        .map((p) => p.replace(/\b\d{6}\b/, "").trim())
        .filter(Boolean)
        .filter((p) => !/^india$/i.test(p));
    const STATE =
        /^(andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|new delhi|jammu and kashmir|ladakh|puducherry|chandigarh|[a-z]{2})$/i;
    const last = parts[parts.length - 1];
    if (!last) return undefined;
    return STATE.test(last) && parts.length >= 2 ? parts[parts.length - 2] : last;
}

/** Official / old names a store may show for the same city (Bangalore ↔ Bengaluru …). */
const CITY_ALIASES: string[][] = [
    ["bangalore", "bengaluru", "bangaluru"],
    ["gurgaon", "gurugram"],
    ["bombay", "mumbai"],
    ["calcutta", "kolkata"],
    ["madras", "chennai"],
    ["mysore", "mysuru"],
    ["poona", "pune"],
    ["mangalore", "mangaluru"],
    ["belgaum", "belagavi"],
    ["hubli", "hubballi"],
    ["trivandrum", "thiruvananthapuram"],
    ["cochin", "kochi"],
    ["vizag", "visakhapatnam"],
    ["baroda", "vadodara"],
    ["pondicherry", "puducherry"],
    ["new delhi", "delhi"],
    ["allahabad", "prayagraj"],
];

/** Regex alternation (escaped) matching a city under any of its names; "" when unknown. */
export function cityAlternation(city: string | null | undefined): string {
    const c = String(city || "").trim().toLowerCase();
    if (!c) return "";
    const names = CITY_ALIASES.find((g) => g.includes(c)) || [c];
    return names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|");
}

/** True when `text` names the same city as `city` (alias-aware). */
export function sameCity(text: string | null | undefined, city: string | null | undefined): boolean {
    const alt = cityAlternation(city);
    return !alt || new RegExp(`\\b(?:${alt})\\b`, "i").test(String(text || ""));
}

/** Short fallback location query: the locality right before the city + the city. */
export function localityQueryFor(address: string): string {
    const parts = address
        .split(",")
        .map((p) => p.replace(/\s*-?\s*\b\d{6}\b/, "").trim())
        .filter(Boolean)
        .filter((p) => !/^india$/i.test(p));
    const city = cityOf(address);
    const i = city ? parts.findIndex((p) => p.toLowerCase() === city.toLowerCase()) : -1;
    if (i > 0) return `${parts[i - 1]} ${parts[i]}`.replace(/\s+/g, " ").trim();
    return parts.slice(-3, -1).join(" ").trim();
}

/** First ~4 parts + pincode, for chat copy. */
export function shortAddress(address: string): string {
    const pin = pincodeOf(address);
    const parts = address
        .split(",")
        .map((p) => p.replace(/\s*-?\s*\b\d{6}\b/, "").trim())
        .filter(Boolean)
        .filter((p) => !/^near\b/i.test(p) && !/^india$/i.test(p));
    const head = parts.slice(0, 4).join(", ");
    return pin ? `${head} ${pin}`.trim() : head;
}

export function pincodeOf(text: string | null | undefined): string | undefined {
    return String(text || "").match(/\b([1-9]\d{5})\b/)?.[1];
}

/** True when a site-shown address has the same pincode as the recipient's saved address. */
export function addressMatches(shown: string | null | undefined, target: string | null | undefined): boolean {
    const t = pincodeOf(target);
    return Boolean(t) && pincodeOf(shown) === t;
}

/** Distinctive words of the recipient's own saved address (for recognising mentions of it). */
export function targetTokens(target?: string | null): string[] {
    return String(target || "")
        .toLowerCase()
        .split(/[,\s]+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ""))
        .filter((w) => w.length >= 4 && !/^(near|road|area|hotel|india|opposite|behind)$/.test(w));
}

/**
 * Elder mentions an address. "same" = points at their saved address (home / ghar / my address,
 * or words / pincode from their own saved address), "other" = a different explicit address,
 * null = not about the address.
 */
export function classifyAddressMention(text: string, target?: string | null): "same" | "other" | null {
    const t = text.toLowerCase();
    const tokens = targetTokens(target);
    const mentionsOwn = tokens.some((w) => new RegExp(`\\b${w}\\b`).test(t.replace(/[^a-z0-9\s]/g, "")));
    const about =
        /\b(deliver(?:ed|y|ing)?|address|home|ghar|pin\s*code|pincode|location|flat|house|send\s+(?:it\s+)?to|bhej\s*do)\b/.test(t) ||
        /\b\d{6}\b/.test(t) ||
        mentionsOwn;
    if (!about) return null;
    const pin = pincodeOf(t);
    const targetPin = pincodeOf(target);
    if (pin && targetPin && pin !== targetPin) return "other";
    if (pin && !targetPin) return "other";
    if (mentionsOwn || /\bhome\b|\bghar\b|\bmy\s+(?:home\s+)?address\b|saved\s+address/.test(t)) return "same";
    if (/\b(deliver(?:ed|y)?\s+(?:it\s+)?to|address\s+is|send\s+(?:it\s+)?to)\s+\S+/.test(t)) return "other";
    return "same";
}

/** Strip delivery/address phrases so they never become a product or restaurant query. */
export function stripAddressPhrases(text: string, target?: string | null): string {
    let out = text
        .replace(
            /\b(?:and\s+)?(?:i\s+want\s+it\s+|please\s+)?(?:deliver(?:ed|y)?|send|bhej(?:na|o|do)?)\s+(?:it\s+)?(?:to|at|on)\s+.*$/i,
            " ",
        )
        .replace(/\b(?:to|at)\s+my\s+(?:home\s+)?address\b/gi, " ")
        .replace(/\b(?:my\s+)?(?:home|ghar)\s+address\b/gi, " ")
        .replace(/\b(?:to|at)\s+(?:my\s+)?(?:home|ghar|house)\b/gi, " ");
    const tokens = targetTokens(target);
    if (tokens.length) {
        const alt = tokens.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        out = out
            .replace(new RegExp(`\\b(?:to|at|in|near|for)\\s+(?:my\\s+)?(?:home\\s+|address\\s+)?(?:of\\s+|in\\s+|at\\s+)?(?:${alt})(?:[\\s,]+(?:${alt}|address|home))*\\b`, "gi"), " ")
            .replace(new RegExp(`\\b(?:${alt})\\s+address\\b`, "gi"), " ");
    }
    return out.replace(/\s+/g, " ").trim();
}
