/**
 * Kavach uptime alarm: a Cloudflare Worker (outside Google, so a Google suspension can't silence it).
 * Every 5 minutes it checks the dashboard, the backend (and its database) and Saheli's engine, and emails the founder
 * through Resend when one goes down, every 6 h while it stays down, and when it recovers. Monday 09:00 IST it sends a
 * weekly check-in, so a silent alarm is noticed too. GET /status shows the last round (no secrets).
 *
 * Secrets (wrangler secret put): RESEND_API_KEY, HEALTH_SECRET (backend detailed health; optional).
 * Vars (wrangler.toml): ALERT_TO (comma-separated), ALERT_FROM, DASHBOARD_URL, BACKEND_URL, ENGINE_URL.
 */
import { decide, formatAlerts, resetWeek, weeklySummary, type Probe, type State, type Target } from "./check";
import { alertEmail, weeklyEmail } from "./email";

type KV = { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void> };
type Env = {
    STATE: KV;
    RESEND_API_KEY?: string;
    HEALTH_SECRET?: string;
    ALERT_TO: string;
    ALERT_FROM: string;
    DASHBOARD_URL: string;
    BACKEND_URL: string;
    ENGINE_URL: string;
};
type Scheduled = { cron: string; scheduledTime: number };
type Ctx = { waitUntil(p: Promise<unknown>): void };

const WEEKLY_CRON = "30 3 * * 1"; // Monday 03:30 UTC = 09:00 IST

export function targets(env: Env): Target[] {
    const backend = env.HEALTH_SECRET
        ? `${env.BACKEND_URL}/api/health/detailed?HEALTH_SECRET=${encodeURIComponent(env.HEALTH_SECRET)}`
        : `${env.BACKEND_URL}/api/health`;
    return [
        { name: "dashboard", label: "Dashboard (app.kavach.care)", url: `${env.DASHBOARD_URL}/auth/login` },
        {
            name: "backend",
            label: "Backend + database (WhatsApp, reminders)",
            url: backend,
            // detailed health says "ok" only when MongoDB answers
            expect: (status, body) => status === 200 && (!env.HEALTH_SECRET || /"status"\s*:\s*"ok"/.test(body)),
        },
        { name: "engine", label: "Saheli's brain (AI engine)", url: `${env.ENGINE_URL}/health`, expect: (s, b) => s === 200 && b.includes('"ok"') },
    ];
}

export async function probe(t: Target, fetchFn: typeof fetch = fetch, timeoutMs = 10_000): Promise<Probe> {
    const started = Date.now();
    try {
        const res = await fetchFn(t.url, { headers: { "user-agent": "kavach-uptime/1" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        const body = (await res.text()).slice(0, 4000);
        const ok = t.expect ? t.expect(res.status, body) : res.status >= 200 && res.status < 400;
        const hint = /CONSUMER_SUSPENDED|has been suspended/i.test(body)
            ? "Google project suspended"
            : res.status === 404 && /<title>404 Page not found<\/title>/i.test(body)
              ? "Cloud Run has no service here: project suspended or service deleted"
              : res.status >= 520 && res.status <= 530
                ? "Cloudflare can't reach the server behind it"
                : undefined;
        return { name: t.name, label: t.label, ok, status: res.status, ms: Date.now() - started, error: ok ? undefined : hint };
    } catch (err) {
        return { name: t.name, label: t.label, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 120) : "failed" };
    }
}

export async function sendEmail(env: Env, subject: string, text: string, fetchFn: typeof fetch = fetch, html?: string): Promise<boolean> {
    if (!env.RESEND_API_KEY) {
        console.error("RESEND_API_KEY not set: cannot send", subject);
        return false;
    }
    const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.ALERT_FROM, to: env.ALERT_TO.split(",").map((s) => s.trim()).filter(Boolean), subject, text, ...(html ? { html } : {}) }),
    });
    if (!res.ok) console.error("Resend failed", res.status, (await res.text()).slice(0, 200));
    return res.ok;
}

async function load(env: Env): Promise<State> {
    try {
        return JSON.parse((await env.STATE.get("state")) || "") as State;
    } catch {
        return { services: {} };
    }
}

export async function runChecks(env: Env, now = new Date().toISOString(), fetchFn: typeof fetch = fetch) {
    const probes = await Promise.all(targets(env).map((t) => probe(t, fetchFn)));
    const prev = await load(env);
    const { next, alerts } = decide(prev, probes, now);
    if (alerts.length) {
        const mail = formatAlerts(alerts, probes, now);
        const pretty = alertEmail(alerts, probes, now);
        await sendEmail(env, pretty.subject, mail.text, fetchFn, pretty.html);
    }
    await env.STATE.put("state", JSON.stringify({ ...next, weekStart: next.weekStart || now }));
    await env.STATE.put("last", JSON.stringify({ at: now, probes: probes.map(({ name, ok, status, ms, error }) => ({ name, ok, status, ms, error })) }));
    return { probes, alerts };
}

export default {
    async scheduled(event: Scheduled, env: Env, ctx: Ctx) {
        if (event.cron === WEEKLY_CRON) {
            ctx.waitUntil((async () => {
                const state = await load(env);
                const now = new Date().toISOString();
                const mail = weeklySummary(state, now);
                const pretty = weeklyEmail(state, now);
                await sendEmail(env, pretty.subject, mail.text, fetch, pretty.html);
                await env.STATE.put("state", JSON.stringify(resetWeek(state, now)));
            })());
            return;
        }
        ctx.waitUntil(runChecks(env));
    },
    async fetch(req: Request, env: Env) {
        if (new URL(req.url).pathname !== "/status") return new Response("Kavach uptime monitor", { status: 200 });
        return new Response((await env.STATE.get("last")) || "{}", { headers: { "content-type": "application/json" } });
    },
};
