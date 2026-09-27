/**
 * Live availability for Ola and Rapido: open their public pre-filled route page and read whether it
 * lists rides or says the area isn't served.
 *  - Persisted per city key + service in Mongo (`ride_availability`, TTL) so it survives deploys.
 *  - Rate-limited: at most one probe run at a time, a per-hour budget, and a short negative
 *    cache on failures so a flaky site is not hammered.
 *  - Never throws and never blocks the reply for long: unknown = fall back to the static chain.
 */
import type { RidePlace } from "./types";
import { olaLink, rapidoLink, type Availability, type RideConfig } from "./rideServices";

type Probed = "ola" | "rapido";
const FAIL_BACKOFF_MS = 20 * 60_000;
const mem = new Map<string, { status: Availability; exp: number }>();
const inflight = new Map<string, Promise<void>>();
let running = 0;
const MAX_CONCURRENT_RUNS = 1;
const probeTimes: number[] = [];

function log(evt: string, data: Record<string, unknown>): void {
    console.log(JSON.stringify({ evt, ...data }));
}

async function model() {
    return (await import("../../models/rideAvailability.model")).default;
}

/** Status per service for this key (memory first, then Mongo). "unknown" when unchecked/expired. */
export async function readAvailability(key: string): Promise<Record<Probed, Availability>> {
    const out: Record<Probed, Availability> = { ola: "unknown", rapido: "unknown" };
    const now = Date.now();
    const missing: Probed[] = [];
    for (const s of ["ola", "rapido"] as const) {
        const m = mem.get(`${key}:${s}`);
        if (m && m.exp > now) out[s] = m.status;
        else missing.push(s);
    }
    if (!missing.length) return out;
    try {
        const M = await model();
        const rows = (await Promise.race([
            M.find({ key, service: { $in: missing }, expiresAt: { $gt: new Date() } }).lean(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error("availability read timeout")), 1500)),
        ])) as Array<{ service: Probed; status: Availability; expiresAt: Date }>;
        for (const r of rows) {
            out[r.service] = r.status;
            mem.set(`${key}:${r.service}`, { status: r.status, exp: new Date(r.expiresAt).getTime() });
        }
    } catch (err) {
        log("ride_avail_read_failed", { key, error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
    return out;
}

async function write(key: string, s: Probed, status: Availability, ttlMs: number, detail?: string): Promise<void> {
    const exp = Date.now() + ttlMs;
    mem.set(`${key}:${s}`, { status, exp });
    if (mem.size > 5000) mem.delete(mem.keys().next().value as string);
    try {
        const M = await model();
        await M.updateOne(
            { key, service: s },
            { $set: { status, checkedAt: new Date(), expiresAt: new Date(exp), detail: detail?.slice(0, 120) } },
            { upsert: true },
        );
    } catch (err) {
        log("ride_avail_write_failed", { key, service: s, error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
}

function underBudget(cfg: RideConfig): boolean {
    const hourAgo = Date.now() - 3600_000;
    while (probeTimes.length && probeTimes[0]! < hourAgo) probeTimes.shift();
    return probeTimes.length < cfg.maxProbesPerHour;
}

const UNAVAILABLE = /service unavailable|no services are found|don'?t serve this location|not serviceable|we are not available/i;
const RAPIDO_OK = /₹\s?\d{2,}/;
const OLA_OK = /available rides|prime sedan|prime suv/i;

export async function probeRideUrl(
    browser: import("playwright").Browser,
    s: Probed,
    url: string,
    p: RidePlace | undefined,
    timeoutMs: number,
): Promise<Availability> {
    const ctx = await browser.newContext({
        viewport: { width: 412, height: 915 },
        userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        isMobile: true,
        hasTouch: true,
        locale: "en-IN",
        timezoneId: "Asia/Kolkata",
        ...(p?.lat != null && p?.lng != null ? { geolocation: { latitude: p.lat, longitude: p.lng }, permissions: ["geolocation"] } : {}),
    });
    try {
        const page = await ctx.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        const until = Date.now() + timeoutMs;
        let clicked = false;
        // Ola renders inside shadow DOM (innerText is empty) — text locators pierce it.
        const seen = (re: RegExp) => page.getByText(re).first().isVisible().catch(() => false);
        while (Date.now() < until) {
            await page.waitForTimeout(1200);
            if (s === "ola" && !clicked) {
                const cow = page.getByText("Continue on web", { exact: false }).first();
                if (await cow.isVisible().catch(() => false)) {
                    await cow.click({ timeout: 3000 }).catch(() => undefined);
                    clicked = true;
                    continue;
                }
            }
            if (await seen(UNAVAILABLE)) return "no";
            if (s === "rapido" && (await seen(RAPIDO_OK))) return "yes";
            if (s === "ola" && (await seen(OLA_OK))) return "yes";
        }
        return "unknown";
    } finally {
        await ctx.close().catch(() => undefined);
    }
}

/** Check Ola + Rapido for this route in the background (skips anything cached or in flight). */
export async function warmRideAvailability(key: string, cfg: RideConfig, pickup?: RidePlace, drop?: RidePlace): Promise<void> {
    try {
        const known = await readAvailability(key);
        const todo = (["ola", "rapido"] as const).filter(
            (s) => known[s] === "unknown" && !inflight.has(`${key}:${s}`) && !cfg.disabled.includes(s),
        );
        if (!todo.length) return;
        if (running >= MAX_CONCURRENT_RUNS || !underBudget(cfg)) {
            log("ride_probe_skipped", { key, reason: running >= MAX_CONCURRENT_RUNS ? "busy" : "hourly_budget" });
            return;
        }
        const run = (async () => {
            running++;
            probeTimes.push(Date.now());
            const started = Date.now();
            let browser: import("playwright").Browser | null = null;
            try {
                const pw = await import("playwright");
                browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], timeout: 15_000 });
                await Promise.all(
                    todo.map(async (s) => {
                        const url = s === "ola" ? olaLink(pickup, drop) : rapidoLink(pickup, drop);
                        if (!url) return;
                        let status: Availability = "unknown";
                        let detail = "";
                        try {
                            status = await probeRideUrl(browser!, s, url, pickup, cfg.probeTimeoutMs);
                        } catch (err) {
                            detail = err instanceof Error ? err.message.slice(0, 120) : String(err);
                        }
                        // Real answers keep for the configured TTL; failures back off briefly.
                        await write(key, s, status, status === "unknown" ? FAIL_BACKOFF_MS : cfg.probeTtlHours * 3600_000, detail);
                        log("ride_probe", { key, service: s, status, ms: Date.now() - started, ...(detail ? { error: detail } : {}) });
                    }),
                );
            } catch (err) {
                log("ride_probe_failed", { key, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
                for (const s of todo) await write(key, s, "unknown", FAIL_BACKOFF_MS, "launch failed");
            } finally {
                await browser?.close().catch(() => undefined);
                running--;
            }
        })();
        for (const s of todo) inflight.set(`${key}:${s}`, run);
        void run.finally(() => {
            for (const s of todo) inflight.delete(`${key}:${s}`);
        });
        await run;
    } catch (err) {
        log("ride_probe_failed", { key, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
    }
}

/** Wait (at most `ms`) for probes already running for this key. */
export async function awaitRideAvailability(key: string, ms: number): Promise<void> {
    const ps = (["ola", "rapido"] as const).map((s) => inflight.get(`${key}:${s}`)).filter(Boolean) as Promise<void>[];
    if (!ps.length) return;
    await Promise.race([Promise.all(ps).catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}
