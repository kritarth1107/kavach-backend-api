/**
 * Swiggy (food) + Instamart guest browsing in our own headless Chromium — no login, no MCP.
 * The site location is set to THIS care recipient's saved address (passed in by the caller —
 * there is no default) BEFORE anything is read, never a store-account address.
 *
 * Verified as guest (2026-09-26): location search, restaurant list (name/rating/ETA/cuisines),
 * restaurant menu (open/closed + "opens at"), dish search, Instamart item search.
 * Needs login: adding to cart + checkout (handled by the browser order flow after confirm).
 */
import type { Browser, BrowserContext, Page } from "playwright";
import { cityOf, locationQueryFor, pincodeOf } from "./kavachAddress";

const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE = "https://www.swiggy.com";

type Loc = { address: string; lat: number; lng: number; at: number };
const locCache = new Map<string, Loc>();
const LOC_TTL_MS = 12 * 60 * 60_000;

export type GuestRestaurant = {
    name: string;
    rating?: string;
    eta?: string;
    etaMaxMins?: number;
    cuisines?: string;
    area?: string;
    /** true = taking orders now; false = closed / not delivering here; null = unknown. */
    open: boolean | null;
    closedNote?: string;
};

export type GuestDish = { name: string; pricePaise?: number; veg?: boolean; restaurant?: string };

export type GuestLocation = { ok: boolean; shownAddress: string; pincodeMatch: boolean };

async function launch(): Promise<{ browser: Browser; ctx: BrowserContext }> {
    const pw = await import("playwright");
    const browser = await pw.chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"],
    });
    const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-IN" });
    await ctx.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    return { browser, ctx };
}

async function withGuest<T>(fn: (ctx: BrowserContext, page: Page) => Promise<T>, budgetMs = 40_000): Promise<T> {
    const { browser, ctx } = await launch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const page = await ctx.newPage();
        page.setDefaultTimeout(12_000);
        return await Promise.race([
            fn(ctx, page),
            new Promise<T>((_, rej) => {
                timer = setTimeout(() => rej(new Error("swiggy_guest_timeout")), budgetMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        await browser.close().catch(() => undefined);
    }
}

async function bodyText(page: Page): Promise<string> {
    return (await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string;
}

async function waitForContent(page: Page, ms = 12_000): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        const t = await bodyText(page);
        if (t.length > 200) return;
        await page.waitForTimeout(700);
    }
}

async function readLocationCookie(ctx: BrowserContext): Promise<Loc | null> {
    const c = (await ctx.cookies(BASE)).find((x) => x.name === "userLocation");
    if (!c) return null;
    try {
        const j = JSON.parse(decodeURIComponent(c.value)) as { address?: string; lat?: number | string; lng?: number | string };
        const lat = Number(j.lat);
        const lng = Number(j.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        return { address: String(j.address || ""), lat, lng, at: Date.now() };
    } catch {
        return null;
    }
}

async function applyCachedLocation(ctx: BrowserContext, loc: Loc): Promise<void> {
    const value = encodeURIComponent(
        JSON.stringify({ address: loc.address, area: "", deliveryLocation: "", lat: loc.lat, lng: loc.lng }),
    );
    await ctx.addCookies([{ name: "userLocation", value, domain: "www.swiggy.com", path: "/" }]);
}

/**
 * Set Swiggy's delivery location to the Kavach address (area search → pick the suggestion
 * in the right city). Cached per address for 12h (lat/lng cookie).
 */
export async function setSwiggyLocation(ctx: BrowserContext, page: Page, address: string): Promise<GuestLocation> {
    const pin = pincodeOf(address);
    const cached = locCache.get(address);
    if (cached && Date.now() - cached.at < LOC_TTL_MS) {
        await applyCachedLocation(ctx, cached);
        return { ok: true, shownAddress: cached.address, pincodeMatch: !pin || cached.address.includes(pin) };
    }
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await waitForContent(page);
    const opener = page.locator("header").getByText(/^(Other|Setup your location|Home|Work)$/).first();
    if (await opener.count().catch(() => 0)) await opener.click({ timeout: 4000 }).catch(() => undefined);
    else await page.getByText("Other", { exact: true }).first().click({ timeout: 4000 }).catch(() => undefined);
    const input = page.locator('input[placeholder*="area" i], input[placeholder*="location" i]').first();
    await input.waitFor({ state: "visible", timeout: 6000 });
    const query = locationQueryFor(address);
    await input.fill(query);
    await page.waitForTimeout(2200);
    const city = (cityOf(address) || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").trim();
    // Suggestions read "<Place>" + "<street>, <Area>, <City>, <State>, India"; the page heading
    // "…delivery in <City>" has no comma after the city, so it never matches.
    const pick = city
        ? page.getByText(new RegExp(`\\b${city}\\s*,`, "i")).first()
        : page.locator('[data-testid*="location" i] >> text=/,/').first();
    // Cloud Run is slower than a laptop: give the suggestions time, re-type once if none.
    if (!(await pick.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false))) {
        await input.fill("");
        await input.pressSequentially(query, { delay: 40 });
        await pick.waitFor({ state: "visible", timeout: 10_000 }).catch(async () => {
            const snip = ((await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string).replace(/\s+/g, " ").slice(0, 160);
            throw new Error(`swiggy_location_no_suggestion (${snip})`);
        });
    }
    await pick.click({ timeout: 5000 });
    await page.waitForTimeout(2500);
    const loc = await readLocationCookie(ctx);
    if (!loc) return { ok: false, shownAddress: "", pincodeMatch: false };
    locCache.set(address, loc);
    return { ok: true, shownAddress: loc.address, pincodeMatch: !pin || loc.address.includes(pin) };
}

function parseEtaMax(eta?: string): number | undefined {
    const m = eta?.match(/(\d+)\s*-\s*(\d+)\s*mins?/i) || eta?.match(/(\d+)\s*mins?/i);
    if (!m) return undefined;
    return Number(m[2] || m[1]);
}

function parseListCard(lines: string[]): GuestRestaurant | null {
    const name = lines[0];
    if (!name) return null;
    const rl = lines.find((l) => /•/.test(l) && /min/i.test(l)) || "";
    const rating = rl.match(/^(\d(?:\.\d)?)/)?.[1];
    const eta = rl.match(/(\d+\s*-\s*\d+\s*mins?|\d+\s*mins?)/i)?.[1];
    const rest = lines.filter((l) => l !== name && l !== rl);
    return { name, rating, eta, etaMaxMins: parseEtaMax(eta), cuisines: rest[0], area: rest[1], open: null };
}

/** Open a restaurant from the list page by name and read its menu (open status + dishes). */
async function openRestaurantAndRead(page: Page, name: string, dishQuery?: string): Promise<{ open: boolean; closedNote?: string; dishes: GuestDish[]; url: string } | null> {
    const card = page.locator('[data-testid="restaurant_list_card"]').filter({ hasText: name }).first();
    if (!(await card.count().catch(() => 0))) return null;
    await card.click({ timeout: 6000 });
    await page.waitForURL(/\/city\/|\/restaurants\//, { timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1800);
    return readMenu(page, name, dishQuery);
}

async function readMenu(page: Page, restaurant: string, dishQuery?: string): Promise<{ open: boolean; closedNote?: string; dishes: GuestDish[]; url: string }> {
    const text = await bodyText(page);
    const closed = /not accepting orders|closed\s*&\s*not delivering|currently closed|\bClosed\b\s*•?\s*Opens|currently not taking orders|not delivering/i.test(text);
    const opens =
        text.match(/back by\s+([0-9: ]+\s*[AP]M)/i)?.[1] || text.match(/Opens\s+(?:at\s+)?([0-9: ]+\s*[ap]m)/i)?.[1];
    const raw = (await page
        .locator('[data-testid="normal-dish-item"]')
        .evaluateAll((els) => els.slice(0, 120).map((e) => (e as HTMLElement).innerText.split("\n")[0] || ""))
        .catch(() => [])) as string[];
    const dishes: GuestDish[] = [];
    for (const r of raw) {
        const m = r.match(/^(Veg Item|Non-veg item)\.\s*(.+?)\.\s*(?:This item is[^,]*,\s*)?Costs:\s*([\d.]+)\s*rupees/i);
        if (!m) continue;
        const name = m[2].trim();
        if (dishes.some((d) => d.name === name)) continue;
        dishes.push({ name, pricePaise: Math.round(Number(m[3]) * 100), veg: /^veg/i.test(m[1]), restaurant });
    }
    return {
        open: !closed,
        closedNote: closed ? (opens ? `closed now — opens ${opens.trim()}` : "closed / not delivering here now") : undefined,
        dishes: dishQuery ? rankDishes(dishes, dishQuery) : dishes,
        url: page.url(),
    };
}

function tokens(s: string): string[] {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3);
}

export function rankDishes(dishes: GuestDish[], query: string): GuestDish[] {
    const q = tokens(query);
    if (!q.length) return dishes;
    const scored = dishes
        .map((d) => {
            const n = d.name.toLowerCase();
            const hit = q.filter((t) => n.includes(t) || (t.endsWith("s") && n.includes(t.slice(0, -1)))).length;
            return { d, s: hit / q.length };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s);
    return scored.map((x) => x.d);
}

/**
 * Restaurants near the Kavach address. With a dish/cuisine query, Swiggy's search
 * (Restaurants tab) is used — it marks closed ones. Without one, the home list is read and
 * the top candidates are opened to verify they're actually taking orders now.
 */
export async function listSwiggyRestaurants(input: {
    address: string;
    query?: string;
    limit?: number;
}): Promise<{ location: GuestLocation; restaurants: GuestRestaurant[] }> {
    const address = input.address;
    const limit = input.limit ?? 5;
    return withGuest(async (ctx, page) => {
        const location = await setSwiggyLocation(ctx, page, address);
        if (!location.ok) return { location, restaurants: [] };
        if (input.query) {
            await page.goto(`${BASE}/search?query=${encodeURIComponent(input.query)}`, { waitUntil: "domcontentloaded" });
            await waitForContent(page);
            await page.locator('[data-testid="search-tab-Restaurants"]').first().click({ timeout: 6000 }).catch(() => undefined);
            await page.waitForTimeout(2500);
            const cards = (await page
                .locator('[data-testid="search-pl-restaurant-card"]')
                .evaluateAll((els) =>
                    els.slice(0, 20).map((e) => ({
                        closed: Boolean(e.querySelector('[data-testid="closed-resturant-wrapper"]')),
                        lines: (e as HTMLElement).innerText.split("\n").map((x) => x.trim()).filter(Boolean),
                    })),
                )
                .catch(() => [])) as Array<{ closed: boolean; lines: string[] }>;
            const restaurants = cards
                .map((c): GuestRestaurant | null => {
                    const name = c.lines[0];
                    if (!name) return null;
                    const rl = c.lines.find((l) => /\d\.\d/.test(l) && /•/.test(l)) || "";
                    const eta = rl.match(/(\d+\s*-\s*\d+\s*mins?|\d+\s*mins?)/i)?.[1];
                    const cuisines = c.lines.find((l) => l !== name && l !== rl && /,|[A-Z][a-z]+/.test(l) && !/currently|not taking|₹|for two/i.test(l));
                    return {
                        name,
                        rating: rl.match(/(\d\.\d)/)?.[1],
                        eta,
                        etaMaxMins: parseEtaMax(eta),
                        cuisines,
                        open: !c.closed,
                        closedNote: c.closed ? "not taking orders for this location now" : undefined,
                    };
                })
                .filter((r): r is GuestRestaurant => Boolean(r));
            return { location, restaurants: restaurants.slice(0, 12) };
        }
        await page.goto(`${BASE}/restaurants`, { waitUntil: "domcontentloaded" });
        await waitForContent(page);
        await page.mouse.wheel(0, 1200).catch(() => undefined);
        await page.waitForTimeout(1500);
        const lines = (await page
            .locator('[data-testid="restaurant_list_card"]')
            .evaluateAll((els) => els.slice(0, 20).map((e) => (e as HTMLElement).innerText.split("\n").map((x) => x.trim()).filter(Boolean)))
            .catch(() => [])) as string[][];
        const all = lines.map(parseListCard).filter((r): r is GuestRestaurant => Boolean(r));
        // Verify open status on the menu page for the most plausible ones (ETA ≤ 2h), 3 at a time.
        const candidates = all.filter((r) => (r.etaMaxMins ?? 999) <= 120).slice(0, 6);
        const later = all.filter((r) => !candidates.includes(r));
        for (const r of later) {
            r.open = false;
            r.closedNote = "not delivering now";
        }
        const pages = await Promise.all([0, 1, 2].map(() => ctx.newPage()));
        let idx = 0;
        await Promise.all(
            pages.map(async (pg) => {
                while (idx < candidates.length) {
                    const r = candidates[idx++]!;
                    try {
                        await pg.goto(`${BASE}/restaurants`, { waitUntil: "domcontentloaded" });
                        await waitForContent(pg, 8000);
                        const menu = await openRestaurantAndRead(pg, r.name);
                        if (menu) {
                            r.open = menu.open;
                            r.closedNote = menu.closedNote;
                        }
                    } catch {
                        /* unknown */
                    }
                }
            }),
        );
        const ordered = [...candidates.filter((r) => r.open), ...candidates.filter((r) => !r.open), ...later];
        return { location, restaurants: ordered.slice(0, Math.max(limit, 8)) };
    }, 45_000);
}

/** One restaurant's menu (open status + dishes), optionally filtered by a dish query. */
export async function swiggyRestaurantMenu(input: {
    address: string;
    restaurant: string;
    dishQuery?: string;
}): Promise<{ location: GuestLocation; open: boolean | null; closedNote?: string; dishes: GuestDish[]; url?: string }> {
    const address = input.address;
    return withGuest(async (ctx, page) => {
        const location = await setSwiggyLocation(ctx, page, address);
        if (!location.ok) return { location, open: null, dishes: [] };
        await page.goto(`${BASE}/restaurants`, { waitUntil: "domcontentloaded" });
        await waitForContent(page);
        let menu = await openRestaurantAndRead(page, input.restaurant, input.dishQuery);
        if (!menu) {
            // Not on the first screen of the list → Swiggy search (Restaurants tab) by name.
            await page.goto(`${BASE}/search?query=${encodeURIComponent(input.restaurant)}`, { waitUntil: "domcontentloaded" });
            await waitForContent(page);
            await page.locator('[data-testid="search-tab-Restaurants"]').first().click({ timeout: 6000 }).catch(() => undefined);
            await page.waitForTimeout(2000);
            const card = page.locator('[data-testid="search-pl-restaurant-card"]').filter({ hasText: input.restaurant }).first();
            if (await card.count().catch(() => 0)) {
                await card.click({ timeout: 6000 }).catch(() => undefined);
                await page.waitForURL(/\/city\/|\/restaurants\//, { timeout: 10_000 }).catch(() => undefined);
                await page.waitForTimeout(1800);
                menu = await readMenu(page, input.restaurant, input.dishQuery);
            }
        }
        if (!menu) return { location, open: null, dishes: [] };
        return { location, open: menu.open, closedNote: menu.closedNote, dishes: menu.dishes, url: menu.url };
    }, 40_000);
}

/** Instamart item search at the Kavach address (guest). */
/** Last "no item cards" page snippet (secret-gated debug only; no user data). */
export let lastInstamartDebug = "";

export async function instamartSearch(input: {
    address: string;
    query: string;
}): Promise<{ location: GuestLocation; items: Array<{ name: string; pack?: string; pricePaise?: number; sponsored?: boolean }> }> {
    const address = input.address;
    return withGuest(async (ctx, page) => {
        const location = await setSwiggyLocation(ctx, page, address);
        if (!location.ok) return { location, items: [] };
        await page.goto(`${BASE}/instamart/search?custom_back=true&query=${encodeURIComponent(input.query)}`, {
            waitUntil: "domcontentloaded",
        });
        await waitForContent(page);
        const cardSel = '[data-testid="item-collection-card-full"]';
        let found = await page.waitForSelector(cardSel, { timeout: 12_000 }).then(() => true).catch(() => false);
        if (!found) {
            await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
            found = await page.waitForSelector(cardSel, { timeout: 10_000 }).then(() => true).catch(() => false);
        }
        if (!found) {
            const body = ((await page.locator("body").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 300);
            console.warn("[instamart-guest] no item cards", { url: page.url(), body });
            lastInstamartDebug = `${page.url().slice(0, 80)} | ${body.slice(0, 200)}`;
        }
        await page.waitForTimeout(1500);
        const cards = (await page
            .locator('[data-testid="item-collection-card-full"]')
            .evaluateAll((els) =>
                els.slice(0, 30).map((e) => ({
                    alt: (e.querySelector("img") as HTMLImageElement | null)?.alt || "",
                    lines: ((e.parentElement as HTMLElement | null) || (e as HTMLElement)).innerText.split("\n").map((x) => x.trim()).filter(Boolean),
                })),
            )
            .catch(() => [])) as Array<{ alt: string; lines: string[] }>;
        const items = cards
            .map(({ alt, lines: l }) => {
                const sponsored = l.includes("Ad");
                const clean = l.filter((x) => !/^(Ad|Bestseller|ADD|\d+% OFF|\d+\s*mins?)$/i.test(x));
                const name = alt || clean[0];
                const pack = clean.find((x) => /^\d+(\.\d+)?\s*(ml|l|ltr|g|kg|pcs?|pieces?|units?|pack)\b/i.test(x));
                const prices = clean.filter((x) => /^₹?\s*\d+(\.\d+)?$/.test(x)).map((x) => Number(x.replace(/[^\d.]/g, "")));
                const price = prices.length ? Math.min(...prices) : undefined;
                return name ? { name, pack, pricePaise: price != null ? Math.round(price * 100) : undefined, sponsored } : null;
            })
            .filter((x): x is { name: string; pack: string | undefined; pricePaise: number | undefined; sponsored: boolean } => Boolean(x));
        return { location, items };
    }, 60_000);
}
