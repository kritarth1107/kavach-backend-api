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

/* ── ElevenLabs: characters used this billing period ── */

export type ElevenLabsUsage = { connected: boolean; tier: string | null; used: number | null; limit: number | null; resetsAt: string | null; note?: string };

export async function elevenLabsUsage(): Promise<ElevenLabsUsage> {
    const key = process.env.ELEVENLABS_USAGE_API_KEY || process.env.ELEVENLABS_API_KEY;
    const none = { connected: false, tier: null, used: null, limit: null, resetsAt: null };
    if (!key) return { ...none, note: "Needs an ElevenLabs key with the user_read permission (the voice key can't read usage)" };
    type S = { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number; detail?: { message?: string } };
    const r = await get<S>("https://api.elevenlabs.io/v1/user/subscription", { "xi-api-key": key });
    if (!r.ok || !r.data) return { ...none, note: r.data?.detail?.message?.slice(0, 200) || `ElevenLabs answered ${r.status}` };
    return {
        connected: true, tier: r.data.tier ?? null, used: r.data.character_count ?? null, limit: r.data.character_limit ?? null,
        resetsAt: r.data.next_character_count_reset_unix ? new Date(r.data.next_character_count_reset_unix * 1000).toISOString() : null,
    };
}
