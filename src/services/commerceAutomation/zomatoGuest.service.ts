/**
 * Zomato guest search on the remote India-proxy Chrome (BROWSER_REMOTE=browseruse).
 * Zomato blocks our Cloud Run headless Chromium; on Browser Use Cloud's Chrome a guest can set
 * the delivery location and search (trial 2026-09-26). Zomato's search UI is heavily dynamic,
 * so the READ-ONLY search is done by Browser Use's hosted agent (Gemini flash) with a strict
 * task: set THIS recipient's address as the location, search, report dishes. No login, no cart,
 * no checkout — ordering itself stays in our own browser worker behind every existing guardrail
 * (confirm card, literal confirm, COD only, address-book match, one placement lock).
 */
import { cityOf, locationQueryFor, pincodeOf } from "./kavachAddress";
import { useRemoteBrowserFor } from "./remoteBrowser";

const API = "https://api.browser-use.com/api/v2";

export type ZomatoDish = { name: string; restaurant: string; pricePaise?: number; veg?: boolean; restaurantUrl?: string };
export type ZomatoSearchResult = { location: { ok: boolean; shown: string }; dishes: ZomatoDish[]; blocked?: boolean; costUsd?: number; note?: string };

const SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        blocked: { type: "boolean" },
        location_set: { type: "boolean" },
        location_shown: { type: "string" },
        results: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    dish: { type: "string" },
                    restaurant: { type: "string" },
                    price_rupees: { type: "number" },
                    veg: { type: "boolean" },
                    restaurant_url: { type: "string" },
                },
                required: ["dish", "restaurant"],
            },
        },
        notes: { type: "string" },
    },
    required: ["blocked", "location_set", "results"],
});

function cityUrl(address: string): string {
    const slug = (cityOf(address) || "").toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
    return slug ? `https://www.zomato.com/${slug}/delivery` : "https://www.zomato.com/";
}

function task(address: string, query: string): string {
    const loc = locationQueryFor(address);
    return [
        `Read-only lookup on the Zomato website (food delivery). You start on the delivery page: ${cityUrl(address)}`,
        `RULES: Do NOT log in or sign up. Never type a phone number, email or OTP. Do NOT add anything to the cart. Do NOT open checkout. Close app-download / login popups. Don't scroll the home page looking for things — the location box and the search box are in the top bar.`,
        `1. Set the DELIVERY location: click the location box in the top bar, type "${loc}" and pick the suggestion in ${cityOf(address) || "the same city"}${pincodeOf(address) ? ` (pincode ${pincodeOf(address)})` : ""}. Do not use "detect my location".`,
        `2. Type "${query}" in the search box and press Enter / pick the dish or restaurant suggestion.`,
        `3. The results list restaurants. Open the top 3 OPEN restaurants one by one (same tab, then go back) and in each menu find the item(s) that best match "${query}" with their price. If the search term is a restaurant name, open that restaurant and list its matching items.`,
        `4. Report up to 6 results: dish name, restaurant name, the price in rupees exactly as shown on the menu (Zomato often hides menu prices from guests — then leave the price out, never guess it), veg or not, and the restaurant page URL. Skip closed restaurants, add-ons, sauces and extras. Don't spend more than ~25 steps.`,
        `If an access-denied / captcha page blocks you, stop and report blocked=true. Then finish.`,
    ].join("\n");
}

async function bu<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${API}${path}`, {
        method,
        headers: { "X-Browser-Use-API-Key": (process.env.BROWSER_USE_API_KEY || "").trim(), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`browseruse ${method} ${r.status}: ${text.slice(0, 160)}`);
    return (text ? JSON.parse(text) : {}) as T;
}

export function zomatoSearchAvailable(): boolean {
    return useRemoteBrowserFor("zomato");
}

export async function zomatoSearch(input: { address: string; query: string; budgetMs?: number }): Promise<ZomatoSearchResult> {
    if (!zomatoSearchAvailable()) return { location: { ok: false, shown: "" }, dishes: [], note: "remote_off" };
    const created = await bu<{ id: string }>("POST", "/tasks", {
        task: task(input.address, input.query.slice(0, 80)),
        llm: process.env.BROWSER_USE_AGENT_MODEL?.trim() || "gemini-3-flash-preview",
        startUrl: cityUrl(input.address),
        maxSteps: Number(process.env.BROWSER_USE_AGENT_MAX_STEPS) || 30,
        structuredOutput: SCHEMA,
        sessionSettings: { proxyCountryCode: "in" },
        metadata: { app: "kavach", partner: "zomato", kind: "guest_search" },
    });
    const t0 = Date.now();
    const budget = input.budgetMs ?? (Number(process.env.ZOMATO_SEARCH_BUDGET_MS) || 300_000);
    let t: { status?: string; output?: unknown; cost?: string | number } = {};
    try {
        while (Date.now() - t0 < budget) {
            await new Promise((r) => setTimeout(r, 5000));
            t = await bu<typeof t>("GET", `/tasks/${created.id}`).catch(() => t);
            if (t.status === "finished" || t.status === "stopped") break;
        }
    } finally {
        if (t.status !== "finished" && t.status !== "stopped") {
            await bu("PATCH", `/tasks/${created.id}`, { action: "stop_task_and_session" }).catch(() => undefined);
        }
    }
    if (t.status !== "finished") throw new Error("zomato_guest_timeout");
    let out: {
        blocked?: boolean;
        location_set?: boolean;
        location_shown?: string;
        results?: Array<{ dish?: string; restaurant?: string; price_rupees?: number; veg?: boolean; restaurant_url?: string }>;
    } = {};
    try {
        out = typeof t.output === "string" ? JSON.parse(t.output) : ((t.output as typeof out) ?? {});
    } catch {
        out = {};
    }
    const shown = String(out.location_shown || "");
    const city = cityOf(input.address);
    // Never show prices for another area: the location must be in the recipient's city.
    const inCity = !city || new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(shown) || shown.includes(pincodeOf(input.address) || "@@");
    const location = { ok: Boolean(out.location_set) && inCity, shown };
    const dishes: ZomatoDish[] = (out.results || [])
        .filter((r) => r.dish && r.restaurant)
        .map((r) => ({
            name: String(r.dish).slice(0, 90),
            restaurant: String(r.restaurant).slice(0, 60),
            pricePaise: Number.isFinite(Number(r.price_rupees)) && Number(r.price_rupees) > 0 ? Math.round(Number(r.price_rupees) * 100) : undefined,
            veg: typeof r.veg === "boolean" ? r.veg : undefined,
            restaurantUrl: /^https:\/\/(www\.)?zomato\.com\//.test(String(r.restaurant_url || "")) ? String(r.restaurant_url) : undefined,
        }));
    return { location, dishes: location.ok ? dishes : [], blocked: Boolean(out.blocked), costUsd: Number(t.cost) || undefined };
}
