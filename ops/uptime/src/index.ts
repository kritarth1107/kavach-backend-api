/**
 * Kavach uptime alarm: a Cloudflare Worker (outside AWS, so an AWS outage can't silence it).
 * Every minute it checks that reminders are running (the backend's /api/health/reminders: 503 when the reminder tick has
 * not run for 3 minutes; trust plan B1.7); every 5 minutes it also checks the dashboard, the backend (and its database)
 * and Saheli's engine. Two failures in a row are recorded. Founder 17 Oct 2026: this worker does not email.
 * The only team email is a crisis alert. GET /status runs a round now and shows it (no secrets, saves nothing).
 * KV is written only when the state changes (a few times a day), never every round: the free tier allows 1,000 writes a day.
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

/** The every-minute check: are reminders going out? */
export function reminderTarget(env: Env): Target {
    return {
        name: "reminders",
        label: "Reminders (the backend's 1-minute reminder tick)",
        url: `${env.BACKEND_URL}/api/health/reminders`,
        expect: (status, body) => status === 200 && /"status"\s*:\s*"ok"/.test(body),
    };
}

/** What a round checks: reminders every minute, everything else on the 5-minute marks. */
export function targetsFor(env: Env, now: string): Target[] {
    const everything = new Date(now).getUTCMinutes() % 5 === 0;
    return everything ? [...targets(env), reminderTarget(env)] : [reminderTarget(env)];
}

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
        // The engine is private (no public access allowed in the Workspace), so with the secret it is asked through
        // the backend, which calls it with its own Google identity. A backend outage then shows on both lines.
        env.HEALTH_SECRET
            ? {
                  name: "engine",
                  label: "Saheli's brain (AI engine)",
                  url: `${env.BACKEND_URL}/api/health/engine?HEALTH_SECRET=${encodeURIComponent(env.HEALTH_SECRET)}`,
                  expect: (s, b) => s === 200 && /"status"\s*:\s*"ok"/.test(b),
              }
            : { name: "engine", label: "Saheli's brain (AI engine)", url: `${env.ENGINE_URL}/health`, expect: (s, b) => s === 200 && b.includes('"ok"') },
    ];
}

export async function probe(t: Target, fetchFn: typeof fetch = fetch, timeoutMs = 10_000): Promise<Probe> {
    const started = Date.now();
    try {
        const res = await fetchFn(t.url, { headers: { "user-agent": "kavach-uptime/1" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        const body = (await res.text()).slice(0, 4000);
        const ok = t.expect ? t.expect(res.status, body) : res.status >= 200 && res.status < 400;
        const hint = res.status === 503
            ? "no healthy ECS task (a deploy, or the service is down)"
            : res.status >= 520 && res.status <= 530
              ? "Cloudflare can't reach the server behind it"
              : undefined;
        return { name: t.name, label: t.label, ok, status: res.status, ms: Date.now() - started, error: ok ? undefined : hint };
    } catch (err) {
        return { name: t.name, label: t.label, ok: false, ms: Date.now() - started, error: err instanceof Error ? err.message.slice(0, 120) : "failed" };
    }
}

export async function sendEmail(env: Env, subject: string, text: string, fetchFn: typeof fetch = fetch, html?: string): Promise<boolean> {
    const to = (env.ALERT_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!to.length) {
        console.log(`[team-note] not emailed: ${subject}`);
        return false;
    }
    if (!env.RESEND_API_KEY) {
        console.error("RESEND_API_KEY not set: cannot send", subject);
        return false;
    }
    const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.ALERT_FROM, to, subject, text, ...(html ? { html } : {}) }),
    });
    if (!res.ok) console.error("Resend failed", res.status, (await res.text()).slice(0, 200));
    return res.ok;
}

async function loadRaw(env: Env): Promise<{ state: State; raw: string | null }> {
    const raw = await env.STATE.get("state");
    try {
        return { state: JSON.parse(raw || "") as State, raw };
    } catch {
        return { state: { services: {} }, raw };
    }
}
const load = async (env: Env) => (await loadRaw(env)).state;

export async function runChecks(env: Env, now = new Date().toISOString(), fetchFn: typeof fetch = fetch, all = true) {
    const probes = await Promise.all((all ? [...targets(env), reminderTarget(env)] : targetsFor(env, now)).map((t) => probe(t, fetchFn)));
    const { state: prev, raw } = await loadRaw(env);
    const { next, alerts } = decide(prev, probes, now);
    if (alerts.length) {
        const mail = formatAlerts(alerts, probes, now);
        const pretty = alertEmail(alerts, probes, now);
        await sendEmail(env, pretty.subject, mail.text, fetchFn, pretty.html);
    }
    const json = JSON.stringify({ ...next, weekStart: next.weekStart || now });
    const wrote = json !== raw;
    if (wrote) await env.STATE.put("state", json);
    return { probes, alerts, wrote };
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
        ctx.waitUntil(runChecks(env, new Date(event.scheduledTime || Date.now()).toISOString(), fetch, false));
    },
    async fetch(req: Request, env: Env) {
        if (new URL(req.url).pathname !== "/status") return new Response("Kavach uptime monitor", { status: 200 });
        const probes = await Promise.all([...targets(env), reminderTarget(env)].map((t) => probe(t)));
        const body = { at: new Date().toISOString(), probes: probes.map(({ name, ok, status, ms, error }) => ({ name, ok, status, ms, error })), state: await load(env) };
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    },
};
