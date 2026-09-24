/**
 * Resolve named places → lat/lng/address and reverse-geocode WhatsApp pins.
 * Prefers GOOGLE_MAPS_API_KEY / MAPBOX_ACCESS_TOKEN when set; else Nominatim/OSM.
 * Never invents API keys.
 */
import type { RidePlace } from "./types";

const NOMINATIM = "https://nominatim.openstreetmap.org";
const UA = "KavachCare-SaheliRides/1.0 (elder-care; contact=support@kavach.care)";

export type GeoResult = {
    ok: boolean;
    place: RidePlace;
    provider: "google" | "mapbox" | "nominatim" | "passthrough";
    error?: string;
};

function shortFromAddress(address: string): string {
    // Prefer first 1–2 comma segments for Instinct-style plain words
    const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
    return parts[0] || address.slice(0, 80);
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    const res = await fetch(url, {
        headers: { Accept: "application/json", ...(headers || {}) },
        signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`geo HTTP ${res.status}`);
    return res.json();
}

async function nominatimGeocode(query: string): Promise<GeoResult> {
    const url = `${NOMINATIM}/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const data = (await fetchJson(url, { "User-Agent": UA })) as Array<{
        lat?: string;
        lon?: string;
        display_name?: string;
    }>;
    const hit = data?.[0];
    if (!hit?.lat || !hit?.lon) {
        return {
            ok: false,
            provider: "nominatim",
            place: { raw: query, shortLabel: query, source: "text" },
            error: "place_not_found",
        };
    }
    const address = String(hit.display_name || query);
    return {
        ok: true,
        provider: "nominatim",
        place: {
            raw: query,
            address,
            shortLabel: shortFromAddress(address),
            lat: Number(hit.lat),
            lng: Number(hit.lon),
            source: "geocode",
        },
    };
}

async function nominatimReverse(lat: number, lng: number): Promise<GeoResult> {
    const url = `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lng}`;
    const data = (await fetchJson(url, { "User-Agent": UA })) as {
        display_name?: string;
        address?: Record<string, string>;
    };
    const address = String(data?.display_name || `${lat}, ${lng}`);
    const road = data?.address?.road || data?.address?.neighbourhood || data?.address?.suburb;
    const short = road
        ? shortFromAddress([road, data?.address?.suburb || data?.address?.city || data?.address?.town]
              .filter(Boolean)
              .join(", "))
        : shortFromAddress(address);
    return {
        ok: true,
        provider: "nominatim",
        place: {
            lat,
            lng,
            address,
            shortLabel: short,
            source: "reverse_geocode",
        },
    };
}

async function googleGeocode(query: string, key: string): Promise<GeoResult> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${key}`;
    const data = (await fetchJson(url)) as {
        status?: string;
        results?: Array<{
            formatted_address?: string;
            geometry?: { location?: { lat: number; lng: number } };
        }>;
    };
    const hit = data?.results?.[0];
    if (!hit?.geometry?.location) {
        return {
            ok: false,
            provider: "google",
            place: { raw: query, shortLabel: query, source: "text" },
            error: data?.status || "place_not_found",
        };
    }
    const address = String(hit.formatted_address || query);
    return {
        ok: true,
        provider: "google",
        place: {
            raw: query,
            address,
            shortLabel: shortFromAddress(address),
            lat: hit.geometry.location.lat,
            lng: hit.geometry.location.lng,
            source: "geocode",
        },
    };
}

async function googleReverse(lat: number, lng: number, key: string): Promise<GeoResult> {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${key}`;
    const data = (await fetchJson(url)) as {
        results?: Array<{ formatted_address?: string }>;
    };
    const address = String(data?.results?.[0]?.formatted_address || `${lat}, ${lng}`);
    return {
        ok: true,
        provider: "google",
        place: {
            lat,
            lng,
            address,
            shortLabel: shortFromAddress(address),
            source: "reverse_geocode",
        },
    };
}

async function mapboxGeocode(query: string, token: string): Promise<GeoResult> {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${token}&limit=1`;
    const data = (await fetchJson(url)) as {
        features?: Array<{ place_name?: string; center?: [number, number] }>;
    };
    const hit = data?.features?.[0];
    if (!hit?.center) {
        return {
            ok: false,
            provider: "mapbox",
            place: { raw: query, shortLabel: query, source: "text" },
            error: "place_not_found",
        };
    }
    const address = String(hit.place_name || query);
    return {
        ok: true,
        provider: "mapbox",
        place: {
            raw: query,
            address,
            shortLabel: shortFromAddress(address),
            lng: hit.center[0],
            lat: hit.center[1],
            source: "geocode",
        },
    };
}

async function mapboxReverse(lat: number, lng: number, token: string): Promise<GeoResult> {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?access_token=${token}&limit=1`;
    const data = (await fetchJson(url)) as {
        features?: Array<{ place_name?: string }>;
    };
    const address = String(data?.features?.[0]?.place_name || `${lat}, ${lng}`);
    return {
        ok: true,
        provider: "mapbox",
        place: {
            lat,
            lng,
            address,
            shortLabel: shortFromAddress(address),
            source: "reverse_geocode",
        },
    };
}

/** Geocode a named place (e.g. "ritz Carlton bangalore"). */
export async function geocodePlace(query: string): Promise<GeoResult> {
    const q = query.trim().slice(0, 200);
    if (!q) {
        return {
            ok: false,
            provider: "passthrough",
            place: { raw: "", shortLabel: "", source: "text" },
            error: "empty",
        };
    }
    const googleKey = (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY || "").trim();
    const mapbox = (process.env.MAPBOX_ACCESS_TOKEN || "").trim();
    try {
        if (googleKey) return await googleGeocode(q, googleKey);
        if (mapbox) return await mapboxGeocode(q, mapbox);
        return await nominatimGeocode(q);
    } catch (err) {
        return {
            ok: false,
            provider: googleKey ? "google" : mapbox ? "mapbox" : "nominatim",
            place: { raw: q, shortLabel: q, source: "text" },
            error: err instanceof Error ? err.message : "geocode_failed",
        };
    }
}

/** Reverse-geocode a WhatsApp location pin. */
export async function reverseGeocode(lat: number, lng: number): Promise<GeoResult> {
    const googleKey = (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY || "").trim();
    const mapbox = (process.env.MAPBOX_ACCESS_TOKEN || "").trim();
    try {
        if (googleKey) return await googleReverse(lat, lng, googleKey);
        if (mapbox) return await mapboxReverse(lat, lng, mapbox);
        return await nominatimReverse(lat, lng);
    } catch (err) {
        return {
            ok: false,
            provider: googleKey ? "google" : mapbox ? "mapbox" : "nominatim",
            place: {
                lat,
                lng,
                shortLabel: `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
                source: "location_pin",
            },
            error: err instanceof Error ? err.message : "reverse_failed",
        };
    }
}

/** Enrich a RidePlace: reverse if pin coords, geocode if text-only. */
export async function resolveRidePlace(place: RidePlace): Promise<RidePlace> {
    if (place.lat != null && place.lng != null && !place.address) {
        const rev = await reverseGeocode(place.lat, place.lng);
        return { ...place, ...rev.place, raw: place.raw || rev.place.raw };
    }
    if ((!place.lat || !place.lng) && (place.raw || place.shortLabel)) {
        const q = place.raw || place.shortLabel || "";
        const geo = await geocodePlace(q);
        if (geo.ok) return { ...place, ...geo.place };
        return { ...place, address: place.address || q, shortLabel: place.shortLabel || q };
    }
    return place;
}
