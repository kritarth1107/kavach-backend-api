/**
 * Pure parsers for ride slot-fill: intent, from/to text, WhatsApp location pins, cancel.
 */
import { RIDE_CANCEL_RE, RIDE_INTENT_RE, type RidePlace, type RideProvider } from "./types";
import { CURRENT_LOCATION, coordsFromText, displayLabel } from "./placeLabel";

/** Encoded by metaWhatsApp extractInboundText for location messages. */
export const LOCATION_PIN_RE =
    /\[location\s+lat=(-?\d+(?:\.\d+)?)\s+lng=(-?\d+(?:\.\d+)?)(?:\s+name="([^"]*)")?(?:\s+address="([^"]*)")?\]/i;

export function messageLooksLikeRideIntent(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (RIDE_INTENT_RE.test(t)) return true;
    // Short affirmations alone are NOT ride intent — slot-fill asks from/to after Yeah.
    return false;
}

export function isRideCancel(text: string): boolean {
    return RIDE_CANCEL_RE.test(text.trim());
}

export function providerFromText(text: string): RideProvider {
    const t = text.toLowerCase();
    if (/\bola\b/.test(t)) return "ola";
    if (/\brapido\b/.test(t)) return "rapido";
    return "uber";
}

export function parseLocationPin(text: string): RidePlace | null {
    const m = text.match(LOCATION_PIN_RE);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const name = displayLabel(m[3]);
    const address = displayLabel(m[4]);
    // No name from WhatsApp: looked up from the map point later; never show the numbers.
    const shortLabel = name || address || CURRENT_LOCATION;
    return {
        lat,
        lng,
        raw: text.trim(),
        address: address || name || undefined,
        shortLabel,
        source: "location_pin",
    };
}

/**
 * Parse "from X to Y", "X to Y", or single place when waiting for one slot.
 */
export function parseFromTo(text: string): { pickup?: string; drop?: string; bare?: string } {
    const t = text.trim();
    if (!t || LOCATION_PIN_RE.test(t)) return {};

    // Strip ride intent noise
    let cleaned = t
        .replace(RIDE_INTENT_RE, " ")
        .replace(/\b(please|pls|book|cab|taxi|ride|uber|ola|rapido|for\s+me)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    const fromTo =
        cleaned.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i) ||
        cleaned.match(/^(.+?)\s+to\s+(.+)$/i);
    if (fromTo) {
        const pickup = fromTo[1].replace(/^[,:\-\s]+|[,:\-\s]+$/g, "").trim();
        const drop = fromTo[2].replace(/^[,:\-\s]+|[,:\-\s]+$/g, "").trim();
        if (pickup && drop) return { pickup, drop };
    }

    const onlyFrom = cleaned.match(/\bfrom\s+(.+)$/i);
    if (onlyFrom) {
        const pickup = onlyFrom[1].replace(/^[,:\-\s]+|[,:\-\s]+$/g, "").trim();
        if (pickup) return { pickup };
    }

    const onlyTo = cleaned.match(/\bto\s+(.+)$/i);
    if (onlyTo) {
        const drop = onlyTo[1].replace(/^[,:\-\s]+|[,:\-\s]+$/g, "").trim();
        if (drop) return { drop };
    }

    // Bare place name (e.g. "ritz Carlton bangalore") when mid-slot.
    // A time ("kal subah", "chahiye abhi") or "confirm" is not a place.
    if (cleaned.length >= 2 && !/^(yeah|yes|haan|ha|ok|okay|sure|yep)$/i.test(cleaned) && !isClockPhrase(cleaned)) {
        return { bare: cleaned };
    }
    return {};
}

export function isBareAffirmation(text: string): boolean {
    return /^(yeah|yes|yep|haan|ha|ok|okay|sure|book|ride|cab|taxi)$/i.test(text.trim());
}

/**
 * "kal subah ka cab chahiye" / "cab chahiye abhi" is when, not where.
 * After the ride words are stripped, only clock and filler words are left.
 * "confirm" is a reply, never a place ("Confirm Inn").
 */
const CLOCK_WORD =
    /^(?:kal|aaj|parson|parso|subah|shaam|dopahar|raat|morning|evening|afternoon|night|tomorrow|today|tonight|abhi|now|early|late|chahiye|chahie|chaahiye|mujhe|mere|mera|meri|liye|ek|ka|ki|ke|ko|wala|wali|please|pls|for|me|a|an|the|want|need|i|my|confirm|confirmed|cancel|stop|haan|ha|yes|ok|okay|yep|yeah|sure)$/i;

export function isClockPhrase(s: string): boolean {
    const words = String(s || "")
        .toLowerCase()
        .replace(/[^a-z\u0900-\u097F\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    return words.length > 0 && words.every((w) => CLOCK_WORD.test(w));
}

export function formatRouteSummary(pickup: RidePlace, drop: RidePlace): string {
    const from =
        displayLabel(pickup.shortLabel) ||
        displayLabel(pickup.address) ||
        displayLabel(pickup.raw) ||
        (pickup.lat != null ? CURRENT_LOCATION : "pickup");
    const to =
        displayLabel(drop.shortLabel) ||
        displayLabel(drop.address) ||
        displayLabel(drop.raw) ||
        (drop.lat != null ? CURRENT_LOCATION : "drop");
    return `Got the route: from ${from} to ${to}.`;
}

export function placeFromText(raw: string): RidePlace {
    const trimmed = raw.trim().slice(0, 200);
    // Map numbers typed or echoed as text ("21.2403, 81.6935, RAIPUR") are a pin, not a place name.
    const c = coordsFromText(trimmed);
    if (c) return { lat: c.lat, lng: c.lng, raw: trimmed, shortLabel: CURRENT_LOCATION, source: "location_pin" };
    return {
        raw: trimmed,
        shortLabel: trimmed,
        source: "text",
    };
}
