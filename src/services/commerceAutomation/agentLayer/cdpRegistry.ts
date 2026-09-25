/**
 * Chromium is launched by Playwright with a local --remote-debugging-port so Stagehand can
 * attach to the SAME browser (same signed-in page). We remember the CDP websocket per Browser.
 */
import type { Browser, Page } from "playwright";

const cdpByBrowser = new WeakMap<Browser, string>();
const portByBrowser = new WeakMap<Browser, number>();

export function stagehandEnabled(): boolean {
    if (process.env.STAGEHAND_ENABLED === "false") return false;
    if (process.env.VERTEX_DISABLED === "1" && process.env.STAGEHAND_FORCE !== "1") return false;
    return true;
}

/** Random local port 9300–9999 for --remote-debugging-port (null when Stagehand is off). */
export function pickDebugPort(): number | null {
    if (!stagehandEnabled()) return null;
    return 9300 + Math.floor(Math.random() * 700);
}

export function debugPortArgs(port: number | null): string[] {
    return port ? [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"] : [];
}

export function registerBrowserDebugPort(browser: Browser, port: number | null): void {
    if (port) portByBrowser.set(browser, port);
}

/** Resolve (and cache) the browser websocket CDP URL for this Playwright Browser. */
export async function cdpUrlForBrowser(browser: Browser | null | undefined): Promise<string | null> {
    if (!browser) return null;
    const cached = cdpByBrowser.get(browser);
    if (cached) return cached;
    const port = portByBrowser.get(browser);
    if (!port) return null;
    try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 3000);
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal });
        clearTimeout(t);
        if (!res.ok) return null;
        const j = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (!j.webSocketDebuggerUrl) return null;
        cdpByBrowser.set(browser, j.webSocketDebuggerUrl);
        return j.webSocketDebuggerUrl;
    } catch {
        return null;
    }
}

export async function cdpUrlForPage(page: Page): Promise<string | null> {
    try {
        return await cdpUrlForBrowser(page.context().browser());
    } catch {
        return null;
    }
}
