/**
 * Live tools for the agent loop. No train fixture. Nothing is placed or booked.
 * called only from the agent loop.
 */

import type { GoalDoc, ToolResult } from "./types";

const ADDRESS = "C504, Sunita Park, Labhandih, near Tulip Area Hotel, Raipur, Chhattisgarh 492001";
const PINCODE = "492001";

function rupees(paise: number | undefined): string | undefined {
    if (typeof paise !== "number" || paise <= 0) return undefined;
    return `₹${(paise / 100).toFixed(paise % 100 === 0 ? 0 : 2)}`;
}

export async function liveStoreSearch(args: { store: string; query: string }): Promise<ToolResult> {
    if (process.env.SAHELI_TRAIN === "1" || process.env.VERTEX_DISABLED === "1") {
        throw new Error("refusing a fixture or a disabled model");
    }
    const store = args.store.toLowerCase();
    const query = args.query.trim();
    if (!query || /^(show\s*more|retry|more)$/i.test(query)) {
        return { ok: false, error: "refused_control_word" };
    }
    if (store === "swiggy" || store === "food" || store === "zomato") {
        if (store === "zomato") {
            const { searchGuestCatalog } = await import("../commerceAutomation/guestCatalogSearch.service");
            const res = await searchGuestCatalog({ partner: "zomato", query, address: ADDRESS, pincode: PINCODE });
            const items = (res.hits || [])
                .filter((hit) => hit.name)
                .slice(0, 16)
                .map((hit, i) => ({
                    id: `zomato-${i + 1}`,
                    name: hit.name,
                    size: hit.packLabel || "",
                    price: rupees(hit.pricePaise),
                }));
            if (items.length) return { ok: true, data: { items, source: "zomato", query, browser: "guest" } };
            const { listSwiggyRestaurants } = await import("../commerceAutomation/swiggyGuest.service");
            const restaurants = await listSwiggyRestaurants({ address: ADDRESS, query, limit: 8 });
            const fallback = (restaurants.restaurants || [])
                .filter((r) => r.name && r.open !== false)
                .slice(0, 8)
                .map((r, i) => ({
                    id: `food-${i + 1}`,
                    name: r.name,
                    size: [r.cuisines, r.eta].filter(Boolean).join(", "),
                    price: undefined,
                }));
            return {
                ok: fallback.length > 0,
                data: {
                    items: fallback,
                    source: "swiggy",
                    query,
                    browser: "guest",
                    note: res.unavailableReason || "Zomato had no priced dishes, so these are open Swiggy restaurants. No dish price.",
                },
                error: fallback.length ? undefined : res.unavailableReason || "no_open_restaurants",
            };
        }
        const { listSwiggyRestaurants } = await import("../commerceAutomation/swiggyGuest.service");
        const res = await listSwiggyRestaurants({ address: ADDRESS, query, limit: 8 });
        const items = (res.restaurants || [])
            .filter((r) => r.name && r.open !== false)
            .slice(0, 16)
            .map((r, i) => ({
                id: `food-${i + 1}`,
                name: r.name,
                size: [r.cuisines, r.eta, r.rating ? `${r.rating} rating` : ""].filter(Boolean).join(", "),
                price: undefined,
            }));
        return {
            ok: items.length > 0,
            data: { items, source: "swiggy", query, shownAddress: res.location?.shownAddress || "" },
            error: items.length ? undefined : "no_open_restaurants",
        };
    }
    const partner =
        store === "apollo" ? "apollo"
        : store === "pharmeasy" ? "pharmeasy"
        : store === "tata_1mg" || store === "1mg" ? "tata_1mg"
        : store === "blinkit" ? "blinkit"
        : store === "zepto" ? "zepto"
        : "instamart";
    const { searchGuestCatalog } = await import("../commerceAutomation/guestCatalogSearch.service");
    const res = await searchGuestCatalog({ partner, query, address: ADDRESS, pincode: PINCODE });
    const items = (res.hits || [])
        .filter((hit) => hit.name && typeof hit.pricePaise === "number" && hit.pricePaise > 0)
        .slice(0, 24)
        .map((hit, i) => ({
            id: `${partner}-${i + 1}`,
            name: hit.name,
            size: hit.packLabel || "",
            price: rupees(hit.pricePaise),
        }));
    return {
        ok: items.length > 0,
        data: { items, source: partner, query, note: res.unavailableReason || "" },
        error: items.length ? undefined : res.unavailableReason || "no_prices",
    };
}

export async function liveRideSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const { geocodePlace } = await import("../rideBooking/geoResolve.service");
    const pickupQ = String(args.pickup || "").trim();
    const dropQ = String(args.drop || "").trim();
    const pickup = await geocodePlace(pickupQ);
    const drop = await geocodePlace(dropQ);
    if (!pickup.ok || !drop.ok) {
        return {
            ok: false,
            error: "place_not_found",
            data: { pickup: pickup.place.shortLabel || pickupQ, drop: drop.place.shortLabel || dropQ, fare: null, booked: false },
        };
    }
    return {
        ok: true,
        data: {
            pickup: pickup.place.shortLabel || pickupQ,
            drop: drop.place.shortLabel || dropQ,
            fare: null,
            booked: false,
            company: String(args.company || ""),
            note: "Ola, Uber, and Rapido are not connected on this number, so there is no live fare. Nothing is booked.",
        },
    };
}

export function draftFromHits(args: Record<string, unknown>, goal: GoalDoc): ToolResult {
    const hit = goal.hits.find((row) => row.id === String(args.item_id || "")) || null;
    if (!hit) return { ok: false, error: "no_such_item" };
    return {
        ok: true,
        data: {
            item_id: hit.id,
            name: hit.name,
            price: hit.price || null,
            size: hit.size || "",
            payment: "cash",
            ordered: false,
        },
    };
}
