/**
 * AI models: which model does what (each role's primary and fallbacks), how much each was used, today's spend and
 * a month forecast. Numbers come from the engine's ledger (every model call it makes is priced and counted); models
 * used outside the engine are listed with where their cost shows up.
 */
import { engineOrNull } from "../engine";
import { runServices } from "./gcp";
import { lastDays, round2, totals, type Totals } from "./pricing";

type Route = { provider: string; model: string; location: string; priceInr: [number, number] };
type EngineModels = { llm: string; embeddings: string; roles: Record<string, { configured: boolean; routes: Route[] }>; today: number; softCap: number; hardCap: number; usdInr: number };
type EngineSpend = { today: number; softCap: number; hardCap: number; rows: Array<{ day: string; role: string; model: string; calls: number; tokensIn: number; tokensOut: number; costInr: number }> };

export type ModelRow = {
    model: string; provider: string; roles: string[]; primaryFor: string[]; priceInr: [number, number] | null;
    today: { calls: number; tokensIn: number; tokensOut: number; costInr: number };
    last30: { calls: number; tokensIn: number; tokensOut: number; costInr: number };
    totals: Totals; share: number; daily: Record<string, number>;
};
export type OtherModel = { model: string; provider: string; use: string; billedUnder: string };
export type ModelsView = {
    at: string; engine: string | null; llm: string | null; embeddings: string | null;
    caps: { today: number; soft: number; hard: number } | null; totals: Totals; daily: Array<{ day: string; inr: number }>;
    models: ModelRow[]; roles: Array<{ role: string; configured: boolean; routes: Route[] }>; other: OtherModel[];
    byRole: Array<{ role: string; calls: number; costInr: number }>;
};

const ROLE_LABEL: Record<string, string> = {
    brain: "Saheli's replies", brain_hard: "Hard moments", worker: "Background work", extract: "Facts from chats", classify: "Sorting messages",
    judge: "Quality checks", judge_fast: "Quick checks", learn: "Weekly learning", vision: "Photos & prescriptions", caregiver: "Caregiver chat",
};
export const roleLabel = (r: string) => ROLE_LABEL[r] || r.replace(/_/g, " ");

export async function buildModels(now = Date.now()): Promise<ModelsView> {
    const days = lastDays(30, now);
    const today = days[days.length - 1];
    const [cfg, spend, run] = await Promise.all([
        engineOrNull<EngineModels>("GET", "/models"),
        engineOrNull<EngineSpend>("GET", "/spend?days=40"),
        runServices().catch(() => null),
    ]);

    const by = new Map<string, ModelRow>();
    const routes = cfg.data?.roles || {};
    const row = (model: string, provider = "gemini"): ModelRow => {
        let r = by.get(model);
        if (!r) {
            r = { model, provider, roles: [], primaryFor: [], priceInr: null, today: { calls: 0, tokensIn: 0, tokensOut: 0, costInr: 0 }, last30: { calls: 0, tokensIn: 0, tokensOut: 0, costInr: 0 }, totals: totals({}, now), share: 0, daily: {} };
            by.set(model, r);
        }
        return r;
    };
    for (const [role, v] of Object.entries(routes)) {
        v.routes.forEach((rt, i) => {
            const r = row(rt.model, rt.provider);
            r.priceInr ??= rt.priceInr;
            if (!r.roles.includes(role)) r.roles.push(role);
            if (i === 0) r.primaryFor.push(role);
        });
    }
    const roleTotals = new Map<string, { calls: number; costInr: number }>();
    for (const x of spend.data?.rows || []) {
        if (x.day < days[0]) continue;
        const r = row(x.model);
        if (!r.roles.includes(x.role)) r.roles.push(x.role);
        r.daily[x.day] = (r.daily[x.day] ?? 0) + x.costInr;
        for (const bucket of x.day === today ? [r.today, r.last30] : [r.last30]) {
            bucket.calls += x.calls; bucket.tokensIn += x.tokensIn; bucket.tokensOut += x.tokensOut; bucket.costInr += x.costInr;
        }
        if (x.day === today) {
            const t = roleTotals.get(x.role) ?? { calls: 0, costInr: 0 };
            t.calls += x.calls; t.costInr += x.costInr;
            roleTotals.set(x.role, t);
        }
    }
    const all: Record<string, number> = {};
    for (const r of by.values()) {
        r.totals = totals(r.daily, now);
        r.today.costInr = round2(r.today.costInr);
        r.last30.costInr = round2(r.last30.costInr);
        for (const [d, v] of Object.entries(r.daily)) all[d] = (all[d] ?? 0) + v;
    }
    const todayTotal = [...by.values()].reduce((t, r) => t + r.today.costInr, 0);
    for (const r of by.values()) r.share = todayTotal > 0 ? round2(r.today.costInr / todayTotal) : 0;

    // Models used outside the engine (read from service settings; model names only).
    const env = (svc: string, k: string) => run?.find((s) => s.name === svc)?.env[k];
    const other: OtherModel[] = [];
    const stt = env("kavach-backend", "VERTEX_STT_MODEL"), vision = env("kavach-backend", "VERTEX_VISION_MODEL");
    if (stt) other.push({ model: stt, provider: "Vertex AI", use: "Voice notes to text", billedUnder: "Google bill → Vertex AI (not in the engine ledger)" });
    if (vision) other.push({ model: vision, provider: "Vertex AI", use: "Photos and prescriptions sent on WhatsApp", billedUnder: "Google bill → Vertex AI (not in the engine ledger)" });
    const embed = env("kawach-ai-engine", "VERTEX_EMBEDDING_MODEL") || cfg.data?.embeddings;
    if (embed) other.push({ model: embed, provider: "Vertex AI", use: "Memory search (embeddings)", billedUnder: "Google bill → Vertex AI" });
    const agent = env("kavach-backend", "BROWSER_AGENT_MODEL");
    other.push({ model: agent || "browser-use", provider: "Browser Use", use: "Ordering agent in a cloud browser", billedUnder: "Browser Use credits (Infrastructure → Services)" });
    other.push({ model: "ElevenLabs voice", provider: "ElevenLabs", use: "Saheli's voice replies and voice reminders", billedUnder: "ElevenLabs monthly plan" });

    return {
        at: new Date(now).toISOString(), engine: cfg.error || spend.error || null, llm: cfg.data?.llm || null, embeddings: cfg.data?.embeddings || null,
        caps: spend.data ? { today: round2(spend.data.today), soft: spend.data.softCap, hard: spend.data.hardCap } : null,
        totals: totals(all, now), daily: days.map((d) => ({ day: d, inr: round2(all[d] ?? 0) })),
        models: [...by.values()].sort((a, b) => b.last30.costInr - a.last30.costInr || b.roles.length - a.roles.length),
        roles: Object.entries(routes).map(([role, v]) => ({ role, configured: v.configured, routes: v.routes })).sort((a, b) => Number(b.configured) - Number(a.configured) || a.role.localeCompare(b.role)),
        other, byRole: [...roleTotals.entries()].map(([role, t]) => ({ role, calls: t.calls, costInr: round2(t.costInr) })).sort((a, b) => b.costInr - a.costInr),
    };
}

let cached: { at: number; view: ModelsView } | null = null;

export async function models(): Promise<ModelsView> {
    if (cached && Date.now() - cached.at < 2 * 60_000) return cached.view;
    const view = await buildModels();
    cached = { at: Date.now(), view };
    return view;
}
