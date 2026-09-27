/**
 * Multi-app ride hand-off (Uber / Ola / Rapido): city tiers, fallback chains, pre-filled links and
 * the warm WhatsApp message. Pure — no I/O (availability probes live in rideAvailability.ts).
 * Evidence: /workspace/cabs-2026-09-27/REPORT.md (tested link formats, city coverage).
 */
import type { RidePlace } from "./types";

export type RideService = "uber" | "ola" | "rapido";
export type Vehicle = "cab" | "auto" | "bike";
export type CityTier = "ncr" | "mumbai" | "bengaluru" | "metro" | "tier2" | "tier3";
export type Availability = "yes" | "no" | "unknown";

export const SERVICE_LABEL: Record<RideService, string> = { uber: "Uber", ola: "Ola", rapido: "Rapido" };

const CITY_TABLE: Array<[CityTier, string, RegExp]> = [
    ["ncr", "Delhi NCR", /\b(new delhi|delhi|gurugram|gurgaon|noida|greater noida|ghaziabad|faridabad)\b/i],
    ["mumbai", "Mumbai", /\b(mumbai|bombay|thane|navi mumbai)\b/i],
    ["bengaluru", "Bengaluru", /\b(bengaluru|bangalore)\b/i],
    ["metro", "", /\b(hyderabad|secunderabad|chennai|kolkata|pune|ahmedabad)\b/i],
    [
        "tier2",
        "",
        /\b(raipur|bhilai|durg|bilaspur|bhopal|indore|gwalior|jabalpur|lucknow|kanpur|agra|varanasi|prayagraj|allahabad|meerut|jaipur|jodhpur|udaipur|kota|chandigarh|mohali|panchkula|ludhiana|amritsar|jalandhar|dehradun|nagpur|nashik|aurangabad|kolhapur|surat|vadodara|rajkot|kochi|cochin|thiruvananthapuram|trivandrum|kozhikode|thrissur|coimbatore|madurai|tiruchirappalli|trichy|salem|mysuru|mysore|mangaluru|mangalore|hubli|belagavi|visakhapatnam|vizag|vijayawada|guntur|tirupati|warangal|bhubaneswar|cuttack|patna|ranchi|jamshedpur|dhanbad|guwahati|siliguri|goa|panaji|margao|srinagar|jammu|shimla)\b/i,
    ],
];

export function detectCity(...texts: Array<string | null | undefined>): { city: string | null; tier: CityTier } {
    const t = texts.filter(Boolean).join(" | ");
    for (const [tier, label, re] of CITY_TABLE) {
        const m = t.match(re);
        if (m) return { city: label || cap(m[1]!), tier };
    }
    return { city: null, tier: "tier3" };
}

function cap(s: string): string {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** City of a place: the tail of its geocoded address ("…, Raipur, Chhattisgarh, 492001, India"). */
export function cityOfPlaces(p?: RidePlace | null, d?: RidePlace | null): { city: string | null; tier: CityTier } {
    const tail = (x?: RidePlace | null) => (x?.address || x?.raw || x?.shortLabel || "").split(",").map((s) => s.trim()).filter(Boolean).slice(-5).join(", ");
    const a = detectCity(tail(p));
    if (a.city) return a;
    const b = detectCity(tail(d));
    if (b.city) return b;
    return detectCity(p?.address, p?.raw, p?.shortLabel);
}

/** Uber runs in every metro and tier-2 city above (static list; its logged-out page can't be trusted). */
export function uberCovers(tier: CityTier): boolean {
    return tier !== "tier3";
}

export function isAirport(p?: RidePlace | null): boolean {
    const t = `${p?.shortLabel || ""} ${p?.address || ""} ${p?.raw || ""}`;
    return /\b(airport|terminal\s*[1-3]|\bT[1-3]\b|IGI|KIA|CSMIA|hawai\s*adda|havai\s*adda)\b/i.test(t);
}

export function vehicleFromText(t: string): Vehicle | null {
    if (/\b(auto|rickshaw|riksha|tuk\s*tuk|e-?rick\w*)\b/i.test(t)) return "auto";
    if (/\b(bike|moto|scooty)\b/i.test(t) && !/\bbike\s*taxi\s*nahi\b/i.test(t)) return "bike";
    if (/\b(cab|taxi|car|gaadi|gadi|sedan|suv)\b/i.test(t)) return "cab";
    return null;
}

export function serviceFromText(t: string): RideService | "namma_yatri" | null {
    if (/\bnamma\s*yatri\b/i.test(t)) return "namma_yatri";
    if (/\bola\b/i.test(t)) return "ola";
    if (/\brapido\b/i.test(t)) return "rapido";
    if (/\buber\b/i.test(t)) return "uber";
    return null;
}

/** Fallback order per city tier and vehicle (first available wins). */
export function serviceChain(tier: CityTier, vehicle: Vehicle): RideService[] {
    if (vehicle === "auto" || vehicle === "bike") {
        return ["rapido", "uber", "ola"];
    }
    switch (tier) {
        case "ncr":
        case "mumbai":
        case "metro":
            return ["uber", "ola", "rapido"];
        case "bengaluru":
        case "tier2":
            return ["uber", "rapido", "ola"];
        case "tier3":
            return ["rapido", "uber", "ola"];
    }
}

/** Elders go by cab to airports unless they clearly asked for something else. */
export function pickVehicle(asked: Vehicle | null | undefined, pickup?: RidePlace, drop?: RidePlace): Vehicle {
    if (asked) return asked;
    return "cab";
}

export type Choice = {
    primary: RideService | null;
    alt: RideService | null;
    /** The app she named isn't running here. */
    requestedUnavailable?: RideService | "namma_yatri";
    nammaYatriNote: boolean;
    airportAutoNote: boolean;
};

export function chooseServices(input: {
    tier: CityTier;
    vehicle: Vehicle;
    requested?: RideService | "namma_yatri" | null;
    status: (s: RideService) => Availability;
    airport: boolean;
}): Choice {
    const chain = serviceChain(input.tier, input.vehicle);
    const st = (s: RideService): Availability => (s === "uber" ? (uberCovers(input.tier) ? "yes" : "no") : input.status(s));
    // Confirmed first, then unknown (keeps the chain order inside each group); "no" dropped.
    const usable = [...chain.filter((s) => st(s) === "yes"), ...chain.filter((s) => st(s) === "unknown")];
    let primary: RideService | null = usable[0] ?? null;
    let requestedUnavailable: Choice["requestedUnavailable"];
    const req = input.requested;
    if (req === "namma_yatri") {
        requestedUnavailable = "namma_yatri";
    } else if (req) {
        if (usable.includes(req)) primary = req;
        else requestedUnavailable = req;
    }
    const alt = usable.find((s) => s !== primary) ?? null;
    return {
        primary,
        alt,
        requestedUnavailable,
        nammaYatriNote: input.tier === "bengaluru" && input.vehicle === "auto",
        airportAutoNote: input.airport && input.vehicle !== "cab",
    };
}

// ── Links (formats verified in the feasibility report) ─────────────────────────────────────

function textFor(p?: RidePlace | null): string {
    const full = p?.address || p?.shortLabel || p?.raw || "";
    return full.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", ");
}
export function nameFor(p?: RidePlace | null): string {
    const v = (p?.shortLabel || p?.address || p?.raw || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 2).join(", ");
    return v.length > 60 ? `${v.slice(0, 59)}…` : v;
}
/** encodeURIComponent leaves ( ) ! ' * — Rapido's router breaks on parentheses. */
function enc(s: string): string {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function uberLink(p?: RidePlace, d?: RidePlace): string {
    const q = new URLSearchParams({ action: "setPickup" });
    if (p?.lat != null && p?.lng != null) {
        q.set("pickup[latitude]", String(p.lat));
        q.set("pickup[longitude]", String(p.lng));
        const n = nameFor(p);
        if (n) q.set("pickup[nickname]", n);
    } else q.set("pickup", "my_location");
    if (d?.lat != null && d?.lng != null) {
        q.set("dropoff[latitude]", String(d.lat));
        q.set("dropoff[longitude]", String(d.lng));
    }
    const da = textFor(d);
    if (da) q.set("dropoff[formatted_address]", da.slice(0, 120));
    return `https://m.uber.com/ul/?${q.toString()}`;
}

export function olaLink(p?: RidePlace, d?: RidePlace): string | null {
    if (p?.lat == null || p?.lng == null || d?.lat == null || d?.lng == null) return null;
    return (
        `https://book.olacabs.com/?lat=${p.lat}&lng=${p.lng}&drop_lat=${d.lat}&drop_lng=${d.lng}` +
        `&pickup_name=${enc(nameFor(p))}&drop_name=${enc(nameFor(d))}&dsw=yes&serviceType=p2p`
    );
}

export function rapidoLink(p?: RidePlace, d?: RidePlace): string | null {
    const a = textFor(p);
    const b = textFor(d);
    if (!a || !b) return null;
    return `https://m.rapido.bike/unup-home/seo/${enc(a)}/${enc(b)}?version=v3`;
}

export function linkFor(s: RideService, p?: RidePlace, d?: RidePlace): string | null {
    return s === "uber" ? uberLink(p, d) : s === "ola" ? olaLink(p, d) : rapidoLink(p, d);
}

// ── Messages ──────────────────────────────────────────────────────────────────────────────

const VEH_EN: Record<Vehicle, string> = { cab: "cab", auto: "auto", bike: "bike ride" };
const VEH_HI: Record<Vehicle, string> = { cab: "cab", auto: "auto", bike: "bike" };
const VEH_EMOJI: Record<Vehicle, string> = { cab: "🚕", auto: "🛺", bike: "🏍️" };

export function isHindi(lang?: string | null): boolean {
    return /^hi/i.test(String(lang || ""));
}

export function handoffMessage(input: {
    choice: Choice;
    vehicle: Vehicle;
    pickup?: RidePlace;
    drop?: RidePlace;
    lang?: string | null;
}): string | null {
    const { choice, vehicle, pickup, drop } = input;
    const hi = isHindi(input.lang);
    const primaryLink = choice.primary ? linkFor(choice.primary, pickup, drop) : null;
    if (!choice.primary || !primaryLink) return null;
    const altLink = choice.alt ? linkFor(choice.alt, pickup, drop) : null;
    const to = nameFor(drop) || (hi ? "aapki jagah" : "your drop");
    const P = SERVICE_LABEL[choice.primary];
    const lines: string[] = [];
    if (choice.requestedUnavailable) {
        const r = choice.requestedUnavailable === "namma_yatri" ? "Namma Yatri" : SERVICE_LABEL[choice.requestedUnavailable];
        lines.push(
            choice.requestedUnavailable === "namma_yatri"
                ? hi
                    ? "Namma Yatri sirf apne app mein chalta hai — agar aapke phone mein hai to wahan yeh route daal dijiye. Yahan se seedha link ke liye:"
                    : "Namma Yatri works only in its own app — if you have it, enter this route there. For a ready link:"
                : hi
                  ? `${r} abhi yahan nahi chal raha 🙏`
                  : `${r} doesn't seem to run here right now 🙏`,
            "",
        );
    }
    lines.push(
        hi ? `*${to}* ke liye ${VEH_HI[vehicle]} ${VEH_EMOJI[vehicle]}` : `Here's your ${VEH_EN[vehicle]} to *${to}* ${VEH_EMOJI[vehicle]}`,
        hi ? `*${P}* kholne ke liye tap kijiye — route pehle se bhara hai:` : `Tap to open *${P}* — the route is already filled in:`,
        primaryLink,
    );
    if (choice.alt && altLink) {
        lines.push("", hi ? `Ya *${SERVICE_LABEL[choice.alt]}* try kijiye:` : `Or try *${SERVICE_LABEL[choice.alt]}*:`, altLink);
    }
    if (choice.nammaYatriNote && choice.requestedUnavailable !== "namma_yatri") {
        lines.push("", hi ? "Namma Yatri app bhi yahan autos ke liye accha hai, agar aapke phone mein hai." : "If you have the Namma Yatri app, it's good for autos here too.");
    }
    if (choice.airportAutoNote) {
        lines.push("", hi ? "Airport ke liye saamaan ke saath cab zyada aaraamdayak rahegi — cab chahiye to *cab* likhiye." : "For the airport a cab is easier with luggage — say *cab* if you'd like one.");
    }
    lines.push("", hi ? "Jab tak aap app mein confirm nahi karte, kuch book nahi hota." : "Nothing is booked until you tap and confirm in the app.");
    return lines.join("\n");
}

export function noServiceMessage(input: { pickup?: RidePlace; lang?: string | null; canOfferFamily: boolean; familyName?: string }): string {
    const hi = isHindi(input.lang);
    const area = nameFor(input.pickup) || (hi ? "is jagah" : "this area");
    const who = input.familyName || (hi ? "aapke parivaar" : "your family");
    if (hi) {
        return input.canOfferFamily
            ? `*${area}* mein abhi Uber, Ola ya Rapido nahi mil raha 🙏 Kya main ${who} ko message kar doon ki woh ride ka intezaam kar dein? *haan* likhiye.`
            : `*${area}* mein abhi Uber, Ola ya Rapido nahi mil raha 🙏 Thodi der baad phir try kar sakte hain.`;
    }
    return input.canOfferFamily
        ? `I couldn't find Uber, Ola or Rapido serving *${area}* right now 🙏 Shall I message ${who} to arrange a ride? Reply *yes*.`
        : `I couldn't find Uber, Ola or Rapido serving *${area}* right now 🙏 We can try again in a little while.`;
}

/** Cache key for availability: the named city, else a ~11 km grid cell around the pickup. */
export function cityKey(city: string | null, p?: RidePlace): string {
    if (city) return city.toLowerCase();
    if (p?.lat != null && p?.lng != null) return `${p.lat.toFixed(1)},${p.lng.toFixed(1)}`;
    return (textFor(p) || "unknown").toLowerCase().slice(0, 60);
}
