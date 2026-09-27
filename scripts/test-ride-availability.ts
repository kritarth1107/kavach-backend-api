/**
 * Integration: availability probe + cache degrade safely.
 *  - Probe reads a served page (fares) vs an unserved one ("Service unavailable") vs a hung page.
 *  - With no database, reads return "unknown" fast (never block the reply).
 *  - Hourly budget 0 → no probe runs at all.
 * The browser part is skipped (not failed) where Chromium isn't installed.
 */
import http from "http";
import { mergeRideConfig } from "../src/services/rideBooking/rideServices";
import { readAvailability, warmRideAvailability, probeRideUrl } from "../src/services/rideBooking/rideAvailability";

let fail = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : ` → ${JSON.stringify(got)}`}`); if (!c) fail++; };

async function main() {
    const t0 = Date.now();
    const r = await readAvailability("test-city");
    ok("no DB: read returns unknown", r.ola === "unknown" && r.rapido === "unknown", r);
    ok("no DB: read is fast (<2.5s)", Date.now() - t0 < 2500, Date.now() - t0);

    const t1 = Date.now();
    await warmRideAvailability("test-city", mergeRideConfig({ maxProbesPerHour: 0 }), { lat: 1, lng: 1 }, { lat: 2, lng: 2 });
    ok("budget 0: no probe, returns fast", Date.now() - t1 < 2500, Date.now() - t1);

    const pages: Record<string, string> = {
        "/fares": "<html><body><h2>Choose a ride</h2><div>Bike ₹48</div><div>Auto ₹92</div></body></html>",
        "/none": "<html><body><p>Service unavailable at this location</p></body></html>",
        "/blank": "<html><body><p>Loading…</p></body></html>",
    };
    const srv = http.createServer((q, s) => { s.setHeader("content-type", "text/html; charset=utf-8"); s.end(pages[q.url || ""] || "404"); });
    await new Promise<void>((res) => srv.listen(0, "127.0.0.1", res));
    const port = (srv.address() as { port: number }).port;
    let browser: import("playwright").Browser | null = null;
    try {
        const pw = await import("playwright");
        browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox"] });
    } catch {
        console.log("- Chromium not installed here: browser probe checks skipped");
    }
    if (browser) {
        const u = (p: string) => `http://127.0.0.1:${port}${p}`;
        ok("probe: fares page → yes", (await probeRideUrl(browser, "rapido", u("/fares"), undefined, 5000)) === "yes");
        ok("probe: unserved page → no", (await probeRideUrl(browser, "ola", u("/none"), undefined, 5000)) === "no");
        const t2 = Date.now();
        ok("probe: silent page → unknown", (await probeRideUrl(browser, "rapido", u("/blank"), undefined, 4000)) === "unknown");
        ok("probe: respects its timeout", Date.now() - t2 < 8000, Date.now() - t2);
        await browser.close();
    }
    srv.close();
    console.log(fail ? `\n${fail} failed` : "\nall passed");
    process.exit(fail ? 1 : 0);
}
void main();
