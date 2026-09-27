/**
 * Multi-app ride hand-off (Uber / Ola / Rapido): city tiers, fallback chains, pre-filled links and
 * the warm WhatsApp message. Pure — no I/O (availability probes live in rideAvailability.ts).
 * Evidence: /workspace/cabs-2026-09-27/REPORT.md (tested link formats, city coverage).
 */
import type { RidePlace } from "./types";
import { CURRENT_LOCATION, displayLabel } from "./placeLabel";

export type RideService = "uber" | "ola" | "rapido";
export type Vehicle = "cab" | "auto" | "bike";
export type CityTier = "ncr" | "mumbai" | "bengaluru" | "metro" | "tier2" | "tier3";
export type Availability = "yes" | "no" | "unknown";

export const SERVICE_LABEL: Record<RideService, string> = { uber: "Uber", ola: "Ola", rapido: "Rapido" };

export type RideConfig = {
    /** tier → city names (lower-case). */
    cities: Record<Exclude<CityTier, "tier3">, string[]>;
    cabChains: Record<CityTier, RideService[]>;
    autoChain: RideService[];
    disabled: RideService[];
    /** Tier-3 towns where Uber is known to run. */
    uberExtraCities: string[];
    probeTtlHours: number;
    probeTimeoutMs: number;
    maxProbesPerHour: number;
    /** Book Ola inside the chat where Ola runs (otherwise links only). */
    olaInChat: boolean;
    /** No driver after this long → cancel the search on Ola. */
    olaSearchTimeoutSec: number;
    /** Progress line to the user about this often while searching. */
    olaUpdateEverySec: number;
    /** Keep watching an assigned ride (driver cancels) this long. */
    olaAssignedWatchMin: number;
};

const TIER_LABEL: Partial<Record<CityTier, string>> = { ncr: "Delhi NCR", mumbai: "Mumbai", bengaluru: "Bengaluru" };

export const DEFAULT_RIDE_CONFIG: RideConfig = {
    cities: {
        ncr: ["new delhi", "delhi", "gurugram", "gurgaon", "noida", "greater noida", "ghaziabad", "faridabad"],
        mumbai: ["mumbai", "bombay", "thane", "navi mumbai"],
        bengaluru: ["bengaluru", "bangalore"],
        metro: ["hyderabad", "secunderabad", "chennai", "kolkata", "pune", "ahmedabad"],
        tier2: (
            "raipur bhilai durg bilaspur bhopal indore gwalior jabalpur lucknow kanpur agra varanasi prayagraj allahabad meerut " +
            "jaipur jodhpur udaipur kota chandigarh mohali panchkula ludhiana amritsar jalandhar dehradun nagpur nashik aurangabad " +
            "kolhapur surat vadodara rajkot kochi cochin thiruvananthapuram trivandrum kozhikode thrissur coimbatore madurai " +
            "tiruchirappalli trichy salem mysuru mysore mangaluru mangalore hubli belagavi visakhapatnam vizag vijayawada guntur " +
            "tirupati warangal bhubaneswar cuttack patna ranchi jamshedpur dhanbad guwahati siliguri goa panaji margao srinagar jammu shimla"
        ).split(" "),
    },
    cabChains: {
        ncr: ["uber", "ola", "rapido"],
        mumbai: ["uber", "ola", "rapido"],
        metro: ["uber", "ola", "rapido"],
        bengaluru: ["uber", "rapido", "ola"],
        tier2: ["uber", "rapido", "ola"],
        tier3: ["rapido", "uber", "ola"],
    },
    autoChain: ["rapido", "uber", "ola"],
    disabled: [],
    uberExtraCities: [],
    probeTtlHours: 24,
    probeTimeoutMs: 16_000,
    maxProbesPerHour: 60,
    olaInChat: true,
    olaSearchTimeoutSec: 300,
    olaUpdateEverySec: 150,
    olaAssignedWatchMin: 30,
};

const SERVICES: RideService[] = ["uber", "ola", "rapido"];
const TIERS: CityTier[] = ["ncr", "mumbai", "bengaluru", "metro", "tier2", "tier3"];

/** Merge an operator doc over the defaults; anything malformed is ignored (never breaks rides). */
export function mergeRideConfig(doc: Record<string, unknown> | null | undefined): RideConfig {
    const cfg: RideConfig = JSON.parse(JSON.stringify(DEFAULT_RIDE_CONFIG));
    if (!doc) return cfg;
    const words = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim().toLowerCase()) : []);
    const chain = (v: unknown) => {
        const c = words(v).filter((x): x is RideService => SERVICES.includes(x as RideService));
        return c.length ? [...new Set(c)] : null;
    };
    const cities = (doc.cities || {}) as Record<string, unknown>;
    for (const t of Object.keys(cfg.cities) as Array<keyof RideConfig["cities"]>) {
        const extra = words(cities[t]);
        if (extra.length) cfg.cities[t] = [...new Set([...cfg.cities[t], ...extra])];
    }
    const chains = (doc.cabChains || {}) as Record<string, unknown>;
    for (const t of TIERS) {
        const c = chain(chains[t]);
        if (c) cfg.cabChains[t] = c;
    }
    const ac = chain(doc.autoChain);
    if (ac) cfg.autoChain = ac;
    cfg.disabled = words(doc.disabled).filter((x): x is RideService => SERVICES.includes(x as RideService));
    cfg.uberExtraCities = words(doc.uberExtraCities);
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && v >= lo && v <= hi ? v : d);
    cfg.probeTtlHours = num(doc.probeTtlHours, 1, 24 * 14, cfg.probeTtlHours);
    cfg.probeTimeoutMs = num(doc.probeTimeoutMs, 3000, 30_000, cfg.probeTimeoutMs);
    cfg.maxProbesPerHour = num(doc.maxProbesPerHour, 0, 1000, cfg.maxProbesPerHour);
    if (typeof doc.olaInChat === "boolean") cfg.olaInChat = doc.olaInChat;
    cfg.olaSearchTimeoutSec = num(doc.olaSearchTimeoutSec, 60, 1800, cfg.olaSearchTimeoutSec);
    cfg.olaUpdateEverySec = num(doc.olaUpdateEverySec, 60, 600, cfg.olaUpdateEverySec);
    cfg.olaAssignedWatchMin = num(doc.olaAssignedWatchMin, 5, 180, cfg.olaAssignedWatchMin);
    return cfg;
}

const reCache = new WeakMap<RideConfig, Array<[CityTier, RegExp]>>();
function cityRegexes(cfg: RideConfig): Array<[CityTier, RegExp]> {
    let r = reCache.get(cfg);
    if (!r) {
        const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
        r = (Object.keys(cfg.cities) as Array<keyof RideConfig["cities"]>)
            .filter((t) => cfg.cities[t].length)
            // Longer names first inside a tier ("navi mumbai" before "mumbai").
            .map((t) => [t, new RegExp(`\\b(${[...cfg.cities[t]].sort((a, b) => b.length - a.length).map(esc).join("|")})\\b`, "i")] as [CityTier, RegExp]);
        reCache.set(cfg, r);
    }
    return r;
}

export function detectCity(...texts: Array<string | null | undefined | RideConfig>): { city: string | null; tier: CityTier } {
    const cfg = (texts.find((x) => typeof x === "object" && x !== null) as RideConfig | undefined) || DEFAULT_RIDE_CONFIG;
    const t = texts.filter((x): x is string => typeof x === "string" && Boolean(x)).join(" | ");
    for (const [tier, re] of cityRegexes(cfg)) {
        const m = t.match(re);
        if (m) return { city: TIER_LABEL[tier] || cap(m[1]!.toLowerCase()), tier };
    }
    return { city: null, tier: "tier3" };
}

function cap(s: string): string {
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** City of a place: the tail of its geocoded address ("…, Raipur, Chhattisgarh, 492001, India"). */
export function cityOfPlaces(p?: RidePlace | null, d?: RidePlace | null, cfg: RideConfig = DEFAULT_RIDE_CONFIG): { city: string | null; tier: CityTier } {
    const tail = (x?: RidePlace | null) => (x?.address || x?.raw || x?.shortLabel || "").split(",").map((s) => s.trim()).filter(Boolean).slice(-5).join(", ");
    const a = detectCity(tail(p), cfg);
    if (a.city) return a;
    const b = detectCity(tail(d), cfg);
    if (b.city) return b;
    return detectCity(p?.address, p?.raw, p?.shortLabel, cfg);
}

/** Uber: every metro / tier-2 city plus configured towns (its logged-out page can't be trusted). */
export function uberCovers(tier: CityTier, placeText = "", cfg: RideConfig = DEFAULT_RIDE_CONFIG): boolean {
    if (tier !== "tier3") return true;
    const t = placeText.toLowerCase();
    return cfg.uberExtraCities.some((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t));
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
export function serviceChain(tier: CityTier, vehicle: Vehicle, cfg: RideConfig = DEFAULT_RIDE_CONFIG): RideService[] {
    const c = vehicle === "auto" || vehicle === "bike" ? cfg.autoChain : cfg.cabChains[tier];
    return c.filter((s) => !cfg.disabled.includes(s));
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
    placeText?: string;
    cfg?: RideConfig;
}): Choice {
    const cfg = input.cfg || DEFAULT_RIDE_CONFIG;
    const chain = serviceChain(input.tier, input.vehicle, cfg);
    const st = (s: RideService): Availability => (s === "uber" ? (uberCovers(input.tier, input.placeText, cfg) ? "yes" : "no") : input.status(s));
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
    const full = displayLabel(p?.address) || displayLabel(p?.shortLabel) || displayLabel(p?.raw) || (p?.lat != null ? CURRENT_LOCATION : "");
    return full.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 4).join(", ");
}
export function nameFor(p?: RidePlace | null): string {
    const v = (displayLabel(p?.shortLabel) || displayLabel(p?.address) || displayLabel(p?.raw) || (p?.lat != null ? CURRENT_LOCATION : "")).split(",").map((x) => x.trim()).filter(Boolean).slice(0, 2).join(", ");
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
    tier?: CityTier;
}): string | null {
    const { choice, vehicle, pickup, drop } = input;
    // Small towns: Rapido often has only bikes and autos, so don't promise a "cab".
    const smallTownRapido = vehicle === "cab" && choice.primary === "rapido" && input.tier === "tier3";
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
        smallTownRapido
            ? hi ? `*${to}* ke liye sawaari 🛺` : `Here's a ride to *${to}* 🛺`
            : hi ? `*${to}* ke liye ${VEH_HI[vehicle]} ${VEH_EMOJI[vehicle]}` : `Here's your ${VEH_EN[vehicle]} to *${to}* ${VEH_EMOJI[vehicle]}`,
        hi ? `*${P}* kholne ke liye tap kijiye — route pehle se bhara hai:` : `Tap to open *${P}* — the route is already filled in:`,
        primaryLink,
    );
    if (smallTownRapido) {
        lines.push(hi ? "Yahan Rapido par auto ya bike mil sakti hai — jo theek lage chun lijiye." : "Here Rapido may show an auto or bike — pick what suits you.");
    }
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
