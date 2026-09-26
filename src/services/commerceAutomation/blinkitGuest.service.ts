/**
 * Blinkit guest search in our own headless Chromium — no login. The site location is set to
 * THIS care recipient's saved address (passed in; no default) before searching.
 * Verified as guest (2026-09-26): locality search → location cookie → /s/?q= results with
 * name / pack / price. Add-to-cart + checkout need login (browser order flow after confirm).
 */
import type { BrowserContext, Page } from "playwright";
import { cityOf, locationQueryFor } from "./kavachAddress";

const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const BASE = "https://blinkit.com";
type Loc = { cookies: Array<{ name: string; value: string }>; locality: string; at: number };
const locCache = new Map<string, Loc>();
const LOC_TTL_MS = 12 * 60 * 60_000;

export type BlinkitItem = { name: string; pack?: string; pricePaise?: number; sponsored?: boolean };

async function applyLoc(ctx: BrowserContext, loc: Loc) {
    await ctx.addCookies(loc.cookies.map((c) => ({ name: c.name, value: c.value, domain: "blinkit.com", path: "/" })));
}

async function setBlinkitLocation(ctx: BrowserContext, page: Page, address: string): Promise<{ ok: boolean; locality: string }> {
    const cached = locCache.get(address);
    if (cached && Date.now() - cached.at < LOC_TTL_MS) {
        await applyLoc(ctx, cached);
        return { ok: true, locality: cached.locality };
    }
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const input = page.locator('input[name="select-locality"], input[placeholder*="delivery location" i]').first();
    // Some hosts don't get the auto-opened location modal: open it from the header.
    if (!(await input.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false))) {
        await page
            .locator("header, [class*='LocationBar'], [class*='location' i]")
            .getByText(/delivery in|select location|detect my location|location/i)
            .first()
            .click({ timeout: 4000 })
            .catch(() => undefined);
    }
    if (!(await input.waitFor({ state: "visible", timeout: 20_000 }).then(() => true).catch(() => false))) {
        const snip = ((await page.evaluate(() => `${document.title} | ${document.body?.innerText || ""}`).catch(() => "")) as string)
            .replace(/\s+/g, " ")
            .slice(0, 160);
        throw new Error(`blinkit_no_location_box (${snip})`);
    }
    await input.fill(locationQueryFor(address));
    await page.waitForTimeout(2800);
    const city = (cityOf(address) || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Suggestions read "<Place>" + "<area>, <City>, <State>, India" — pick one in the right city.
    const pick = city ? page.getByText(new RegExp(`\\b${city}\\b.*\\bIndia\\b|\\b${city}\\s*,`, "i")).first() : page.getByText(/, India$/).first();
    await pick.waitFor({ state: "visible", timeout: 12_000 });
    await pick.click({ timeout: 6000 });
    await page.waitForTimeout(3000);
    // The location cookies can land a moment after the click (slower on the remote Chrome), and
    // gr_1_landmark may briefly read "undefined": re-read once before judging the city.
    const read = async () => {
        const all = await ctx.cookies(BASE);
        const val = (n: string) => {
            const v = decodeURIComponent(all.find((c) => c.name === n)?.value || "");
            return /^(undefined|null)$/i.test(v) ? "" : v;
        };
        return { all, lat: val("gr_1_lat"), lon: val("gr_1_lon"), locality: [val("gr_1_landmark"), val("gr_1_locality")].filter(Boolean).join(", ") };
    };
    let c = await read();
    const cityOk = (l: string) => !city || new RegExp(city, "i").test(l);
    if (!c.lat || !c.lon || !cityOk(c.locality)) {
        await page.waitForTimeout(3000);
        c = await read();
    }
    const { all, locality } = c;
    if (!c.lat || !c.lon) return { ok: false, locality: "" };
    const keep = all.filter((x) => /^gr_1_(lat|lon|locality|landmark|city)|^city$/.test(x.name));
    const inCity = cityOk(locality);
    if (!inCity) return { ok: false, locality };
    locCache.set(address, { cookies: keep.map((c) => ({ name: c.name, value: c.value })), locality, at: Date.now() });
    return { ok: true, locality };
}

/** Parse Blinkit's search page text: blocks end at "ADD"; name, pack, ₹price inside. */
export function parseBlinkitResults(text: string): BlinkitItem[] {
    const start = text.search(/Showing results for/i);
    const body = start >= 0 ? text.slice(start).split("\n").slice(1) : text.split("\n");
    const items: BlinkitItem[] = [];
    let block: string[] = [];
    for (const raw of body) {
        const l = raw.trim();
        if (!l) continue;
        if (/^ADD$/i.test(l)) {
            const clean = block.filter((x) => !/^(\d+%\s*OFF|\d+\s*MINS?|Ad|Sponsored|Bestseller|Out of stock)$/i.test(x));
            const sponsored = block.some((x) => /^(Ad|Sponsored)$/i.test(x));
            const priceIdx = clean.findIndex((x) => /^₹\s*\d/.test(x));
            const name = clean[0];
            const pack = clean.slice(1, priceIdx > 0 ? priceIdx : undefined).find((x) => /\d/.test(x) && !/^₹/.test(x));
            const price = priceIdx >= 0 ? Number(clean[priceIdx]!.replace(/[^\d.]/g, "")) : undefined;
            if (name && !/^₹/.test(name)) items.push({ name, pack, pricePaise: price != null && Number.isFinite(price) ? Math.round(price * 100) : undefined, sponsored });
            block = [];
            continue;
        }
        block.push(l);
        if (block.length > 12) block = block.slice(-12);
    }
    return items.slice(0, 30);
}

export async function blinkitSearch(input: { address: string; query: string }): Promise<{ location: { ok: boolean; locality: string }; items: BlinkitItem[] }> {
    const pw = await import("playwright");
    const { launchBrowserFor, remoteInfo, remoteBudgetMs } = await import("./remoteBrowser");
    // Guest browsing: remote India-proxy Chrome when enabled (no family profile, no login state).
    const browser = await launchBrowserFor(pw, {
        partner: "blinkit",
        minutes: 5,
        launch: { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"] },
    });
    const remote = remoteInfo(browser).remote;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const ctx = await browser.newContext(remote ? { viewport: { width: 1280, height: 900 }, locale: "en-IN" } : { userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-IN" });
        await ctx.addInitScript(() => {
            Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        });
        const page = await ctx.newPage();
        page.setDefaultTimeout(12_000);
        const work = (async () => {
            const location = await setBlinkitLocation(ctx, page, input.address);
            if (!location.ok) return { location, items: [] };
            await page.goto(`${BASE}/s/?q=${encodeURIComponent(input.query)}`, { waitUntil: "domcontentloaded" });
            let items: BlinkitItem[] = [];
            for (let i = 0; i < 8 && !items.length; i++) {
                await page.waitForTimeout(1500);
                items = parseBlinkitResults((await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string);
            }
            return { location, items };
        })();
        return await Promise.race([
            work,
            new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new Error("blinkit_guest_timeout")), remoteBudgetMs("blinkit", 50_000));
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        await browser.close().catch(() => undefined);
    }
}
