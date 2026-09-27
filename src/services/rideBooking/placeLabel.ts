/**
 * What the elder sees for a place. Raw map numbers ("21.2403, 81.6935") are never shown or put in
 * an app link: a place known only by its map point reads "Current location" until it is looked up.
 */
export const CURRENT_LOCATION = "Current location";
const COORD_PAIR_RE = /-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/;
const LEADING_PAIR_RE = /^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\b/;

export function hasCoords(s?: string | null): boolean {
    return Boolean(s && COORD_PAIR_RE.test(s));
}

/** "21.2403, 81.6935, RAIPUR" (a model or app echoing a pin) → the map point. */
export function coordsFromText(s?: string | null): { lat: number; lng: number } | null {
    const m = String(s || "").match(LEADING_PAIR_RE);
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    return { lat, lng };
}

/** A label fit to show, or "" when it is only map numbers (or carries them). */
export function displayLabel(s?: string | null): string {
    const t = String(s || "").trim();
    if (!t || hasCoords(t)) return "";
    return t;
}
