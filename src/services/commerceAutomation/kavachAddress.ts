/**
 * Address helpers. There is NO default address here: the delivery address is always the
 * current care recipient's own saved address (recipientAddress.service), passed in explicitly.
 */

const KNOWN_CITIES = [
    "bangalore", "bengaluru", "mumbai", "bombay", "navi mumbai", "thane", "pune", "delhi", "new delhi", "noida", "greater noida", "gurgaon", "gurugram",
    "ghaziabad", "faridabad", "hyderabad", "secunderabad", "chennai", "madras", "kolkata", "calcutta", "ahmedabad", "surat", "vadodara", "baroda",
    "jaipur", "lucknow", "kanpur", "nagpur", "indore", "bhopal", "raipur", "bilaspur", "bhilai", "durg", "patna", "ranchi", "bhubaneswar", "chandigarh",
    "mohali", "ludhiana", "amritsar", "dehradun", "coimbatore", "madurai", "mysore", "mysuru", "mangalore", "mangaluru", "kochi", "cochin",
    "trivandrum", "thiruvananthapuram", "visakhapatnam", "vizag", "vijayawada", "guwahati", "varanasi", "agra", "meerut", "jodhpur", "udaipur",
    "gwalior", "jabalpur", "nashik", "aurangabad", "hubli", "hubballi", "belgaum", "belagavi", "allahabad", "prayagraj", "goa", "panaji",
];
const STATE_WORDS =
    /\b(andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|jammu and kashmir|ladakh)\b/gi;

/**
 * Typed addresses often have no commas ("74 4th cross amrutnagar byatarayanapura bangalore
 * karnataka india 560092"): split them around a known city into street, locality, city, state
 * so the helpers below see the same shape as a comma address.
 */
function commaShape(address: string): string {
    const bare = address.replace(/\b\d{6}\b/g, " ").replace(/\bindia\b/gi, " ").replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
    const parts = bare.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 2 || !parts[0] || parts[0].split(/\s+/).length < 5) return address;
    const text = parts.join(" ");
    const lower = text.toLowerCase();
    let best: { i: number; name: string } | null = null;
    for (const c of KNOWN_CITIES) {
        const m = [...lower.matchAll(new RegExp(`\\b${c.replace(/\s+/g, "\\s+")}\\b`, "g"))].pop();
        if (m && m.index != null && (!best || m.index > best.i || (m.index === best.i && c.length > best.name.length))) best = { i: m.index, name: text.slice(m.index, m.index + m[0].length) };
    }
    if (!best) return address;
    const before = text.slice(0, best.i).trim().split(/\s+/).filter(Boolean);
    const state = (text.slice(best.i + best.name.length).match(STATE_WORDS) || [])[0] || "";
    const pin = pincodeOf(address);
    const street = before.slice(0, Math.max(0, before.length - 2)).join(" ");
    const locality = before.slice(-2).join(" ");
    return [street, locality, best.name, state ? `${state}${pin ? ` ${pin}` : ""}` : pin || ""].filter(Boolean).join(", ");
}

/** Area query used to set a site's location (no flat number / landmark / pincode / state). */
export function locationQueryFor(address: string): string {
    address = commaShape(address);
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
    address = commaShape(address);
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
    address = commaShape(address);
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

/**
 * Did the store set a location in the same neighbourhood as the saved address? Store location
 * strings (Google places) rarely carry a pincode, so: same pincode when shown, else same city
 * AND a distinctive locality word ("HBR", "Shankar", "Koramangala") in common.
 */
export function sameArea(shown: string | null | undefined, saved: string): boolean {
    const s = String(shown || "");
    const pin = pincodeOf(saved);
    const shownPin = pincodeOf(s);
    if (pin && shownPin) return pin === shownPin;
    if (!sameCity(s, cityOf(saved))) return false;
    const STOP = new Set(["layout", "road", "main", "cross", "block", "stage", "phase", "sector", "nagar", "colony", "street", "near", "flat", "house", "floor", "apartment", "apartments", "society", "the", "and", "india", "extension", "west", "east", "north", "south", "new", "old"]);
    const words = (x: string) => new Set((x.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w)));
    const city = (cityOf(saved) || "").toLowerCase();
    const savedWords = [...words(localityQueryFor(saved) + " " + locationQueryFor(saved))].filter((w) => !city.includes(w) && !sameCity(w, city));
    const shownWords = words(s);
    return savedWords.some((w) => shownWords.has(w));
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
