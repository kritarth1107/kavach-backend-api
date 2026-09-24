/**
 * Pure parsers for ride slot-fill: intent, from/to text, WhatsApp location pins, cancel.
 */
import { RIDE_CANCEL_RE, RIDE_INTENT_RE, type RidePlace, type RideProvider } from "./types";

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
    const name = (m[3] || "").trim();
    const address = (m[4] || "").trim();
    const shortLabel = name || address || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
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

    // Bare place name (e.g. "ritz Carlton bangalore") when mid-slot
    if (cleaned.length >= 2 && !/^(yeah|yes|haan|ha|ok|okay|sure|yep)$/i.test(cleaned)) {
        return { bare: cleaned };
    }
    return {};
}

export function isBareAffirmation(text: string): boolean {
    return /^(yeah|yes|yep|haan|ha|ok|okay|sure|book|ride|cab|taxi)$/i.test(text.trim());
}

export function formatRouteSummary(pickup: RidePlace, drop: RidePlace): string {
    const from =
        pickup.shortLabel ||
        pickup.address ||
        pickup.raw ||
        (pickup.lat != null ? `${pickup.lat.toFixed(4)}, ${pickup.lng?.toFixed(4)}` : "pickup");
    const to =
        drop.shortLabel ||
        drop.address ||
        drop.raw ||
        (drop.lat != null ? `${drop.lat.toFixed(4)}, ${drop.lng?.toFixed(4)}` : "drop");
    return `Got the route: from ${from} to ${to}.`;
}

export function placeFromText(raw: string): RidePlace {
    const trimmed = raw.trim().slice(0, 200);
    return {
        raw: trimmed,
        shortLabel: trimmed,
        source: "text",
    };
}
