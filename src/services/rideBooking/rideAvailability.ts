/**
 * Live availability for Ola and Rapido: open their public pre-filled route page and read whether it
 * lists rides or says the area isn't served. Cached ~24 h per city+service, one probe at a time per
 * key, hard timeout — the WhatsApp reply never waits long (unknown = treated as maybe).
 */
import type { RidePlace } from "./types";
import { olaLink, rapidoLink, type Availability, type RideService } from "./rideServices";

const TTL_MS = 24 * 3600_000;
const cache = new Map<string, { status: Availability; at: number; fare?: string }>();
const inflight = new Map<string, Promise<Availability>>();

export function cachedAvailability(key: string, s: RideService): Availability {
    const c = cache.get(`${key}:${s}`);
    return c && Date.now() - c.at < TTL_MS ? c.status : "unknown";
}

export function _setAvailabilityForTest(key: string, s: RideService, status: Availability): void {
    cache.set(`${key}:${s}`, { status, at: Date.now() });
}

const UNAVAILABLE = /service unavailable|no services are found|don'?t serve this location|not serviceable|we are not available/i;
const RAPIDO_OK = /₹\s?\d{2,}/;
const OLA_OK = /available rides|prime sedan|prime suv/i;

async function probeOne(
    browser: import("playwright").Browser,
    s: "ola" | "rapido",
    url: string,
    lat: number | undefined,
    lng: number | undefined,
): Promise<Availability> {
    const ctx = await browser.newContext({
        viewport: { width: 412, height: 915 },
        userAgent:
            "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        isMobile: true,
        hasTouch: true,
        locale: "en-IN",
        timezoneId: "Asia/Kolkata",
        ...(lat != null && lng != null ? { geolocation: { latitude: lat, longitude: lng }, permissions: ["geolocation"] } : {}),
    });
    try {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        const until = Date.now() + 16_000;
        let clicked = false;
        while (Date.now() < until) {
            await page.waitForTimeout(1500);
            if (s === "ola" && !clicked) {
                const cow = page.getByText("Continue on web", { exact: false }).first();
                if (await cow.isVisible().catch(() => false)) {
                    await cow.click().catch(() => undefined);
                    clicked = true;
                    continue;
                }
            }
            // Ola renders inside shadow DOM (innerText is empty) — text locators pierce it.
            const seen = async (re: RegExp) => page.getByText(re).first().isVisible().catch(() => false);
            if (await seen(UNAVAILABLE)) return "no";
            if (s === "rapido" && (await seen(RAPIDO_OK))) return "yes";
            if (s === "ola" && (await seen(OLA_OK))) return "yes";
        }
        return "unknown";
    } finally {
        await ctx.close().catch(() => undefined);
    }
}

/** Probe Ola + Rapido for this route (cached per city key). Never throws. */
export function warmRideAvailability(key: string, pickup?: RidePlace, drop?: RidePlace): Promise<void> {
    const todo: Array<"ola" | "rapido"> = (["ola", "rapido"] as const).filter(
        (s) => cachedAvailability(key, s) === "unknown" && !inflight.has(`${key}:${s}`),
    );
    if (!todo.length) return Promise.resolve();
    const run = (async () => {
        let browser: import("playwright").Browser | null = null;
        try {
            const pw = await import("playwright");
            browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] });
            await Promise.all(
                todo.map(async (s) => {
                    const url = s === "ola" ? olaLink(pickup, drop) : rapidoLink(pickup, drop);
                    if (!url) return;
                    const status = await probeOne(browser!, s, url, pickup?.lat, pickup?.lng).catch(() => "unknown" as Availability);
                    console.log(`[ride-avail] ${key} ${s}=${status}`);
                    if (status !== "unknown") cache.set(`${key}:${s}`, { status, at: Date.now() });
                }),
            );
        } catch (err) {
            console.warn("[ride-avail] probe failed:", err instanceof Error ? err.message.slice(0, 160) : err);
        } finally {
            await browser?.close().catch(() => undefined);
        }
    })();
    const done = run.then(() => "unknown" as Availability);
    for (const s of todo) inflight.set(`${key}:${s}`, done);
    void done.finally(() => {
        for (const s of todo) inflight.delete(`${key}:${s}`);
    });
    return run;
}

/** Wait (at most `ms`) for probes already running for this key. */
export async function awaitRideAvailability(key: string, ms: number): Promise<void> {
    const ps = (["ola", "rapido"] as const).map((s) => inflight.get(`${key}:${s}`)).filter(Boolean) as Promise<unknown>[];
    if (!ps.length) return;
    await Promise.race([Promise.all(ps), new Promise((r) => setTimeout(r, ms))]);
}
