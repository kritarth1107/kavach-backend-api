/**
 * Remote Chrome for sites that block our Cloud Run (datacenter IP) headless Chromium.
 *
 * BROWSER_REMOTE=browseruse + BROWSER_USE_API_KEY → a Browser Use Cloud Chrome with an India
 * residential proxy, driven over CDP by the SAME Playwright code (all guardrails unchanged:
 * the remote browser is just where the page renders). Trial 2026-09-26: Blinkit, the Instamart
 * website, the Swiggy website and Zomato load and set a Raipur location there, while our
 * headless Chromium gets blocked / blank pages.
 *
 * - Only partners in BROWSER_REMOTE_SITES (default below) go remote; everything else and any
 *   remote failure → the local headless Chromium, exactly as before.
 * - Login sessions: one Browser Use profile per (familyId, partner), created lazily and only
 *   attached for that family + store (see models/browserUseProfile.model.ts).
 * - Billing safety: every remote session has a hard server-side timeout (minutes), and
 *   browser.close() is wrapped to also STOP the cloud session (callers already close in finally).
 */
import type { Browser, LaunchOptions } from "playwright";

const API = "https://api.browser-use.com/api/v2";
const DEFAULT_SITES = "blinkit,instamart,swiggy,zomato,zepto";

export type RemoteBrowserInfo = { remote: boolean; sessionId?: string; profileId?: string; reason?: string };
const infoByBrowser = new WeakMap<Browser, RemoteBrowserInfo>();

function apiKey(): string {
    return (process.env.BROWSER_USE_API_KEY || "").trim();
}

export function remoteSites(): Set<string> {
    const raw = (process.env.BROWSER_REMOTE_SITES || DEFAULT_SITES).toLowerCase();
    return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

/** True when this partner's pages should render on the remote (India-proxy) Chrome. */
export function useRemoteBrowserFor(partner: string | null | undefined): boolean {
    if ((process.env.BROWSER_REMOTE || "").trim().toLowerCase() !== "browseruse") return false;
    if (!apiKey()) return false;
    return Boolean(partner) && remoteSites().has(String(partner).toLowerCase());
}

export function remoteInfo(browser: Browser | null | undefined): RemoteBrowserInfo {
    return (browser && infoByBrowser.get(browser)) || { remote: false };
}

async function bu<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${API}${path}`, {
            method,
            headers: { "X-Browser-Use-API-Key": apiKey(), "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: ctl.signal,
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`browseruse ${method} ${path.split("/")[1]} ${r.status}: ${text.slice(0, 160)}`);
        return (text ? JSON.parse(text) : {}) as T;
    } finally {
        clearTimeout(t);
    }
}

/** Family + store scoped Browser Use profile (login cookies). Created once, reused. */
export async function profileFor(familyId: string, partner: string): Promise<string | undefined> {
    if (!familyId || !partner) return undefined;
    const { default: BrowserUseProfile } = await import("../../models/browserUseProfile.model");
    const key = { familyId: String(familyId), partner: String(partner).toLowerCase() };
    const row = await BrowserUseProfile.findOne(key).lean();
    if (row?.profileId) {
        void BrowserUseProfile.updateOne(key, { $set: { lastUsedAt: new Date() } }).catch(() => undefined);
        return row.profileId;
    }
    const created = await bu<{ id: string }>("POST", "/profiles", { name: `kavach ${key.partner}`.slice(0, 100), userId: `family:${key.familyId}` });
    try {
        await BrowserUseProfile.create({ ...key, profileId: created.id, lastUsedAt: new Date() });
        return created.id;
    } catch {
        // Lost a race with a parallel request: use the stored one, drop ours.
        const again = await BrowserUseProfile.findOne(key).lean();
        void bu("DELETE", `/profiles/${created.id}`).catch(() => undefined);
        return again?.profileId;
    }
}

export async function stopRemoteSession(sessionId: string): Promise<void> {
    await bu("PATCH", `/browsers/${sessionId}`, { action: "stop" }, 10_000).catch((err) =>
        console.warn("[remote-browser] stop failed:", err instanceof Error ? err.message : err),
    );
}

/**
 * Chromium for `partner`: the remote India-proxy Chrome when enabled for it, else a local launch.
 * `familyId` attaches that family's profile for this store (login sessions); omit it for guest
 * browsing so no login state is involved at all.
 */
export async function launchBrowserFor(
    pw: typeof import("playwright"),
    opts: { partner: string | null | undefined; familyId?: string | null; launch: LaunchOptions; minutes?: number },
): Promise<Browser> {
    if (useRemoteBrowserFor(opts.partner)) {
        let sessionId: string | undefined;
        try {
            const profileId = opts.familyId ? await profileFor(String(opts.familyId), String(opts.partner)).catch(() => undefined) : undefined;
            const minutes = Math.max(1, Math.min(Number(process.env.BROWSER_REMOTE_MINUTES) || opts.minutes || 25, 60));
            const s = await bu<{ id: string; cdpUrl?: string }>("POST", "/browsers", {
                proxyCountryCode: "in",
                timeout: minutes,
                ...(profileId ? { profileId } : {}),
                metadata: { app: "kavach", partner: String(opts.partner) },
            });
            sessionId = s.id;
            if (!s.cdpUrl) throw new Error("browseruse: no cdpUrl");
            const browser = await pw.chromium.connectOverCDP(s.cdpUrl, { timeout: 45_000 });
            const sid = s.id;
            let stopped = false;
            const stop = async () => {
                if (stopped) return;
                stopped = true;
                await stopRemoteSession(sid);
            };
            const close = browser.close.bind(browser);
            browser.close = async (o?: { reason?: string }) => {
                try {
                    await close(o);
                } finally {
                    await stop();
                }
            };
            browser.on("disconnected", () => void stop());
            infoByBrowser.set(browser, { remote: true, sessionId: sid, profileId });
            const { registerBrowserCdpUrl } = await import("./agentLayer/cdpRegistry");
            registerBrowserCdpUrl(browser, s.cdpUrl);
            console.info(`[remote-browser] ${opts.partner} session ${sid}${profileId ? " (family profile)" : " (guest)"}`);
            return browser;
        } catch (err) {
            if (sessionId) await stopRemoteSession(sessionId);
            console.warn(`[remote-browser] ${opts.partner} remote failed, using local Chromium:`, err instanceof Error ? err.message : err);
        }
    }
    const browser = await pw.chromium.launch(opts.launch);
    infoByBrowser.set(browser, { remote: false });
    return browser;
}

/** Extra time budget for guest work on the remote Chrome (session start + proxy latency). */
export function remoteBudgetMs(partner: string, localMs: number): number {
    return useRemoteBrowserFor(partner) ? localMs + (Number(process.env.BROWSER_REMOTE_EXTRA_MS) || 45_000) : localMs;
}
