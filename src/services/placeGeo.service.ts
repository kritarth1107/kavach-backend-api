/**
 * A map point for every saved place (2026-10-11: no saved place of any family had coordinates. Fast store look-ups on
 * Blinkit, Zepto, Instamart, Swiggy and Zomato need the point, so they answered 400 or "not found" for every family but
 * the one whose linked Swiggy account had geocoded its home).
 *
 * Order: a maps key when one is configured (Google, Mapbox) on the full address; else OpenStreetMap: the address, then
 * its area (the comma parts after the house), then the centre of the pincode. A hit must be in India and near the
 * pincode's centre, so a street of the same name in another city is never used. Every point says how precise it is:
 * "address" (the house or street), "area" (the locality) or "pincode" (the pincode's centre, a few km at most in a city).
 */
import { geocodePlace } from "./rideBooking/geoResolve.service";

export type PointPrecision = "address" | "area" | "pincode" | "user";
export type PlacePoint = { lat: number; lng: number; source: string; precision: PointPrecision };

const NOMINATIM = "https://nominatim.openstreetmap.org";
const UA = "KavachCare-Saheli/1.0 (elder-care; contact=support@kavach.care)";
/** A street or area hit further than this from the pincode's centre is another place with the same name. */
export const MAX_FROM_PINCODE_KM = 15;
const OSM_GAP_MS = 1_100; // OpenStreetMap's usage policy: at most one request a second
const MAX_OSM_QUERIES = 3; // per place, besides the pincode's centre

type Fetcher = (url: string, headers: Record<string, string>) => Promise<unknown>;

const defaultFetch: Fetcher = async (url, headers) => {
    const res = await fetch(url, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`geo HTTP ${res.status}`);
    return res.json();
};

let fetcher: Fetcher = defaultFetch;
/** Tests: replace the network. */
export function setGeoFetcherForTests(f: Fetcher | null): void {
    fetcher = f ?? defaultFetch;
    osmQueue = Promise.resolve();
    lastOsmAt = 0;
    pinCache.clear();
}

let osmQueue: Promise<unknown> = Promise.resolve();
let lastOsmAt = 0;

/** OpenStreetMap calls one after another, a second apart (one process; the volume is a few places a day). */
function osm(params: Record<string, string>): Promise<Array<Record<string, any>>> {
    const run = async () => {
        const wait = lastOsmAt + OSM_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastOsmAt = Date.now();
        const qs = new URLSearchParams({ ...params, format: "jsonv2", countrycodes: "in", addressdetails: "1", limit: "1" });
        const data = await fetcher(`${NOMINATIM}/search?${qs}`, { "User-Agent": UA });
        return Array.isArray(data) ? (data as Array<Record<string, any>>) : [];
    };
    const p = osmQueue.then(run, run);
    osmQueue = p.catch(() => undefined);
    return p;
}

export function inIndia(lat: number, lng: number): boolean {
    return lat > 6 && lat < 37.5 && lng > 68 && lng < 97.5;
}

export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
    const rad = (x: number) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * What to ask OpenStreetMap for one saved address, most precise first: the whole line, then without the house part(s)
 * (the comma parts of the saved line; a part that is only the pincode is not a query). At most MAX_OSM_QUERIES.
 */
export function osmQueries(full: string, pincode: string): string[] {
    const parts = String(full || "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < parts.length && out.length < MAX_OSM_QUERIES; i++) {
        const rest = parts.slice(i);
        if (rest.join("").replace(/\D/g, "") === rest.join("").replace(/\s/g, "")) break; // only numbers left (a pincode)
        const q = rest.join(", ");
        out.push(pincode && !q.includes(pincode) ? `${q} ${pincode}` : q);
    }
    return out;
}

const pinCache = new Map<string, { at: number; point: { lat: number; lng: number } | null }>();

/** The centre of an Indian pincode (OpenStreetMap postcode data), cached for the process. */
export async function pincodeCentre(pincode: string): Promise<{ lat: number; lng: number } | null> {
    if (!/^[1-9]\d{5}$/.test(pincode || "")) return null;
    const hit = pinCache.get(pincode);
    if (hit && Date.now() - hit.at < 7 * 24 * 3600_000) return hit.point;
    let point: { lat: number; lng: number } | null = null;
    try {
        const rows = await osm({ postalcode: pincode, country: "India" });
        const r = rows[0];
        const lat = Number(r?.lat);
        const lng = Number(r?.lon);
        const pc = String(r?.address?.postcode ?? "").replace(/\s/g, "");
        if (r && Number.isFinite(lat) && Number.isFinite(lng) && inIndia(lat, lng) && (!pc || pc === pincode)) point = { lat, lng };
    } catch {
        return null; // not cached: try again next time
    }
    pinCache.set(pincode, { at: Date.now(), point });
    return point;
}

const PRECISE_TYPES = new Set(["house", "building", "road", "residential", "apartments", "place", "house_number", "street"]);

/** A map point for a saved place, or null when nothing reliable was found (the order then looks with the address). */
export async function pointForPlace(place: { full: string; pincode: string }): Promise<PlacePoint | null> {
    const full = String(place.full || "").trim();
    const pincode = String(place.pincode || "").trim();
    if (!full && !pincode) return null;
    const centre = await pincodeCentre(pincode);
    const near = (p: { lat: number; lng: number }) => inIndia(p.lat, p.lng) && (!centre || kmBetween(p, centre) <= MAX_FROM_PINCODE_KM);
    const keyed = Boolean((process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY || process.env.MAPBOX_ACCESS_TOKEN || "").trim());
    if (keyed && full) {
        const g = await geocodePlace(full).catch(() => null);
        if (g?.ok && typeof g.place.lat === "number" && typeof g.place.lng === "number" && near({ lat: g.place.lat, lng: g.place.lng })) {
            return { lat: g.place.lat, lng: g.place.lng, source: g.provider, precision: "address" };
        }
    }
    for (const [i, q] of osmQueries(full, pincode).entries()) {
        let rows: Array<Record<string, any>>;
        try {
            rows = await osm({ q });
        } catch {
            break; // OpenStreetMap is down or refusing: the pincode's centre (cached) is still a point
        }
        const r = rows[0];
        const p = { lat: Number(r?.lat), lng: Number(r?.lon) };
        if (!r || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !near(p)) continue;
        const pc = String(r.address?.postcode ?? "").replace(/\s/g, "");
        if (!centre && pc !== pincode) continue; // no pincode centre to check against: the hit must carry the pincode itself
        const precise = i === 0 && PRECISE_TYPES.has(String(r.addresstype || r.type || ""));
        return { ...p, source: "openstreetmap", precision: precise ? "address" : "area" };
    }
    return centre ? { ...centre, source: "openstreetmap_pincode", precision: "pincode" } : null;
}
