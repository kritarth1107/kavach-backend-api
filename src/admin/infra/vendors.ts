/**
 * Services outside the clouds: WhatsApp (Meta), Browser Use, ElevenLabs. Read-only calls with the keys the family
 * backend already uses; only billing and balance endpoints are called.
 */
import { USD_INR, istDay } from "./pricing";

const get = async <T>(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; data: T | null }> => {
    try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
        return { ok: res.ok, status: res.status, data: (await res.json().catch(() => null)) as T | null };
    } catch {
        return { ok: false, status: 0, data: null };
    }
};

/* ── WhatsApp (Meta Cloud API): the real per-day cost from pricing analytics ── */

export type WhatsAppBill = { connected: boolean; currency: string; daily: Record<string, number>; volume: Record<string, number>; byCategory: Record<string, { volume: number; cost: number }>; note?: string };

export async function whatsappBill(days: number, now = Date.now()): Promise<WhatsAppBill> {
    const token = process.env.WHATSAPP_META_ACCESS_TOKEN, waba = process.env.WHATSAPP_META_WABA_ID;
    const v = process.env.WHATSAPP_META_GRAPH_VERSION || "v22.0";
    if (!token || !waba) return { connected: false, currency: "INR", daily: {}, volume: {}, byCategory: {}, note: "WhatsApp token not given to the admin API" };
    const end = Math.floor(now / 1000), start = end - days * 86_400;
    const fields = `currency,pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
    type P = { currency?: string; pricing_analytics?: { data?: Array<{ data_points?: Array<{ start: number; pricing_category?: string; pricing_type?: string; volume?: number; cost?: number }> }> }; error?: { message?: string } };
    const r = await get<P>(`https://graph.facebook.com/${v}/${waba}?fields=${encodeURIComponent(fields)}`, { Authorization: `Bearer ${token}` });
    if (!r.ok || !r.data) return { connected: false, currency: "INR", daily: {}, volume: {}, byCategory: {}, note: r.data?.error?.message?.slice(0, 200) || `Meta answered ${r.status}` };
    const out: WhatsAppBill = { connected: true, currency: r.data.currency || "INR", daily: {}, volume: {}, byCategory: {} };
    const rate = out.currency === "USD" ? USD_INR : 1;
    for (const block of r.data.pricing_analytics?.data || []) {
        for (const p of block.data_points || []) {
            const day = istDay(p.start * 1000 + 3_600_000);
            const cost = (p.cost || 0) * rate;
            out.daily[day] = (out.daily[day] ?? 0) + cost;
            out.volume[day] = (out.volume[day] ?? 0) + (p.volume || 0);
            const cat = `${(p.pricing_category || "other").toLowerCase()}${p.pricing_type === "FREE_CUSTOMER_SERVICE" ? " (free)" : ""}`;
            const c = (out.byCategory[cat] ??= { volume: 0, cost: 0 });
            c.volume += p.volume || 0;
            c.cost += cost;
        }
    }
    return out;
}

/* ── Browser Use: credit balance (spend is tracked from the balance day by day) ── */

export type BrowserUseAccount = { connected: boolean; balanceUsd: number | null; freeTier: boolean | null; activeSessions: number | null; concurrentLimit: number | null; note?: string };

export async function browserUseAccount(): Promise<BrowserUseAccount> {
    const key = process.env.BROWSER_USE_API_KEY;
    if (!key) return { connected: false, balanceUsd: null, freeTier: null, activeSessions: null, concurrentLimit: null, note: "Browser Use key not given to the admin API" };
    type A = { totalCreditsBalanceUsd?: number; isFreeTier?: boolean; activeSessionCount?: number; concurrentSessionLimit?: number };
    const r = await get<A>("https://api.browser-use.com/api/v2/billing/account", { "X-Browser-Use-API-Key": key });
    if (!r.ok || !r.data) return { connected: false, balanceUsd: null, freeTier: null, activeSessions: null, concurrentLimit: null, note: `Browser Use answered ${r.status}` };
    return {
        connected: true, balanceUsd: r.data.totalCreditsBalanceUsd ?? null, freeTier: r.data.isFreeTier ?? null,
        activeSessions: r.data.activeSessionCount ?? null, concurrentLimit: r.data.concurrentSessionLimit ?? null,
    };
}

/**
 * Browser Use spend since the account began, from its own run records: every agent task carries its cost and every
 * browser session its proxy cost (USD). Per IST day, with run counts and success. No task text leaves this function.
 */
export type BrowserUseHistory = { connected: boolean; note?: string; tasks: number; sessions: number; firstAt: string | null;
    daily: Record<string, { taskUsd: number; proxyUsd: number; tasks: number; failed: number; sessions: number; proxyMb: number }> };

export async function browserUseHistory(maxPages = 40): Promise<BrowserUseHistory> {
    const key = process.env.BROWSER_USE_API_KEY;
    if (!key) return { connected: false, note: "Browser Use key not given to the admin API", tasks: 0, sessions: 0, firstAt: null, daily: {} };
    const h = { "X-Browser-Use-API-Key": key };
    const daily: BrowserUseHistory["daily"] = {};
    const day = (iso?: string | null) => (iso ? istDay(new Date(iso)) : "");
    const slot = (d: string) => (daily[d] ??= { taskUsd: 0, proxyUsd: 0, tasks: 0, failed: 0, sessions: 0, proxyMb: 0 });
    let tasks = 0, sessions = 0, first: string | null = null;
    type T = { items?: Array<{ cost?: string | number | null; createdAt?: string; startedAt?: string; status?: string; isSuccess?: boolean | null }>; totalItems?: number };
    type S = { items?: Array<{ proxyCost?: string | number | null; proxyUsedMb?: string | number | null; startedAt?: string }>; totalItems?: number };
    for (let page = 1; page <= maxPages; page++) {
        const r = await get<T>(`https://api.browser-use.com/api/v2/tasks?pageSize=100&pageNumber=${page}`, h);
        if (!r.ok || !r.data) { if (page === 1) return { connected: false, note: `Browser Use answered ${r.status}`, tasks: 0, sessions: 0, firstAt: null, daily: {} }; break; }
        for (const t of r.data.items || []) {
            const at = t.createdAt || t.startedAt || null;
            const d = day(at);
            if (!d) continue;
            if (!first || at! < first) first = at;
            const x = slot(d);
            x.taskUsd += Number(t.cost || 0); x.tasks++; tasks++;
            if (t.isSuccess === false || t.status === "failed") x.failed++;
        }
        if ((r.data.items || []).length < 100) break;
    }
    for (let page = 1; page <= maxPages; page++) {
        const r = await get<S>(`https://api.browser-use.com/api/v2/sessions?pageSize=100&pageNumber=${page}`, h);
        if (!r.ok || !r.data) break;
        for (const s of r.data.items || []) {
            const d = day(s.startedAt);
            if (!d) continue;
            if (!first || s.startedAt! < first) first = s.startedAt!;
            const x = slot(d);
            x.proxyUsd += Number(s.proxyCost || 0); x.proxyMb += Number(s.proxyUsedMb || 0); x.sessions++; sessions++;
        }
        if ((r.data.items || []).length < 100) break;
    }
    return { connected: true, tasks, sessions, firstAt: first, daily };
}

/* ── ElevenLabs: characters used this billing period ── */

export type ElevenLabsUsage = {
    connected: boolean; tier: string | null; used: number | null; limit: number | null; resetsAt: string | null; note?: string;
    /** Credits per product over the last 30 days (the usage log; readable with the voice key, no user_read needed). */
    products?: Array<{ product: string; last30: number; last7: number; today: number; kavach: boolean }>;
    daily?: Record<string, Record<string, number>>; // IST day -> product -> credits
    /** Credits per IST day by where the request came from: "API" (Kavach's backend uses the API) or "Website". */
    bySource?: Record<string, Record<string, number>>;
    models?: Array<{ model: string; last30: number }>;
};

// The products Kavach itself uses: Scribe for voice notes, text-to-speech for spoken replies (TTS_ORDER=elevenlabs).
// Music, video, images, sound effects and agents on the same account are not Kavach.
const KAVACH_PRODUCTS = new Set(["STT", "TTS"]);

export async function elevenLabsUsage(now = Date.now()): Promise<ElevenLabsUsage> {
    const key = process.env.ELEVENLABS_USAGE_API_KEY || process.env.ELEVENLABS_API_KEY;
    const none = { connected: false, tier: null, used: null, limit: null, resetsAt: null };
    if (!key) return { ...none, note: "The admin API has no ElevenLabs key" };
    type S = { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
    type U = { time?: number[]; usage?: Record<string, number[]> };
    const [sub, use] = await Promise.all([
        get<S>("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key }),
        get<U>(`https://api.elevenlabs.io/v1/usage/character-stats?start_unix=${now - 30 * 86_400_000}&end_unix=${now}&breakdown_type=product_type`, { "xi-api-key": key }),
    ]);
    const plan = sub.ok && sub.data ? {
        tier: sub.data.tier ?? null, used: sub.data.character_count ?? null, limit: sub.data.character_limit ?? null,
        resetsAt: sub.data.next_character_count_reset_unix ? new Date(sub.data.next_character_count_reset_unix * 1000).toISOString() : null,
    } : { tier: null, used: null, limit: null, resetsAt: null };
    if (!use.ok || !use.data?.time) {
        return sub.ok ? { connected: true, ...plan } : { ...none, note: `ElevenLabs answered ${use.status} (the key needs usage or user_read)` };
    }
    const days = use.data.time.map((t) => istDay(new Date(t)));
    const daily: Record<string, Record<string, number>> = {};
    const today = istDay(new Date(now));
    const products = Object.entries(use.data.usage || {}).map(([product, vals]) => {
        let last30 = 0, last7 = 0, todayN = 0;
        vals.forEach((v, i) => {
            if (!v) return;
            (daily[days[i]] ??= {})[product] = v;
            last30 += v;
            if (now - (use.data!.time![i] ?? 0) <= 7 * 86_400_000) last7 += v;
            if (days[i] === today) todayN += v;
        });
        return { product, last30, last7, today: todayN, kavach: KAVACH_PRODUCTS.has(product) };
    }).filter((p) => p.last30 > 0).sort((a, b) => Number(b.kavach) - Number(a.kavach) || b.last30 - a.last30);
    // where the credits were spent from (API vs the website) and on which models: 60 days
    const range = `start_unix=${now - 60 * 86_400_000}&end_unix=${now}`;
    const [src, mdl] = await Promise.all([
        get<U>(`https://api.elevenlabs.io/v1/usage/character-stats?${range}&breakdown_type=request_source`, { "xi-api-key": key }),
        get<U>(`https://api.elevenlabs.io/v1/usage/character-stats?start_unix=${now - 30 * 86_400_000}&end_unix=${now}&breakdown_type=model`, { "xi-api-key": key }),
    ]);
    const bySource: Record<string, Record<string, number>> = {};
    if (src.ok && src.data?.time) {
        const sd = src.data.time.map((t) => istDay(new Date(t)));
        for (const [source, vals] of Object.entries(src.data.usage || {})) vals.forEach((v, i) => { if (v) (bySource[source] ??= {})[sd[i]] = ((bySource[source] ?? {})[sd[i]] ?? 0) + v; });
    }
    const models = mdl.ok && mdl.data?.usage ? Object.entries(mdl.data.usage).map(([model, vals]) => ({ model, last30: vals.reduce((a, b) => a + (b || 0), 0) }))
        .filter((m) => m.last30 > 0).sort((a, b) => b.last30 - a.last30) : [];
    return { connected: true, ...plan, products, daily, bySource, models, note: sub.ok ? undefined : "Plan and limit need a key with user_read; usage is read from the usage log" };
}
