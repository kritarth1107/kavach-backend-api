/**
 * The live check (quality plan F8, trust plan B): production, every hour, and after every engine and backend deploy (F7).
 * It runs in the admin API because only the admin API's identity can read Cloud Monitoring, the engine's admin routes and
 * the database together; a GitHub Actions schedule (live-check.yml, the deploy identity) calls POST /admin/jobs/live-check.
 *
 * Checks, each with a measured value: every service up, the reminder tick fresh, the delivery ledger's delivered and
 * failed rates, errors in the last hour per service, Saheli's reply time (p90), Gemini 429s, escalations on time, the
 * backup's age, and Cloud SQL's state. After a deploy also the deploy scenarios (read-only): a forged WhatsApp webhook is
 * refused, the private APIs refuse a caller without a sign-in, and every engine route the backend, the admin console and
 * the schedules call still exists.
 *
 * Results go to `live_checks` (the admin System page). The Kavach team is emailed only when something is wrong: hourly at
 * most once per check per 3 hours; after a deploy every time (it fails loudly, and the workflow goes red).
 * Read-only throughout: nothing is written anywhere but `live_checks`, and nobody is messaged but the Kavach team.
 */
import mongoose, { Schema } from "mongoose";
import { engine } from "./engine";
import { gapi, gapiAll } from "./infra/google";
import { PROJECT, REGION, runServices, schedules as schedulerJobs } from "./infra/gcp";

export type CheckStatus = "ok" | "warn" | "problem" | "unknown";
export type LiveCheckItem = { key: string; label: string; status: CheckStatus; value: string; detail?: Record<string, unknown> };
export type Trigger = "hourly" | "deploy" | "manual";

export interface ILiveCheck {
    hourKey: string;
    trigger: Trigger;
    service?: string;
    sha?: string;
    at: Date;
    ms: number;
    ok: boolean;
    checks: LiveCheckItem[];
    problems: string[];
    emailed: boolean;
    emailedKeys: string[];
    emailError?: string;
}

const schema = new Schema<ILiveCheck>(
    {
        hourKey: { type: String, required: true, index: true },
        trigger: { type: String, required: true },
        service: String,
        sha: String,
        at: { type: Date, required: true },
        ms: Number,
        ok: Boolean,
        checks: [{ _id: false, key: String, label: String, status: String, value: String, detail: Schema.Types.Mixed }],
        problems: [String],
        emailed: Boolean,
        emailedKeys: [String],
        emailError: String,
    },
    { collection: "live_checks", versionKey: false },
);
schema.index({ at: 1 }, { expireAfterSeconds: 90 * 86_400 });
export const LiveCheck = (mongoose.models.LiveCheck as mongoose.Model<ILiveCheck>) || mongoose.model<ILiveCheck>("LiveCheck", schema);

/* ── thresholds (a problem emails; a warning only shows) ─────────────────── */

export const LIMITS = {
    /** delivery ledger: over the last 24 h, sends older than 30 min (a receipt has had time) */
    deliveredMin: 0.9, deliveredWarn: 0.95, deliveryMinSends: 10, failedMax: 0.05, failedMinCount: 3,
    /** log entries at ERROR or worse, and 5xx answers, per service in the hour */
    errorsPerHour: 20, fiveXxPerHour: 10,
    /** Saheli's reply time: past 35 s WhatsApp gets the "still working" line (the reply SLA); 20 s is slow */
    p90ProblemMs: 35_000, p90WarnMs: 20_000, latencyMinTurns: 5,
    /** Gemini 429s in the hour, all models and regions, retried ones included (trust plan C5.4: >5 in 10 min alerts) */
    gemini429Problem: 10,
    /** the nightly backup runs at 03:30 IST: older than 26 h means a night was missed */
    backupMaxAgeH: 26,
    /** a service deployed this recently may still be starting: a failed probe is a warning, not a problem */
    deployGraceMs: 3 * 60_000,
    /** a Cloud Run service whose rollout has not settled in this long is down */
    rolloutGraceMs: 10 * 60_000,
    /** hourly emails: at most one per check in this long */
    emailEveryMs: 3 * 3_600_000,
};

const IST = 330 * 60_000;
export const hourKeyOf = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 13);

/* ── judges: raw numbers → a check (pure; scripts/test-live-check.ts) ───── */

export function judgeDelivery(c: { sent: number; delivered: number; failed: number; noReceipt: number }): LiveCheckItem {
    const attempted = c.sent + c.failed;
    const rate = c.sent ? c.delivered / c.sent : null;
    const failedRate = attempted ? c.failed / attempted : 0;
    const value = attempted ? `${c.delivered}/${c.sent} delivered (${rate == null ? "-" : Math.round(rate * 100)}%), ${c.failed} failed` : "no sends in the last 24 h";
    let status: CheckStatus = "ok";
    if (c.sent >= LIMITS.deliveryMinSends && rate != null && rate < LIMITS.deliveredMin) status = "problem";
    else if (c.failed >= LIMITS.failedMinCount && failedRate > LIMITS.failedMax) status = "problem";
    else if ((rate != null && c.sent >= LIMITS.deliveryMinSends && rate < LIMITS.deliveredWarn) || c.failed > 0) status = "warn";
    return { key: "delivery", label: "WhatsApp delivery (24 h)", status, value, detail: { ...c, deliveredRate: rate, failedRate } };
}

export function judgeErrors(per: Record<string, { errors: number; fiveXx: number }>): LiveCheckItem {
    const bad = Object.entries(per).filter(([, v]) => v.errors >= LIMITS.errorsPerHour || v.fiveXx >= LIMITS.fiveXxPerHour).map(([k]) => k);
    const some = Object.entries(per).filter(([, v]) => v.errors > 0 || v.fiveXx > 0);
    const value = some.length ? some.map(([k, v]) => `${k} ${v.errors} errors${v.fiveXx ? `, ${v.fiveXx} 5xx` : ""}`).join("; ") : "no errors";
    return { key: "errors", label: "Errors in the last hour", status: bad.length ? "problem" : some.length ? "warn" : "ok", value, detail: { perService: per, over: bad } };
}

export function judgeLatency(l: { turns: number; p50Ms: number | null; p90Ms: number | null; maxMs: number | null } | null): LiveCheckItem {
    const base = { key: "latency", label: "Saheli's reply time (p90, last hour)" };
    if (!l) return { ...base, status: "unknown", value: "the engine did not say" };
    if (!l.turns || l.p90Ms == null) return { ...base, status: "ok", value: "no conversations this hour", detail: l };
    const s = (ms: number | null) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`);
    const value = `p90 ${s(l.p90Ms)}, p50 ${s(l.p50Ms)}, slowest ${s(l.maxMs)} (${l.turns} replies)`;
    const enough = l.turns >= LIMITS.latencyMinTurns;
    const status: CheckStatus = enough && l.p90Ms > LIMITS.p90ProblemMs ? "problem" : l.p90Ms > LIMITS.p90WarnMs ? "warn" : "ok";
    return { ...base, status, value, detail: l };
}

export function judge429(byRoute: Record<string, number>): LiveCheckItem {
    const total = Object.values(byRoute).reduce((a, b) => a + b, 0);
    const value = total ? `${total} (${Object.entries(byRoute).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ")})` : "0";
    return { key: "gemini429", label: "Gemini 429s in the last hour", status: total >= LIMITS.gemini429Problem ? "problem" : total ? "warn" : "ok", value, detail: { byRoute, total } };
}

export function judgeBackup(b: { day?: string; ok?: boolean; finishedAt?: string | null } | null, now: number): LiveCheckItem {
    const base = { key: "backup", label: "Nightly backup" };
    if (!b) return { ...base, status: "problem", value: "no backup recorded" };
    const ageH = b.finishedAt ? (now - new Date(b.finishedAt).getTime()) / 3_600_000 : null;
    const value = `${b.ok ? "ok" : "FAILED"} ${b.day ?? ""}${ageH == null ? "" : `, ${ageH.toFixed(1)} h ago`}`.trim();
    const status: CheckStatus = !b.ok || ageH == null || ageH > LIMITS.backupMaxAgeH ? "problem" : "ok";
    return { ...base, status, value, detail: { ...b, ageH } };
}

export function judgeReminders(hb: { ok: boolean; ageMs: number | null }): LiveCheckItem {
    const value = hb.ageMs == null ? "never ticked" : `last tick ${Math.round(hb.ageMs / 1000)} s ago`;
    return { key: "reminders", label: "Reminder tick", status: hb.ok ? "ok" : "problem", value, detail: hb };
}

export function judgeEscalations(row: { dateKey: string; onTime: number; total: number } | null): LiveCheckItem {
    const base = { key: "escalations", label: "Escalations on time (yesterday)" };
    if (!row) return { ...base, status: "unknown", value: "no check yet" };
    // the 09:00 check emails its own misses: here it only shows
    return { ...base, status: row.onTime < row.total ? "warn" : "ok", value: `${row.onTime}/${row.total} on ${row.dateKey}`, detail: row };
}

export function judgeSql(i: { state?: string; backups?: boolean; pitr?: boolean } | null): LiveCheckItem {
    const base = { key: "cloudsql", label: "Cloud SQL (engine database)" };
    if (!i) return { ...base, status: "unknown", value: "not readable" };
    const value = `${(i.state || "?").toLowerCase()}, backups ${i.backups ? "on" : "off"}, point-in-time recovery ${i.pitr ? "on" : "off"}`;
    const status: CheckStatus = i.state !== "RUNNABLE" ? "problem" : !i.backups || !i.pitr ? "warn" : "ok";
    return { ...base, status, value, detail: i };
}

export type Probe = { name: string; ok: boolean; status?: number; ms: number; error?: string; deploying?: boolean };

export function judgeServices(probes: Probe[], notReady: string[]): LiveCheckItem {
    const down = probes.filter((p) => !p.ok && !p.deploying).map((p) => p.name);
    const starting = probes.filter((p) => !p.ok && p.deploying).map((p) => p.name);
    const value = down.length || notReady.length
        ? `down: ${[...down, ...notReady.map((n) => `${n} (not ready)`)].join(", ")}`
        : starting.length ? `up; ${starting.join(", ")} just deployed and still starting` : `${probes.length} up`;
    const status: CheckStatus = down.length || notReady.length ? "problem" : starting.length ? "warn" : "ok";
    return { key: "services", label: "Every service up", status, value, detail: { probes, notReady } };
}

/* ── collectors (production reads) ─────────────────────────────────────── */

async function probe(name: string, url: string, expect: (status: number, body: string) => boolean, init: RequestInit = {}): Promise<Probe> {
    const once = async (): Promise<Probe> => {
        const started = Date.now();
        try {
            const res = await fetch(url, { redirect: "manual", ...init, headers: { "user-agent": "kavach-live-check/1", ...(init.headers || {}) }, signal: AbortSignal.timeout(10_000) });
            const body = (await res.text()).slice(0, 2000);
            return { name, ok: expect(res.status, body), status: res.status, ms: Date.now() - started };
        } catch (e) {
            return { name, ok: false, ms: Date.now() - started, error: (e as Error).message.slice(0, 120) };
        }
    };
    const first = await once();
    if (first.ok) return first;
    await new Promise((r) => setTimeout(r, Number(process.env.LIVE_CHECK_RETRY_MS ?? 15_000)));
    return once();
}

const backendUrl = () => (process.env.BACKEND_URL || "").replace(/\/$/, "");
const appUrl = () => (process.env.LIVE_FRONTEND_URL || "https://app.kavach.care").replace(/\/$/, "");

async function services(now: number, trigger: Trigger): Promise<LiveCheckItem> {
    const run = await runServices().catch(() => null);
    // the hourly run gives a service deployed a moment ago time to start; after a deploy it must already answer
    const recent = new Set(trigger === "deploy" ? [] : (run || []).filter((s) => s.updatedAt && now - new Date(s.updatedAt).getTime() < LIMITS.deployGraceMs).map((s) => s.name));
    const adminWeb = (run || []).find((s) => s.name === "kavach-admin")?.uri;
    const probes = await Promise.all([
        probe("kavach-backend", `${backendUrl()}/api/health`, (s, b) => s === 200 && /"status"\s*:\s*"ok"/.test(b)),
        probe("kavach-dashboard", `${appUrl()}/auth/login`, (s) => s >= 200 && s < 400),
        ...(adminWeb ? [probe("kavach-admin", `${adminWeb}/login`, (s) => s >= 200 && s < 400)] : []),
        (async (): Promise<Probe> => {
            const started = Date.now();
            try {
                const h = await engine<{ status?: string }>("GET", "/health", undefined, 15_000);
                return { name: "kawach-ai-engine", ok: h.status === "ok", ms: Date.now() - started };
            } catch (e) {
                return { name: "kawach-ai-engine", ok: false, ms: Date.now() - started, error: (e as Error).message.slice(0, 120) };
            }
        })(),
    ]);
    for (const p of probes) p.deploying = recent.has(p.name);
    // a service rolling out a new revision is "not ready" for a minute or two while the old one still serves: only one
    // still not ready after the grace is down (any run, a deploy's check included: another service may be mid-deploy)
    const notReady = (run || []).filter((s) => !s.ready && !(s.updatedAt && now - new Date(s.updatedAt).getTime() < LIMITS.rolloutGraceMs)).map((s) => s.name);
    const item = judgeServices(probes, notReady);
    if (!run) item.detail = { ...item.detail, cloudRun: "not readable" };
    return item;
}

async function delivery(now: number): Promise<LiveCheckItem> {
    const { default: MessageDelivery } = await import("../models/messageDelivery.model");
    const since = new Date(now - 86_400_000), settled = new Date(now - 30 * 60_000);
    const [r] = await MessageDelivery.aggregate<{ sent: number; delivered: number; failed: number; noReceipt: number }>([
        { $match: { createdAt: { $gte: since, $lte: settled } } },
        {
            $group: {
                _id: null,
                sent: { $sum: { $cond: [{ $and: [{ $ifNull: ["$sentAt", false] }, { $ne: ["$status", "failed"] }] }, 1, 0] } },
                delivered: { $sum: { $cond: [{ $or: [{ $ifNull: ["$deliveredAt", false] }, { $ifNull: ["$readAt", false] }] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                noReceipt: { $sum: { $cond: [{ $and: [{ $ifNull: ["$sentAt", false] }, { $not: [{ $ifNull: ["$receiptAt", false] }] }] }, 1, 0] } },
            },
        },
    ]);
    return judgeDelivery(r ?? { sent: 0, delivered: 0, failed: 0, noReceipt: 0 });
}

type Point = { value: { int64Value?: string; doubleValue?: number } };
type Series = { metric?: { labels?: Record<string, string> }; resource?: { labels?: Record<string, string> }; points?: Point[] };
const num = (p: Point) => p.value.doubleValue ?? Number(p.value.int64Value ?? 0);

async function hourSeries(filter: string, groupBy: string[], now: number): Promise<Series[]> {
    const q = new URLSearchParams({
        filter, "interval.startTime": new Date(now - 3_600_000).toISOString(), "interval.endTime": new Date(now).toISOString(),
        "aggregation.alignmentPeriod": "3600s", "aggregation.perSeriesAligner": "ALIGN_DELTA", "aggregation.crossSeriesReducer": "REDUCE_SUM",
    });
    for (const g of groupBy) q.append("aggregation.groupByFields", g);
    return gapiAll<Series>(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${q}`, "timeSeries", 5);
}

async function errors(now: number): Promise<LiveCheckItem> {
    const [logs, http] = await Promise.all([
        hourSeries('metric.type="logging.googleapis.com/log_entry_count" AND resource.type="cloud_run_revision" AND metric.label.severity=one_of("ERROR","CRITICAL","ALERT","EMERGENCY")',
            ["resource.label.service_name"], now),
        hourSeries('metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision" AND metric.label.response_code_class="5xx"',
            ["resource.label.service_name"], now),
    ]);
    const per: Record<string, { errors: number; fiveXx: number }> = {};
    const add = (s: Series, k: "errors" | "fiveXx") => {
        const name = s.resource?.labels?.service_name || "other";
        (per[name] ??= { errors: 0, fiveXx: 0 })[k] += (s.points || []).reduce((t, p) => t + num(p), 0);
    };
    logs.forEach((s) => add(s, "errors"));
    http.forEach((s) => add(s, "fiveXx"));
    return judgeErrors(per);
}

async function gemini429(now: number): Promise<LiveCheckItem> {
    const s = await hourSeries('metric.type="aiplatform.googleapis.com/publisher/online_serving/model_invocation_count" AND metric.label.response_code="429"',
        ["resource.label.model_user_id", "resource.label.location"], now);
    const byRoute: Record<string, number> = {};
    for (const x of s) {
        const k = `${x.resource?.labels?.model_user_id || "?"}@${x.resource?.labels?.location || "?"}`;
        byRoute[k] = (byRoute[k] ?? 0) + (x.points || []).reduce((t, p) => t + num(p), 0);
    }
    return judge429(byRoute);
}

async function latency(): Promise<LiveCheckItem> {
    try {
        return judgeLatency(await engine<{ turns: number; p50Ms: number | null; p90Ms: number | null; maxMs: number | null }>("GET", "/latency?hours=1"));
    } catch {
        return judgeLatency(null);
    }
}

async function backup(now: number): Promise<LiveCheckItem> {
    const h = await engine<{ backup?: { day?: string; ok?: boolean; finishedAt?: string | null } | null }>("GET", "/health", undefined, 15_000);
    return judgeBackup(h.backup ?? null, now);
}

async function reminders(now: number): Promise<LiveCheckItem> {
    const { reminderHeartbeat } = await import("../services/reminderHealth.service");
    return judgeReminders(await reminderHeartbeat(now));
}

async function escalations(): Promise<LiveCheckItem> {
    const { EscalationCheck } = await import("../models/escalation.model");
    const row = await EscalationCheck.findOne({}).sort({ dateKey: -1 }).lean<{ dateKey: string; onTime: number; total: number }>();
    return judgeEscalations(row);
}

async function cloudSql(): Promise<LiveCheckItem> {
    type I = { state?: string; settings?: { backupConfiguration?: { enabled?: boolean; pointInTimeRecoveryEnabled?: boolean } } };
    const i = await gapi<I>(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${process.env.ENGINE_SQL_INSTANCE || "kavach-ai-pg"}`);
    return judgeSql({ state: i.state, backups: !!i.settings?.backupConfiguration?.enabled, pitr: !!i.settings?.backupConfiguration?.pointInTimeRecoveryEnabled });
}

/* ── after-deploy scenarios (F7): read-only, nothing reaches a person ───── */

/** Engine routes something else calls: the backend, the admin console, the GitHub workflows (13 Oct: a nightly's scores
 *  were lost to a 404 while the route was not deployed yet). The schedules' own targets are added from Cloud Scheduler. */
export const ENGINE_ROUTES = [
    "/health", "/v2/turn", "/v2/events", "/v2/brain/compose-reminder", "/v2/voice/prepare", "/v2/calls/turn", "/v2/calls/summary",
    "/v2/admin/health", "/v2/admin/latency", "/v2/admin/eval-scores", "/v2/admin/daily-score", "/v2/admin/live", "/v2/jobs/morning-report",
];

export function judgeRoutes(paths: string[] | null, wanted: string[]): LiveCheckItem {
    const base = { key: "engine_routes", label: "Engine routes others call" };
    if (!paths) return { ...base, status: "problem", value: "the engine's route list could not be read" };
    const have = new Set(paths);
    const missing = [...new Set(wanted)].filter((w) => !have.has(w));
    return { ...base, status: missing.length ? "problem" : "ok", value: missing.length ? `missing: ${missing.join(", ")}` : `${new Set(wanted).size} routes present`, detail: { missing } };
}

async function engineRoutes(): Promise<LiveCheckItem> {
    const base = (process.env.ENGINE_URL || "").replace(/\/$/, "");
    let paths: string[] | null = null;
    try {
        const { GoogleAuth } = await import("google-auth-library");
        const client = await new GoogleAuth().getIdTokenClient(base);
        const headers = await client.getRequestHeaders(base);
        const h: Record<string, string> = {};
        (headers as unknown as Headers).forEach((v, k) => (h[k] = v));
        const res = await fetch(`${base}/openapi.json`, { headers: h, signal: AbortSignal.timeout(15_000) });
        if (res.ok) paths = Object.keys(((await res.json()) as { paths?: Record<string, unknown> }).paths || {});
    } catch {
        paths = null;
    }
    const host = base.replace(/^https?:\/\//, "");
    type J = { name: string; httpTarget?: { uri?: string } };
    const jobs = await gapiAll<J>(`https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/jobs`, "jobs").catch(() => [] as J[]);
    const scheduled = jobs.map((j) => j.httpTarget?.uri || "").filter((u) => u.includes(host)).map((u) => new URL(u).pathname);
    return judgeRoutes(paths, [...ENGINE_ROUTES, ...scheduled]);
}

export function judgeRefusals(results: Array<{ name: string; status?: number; want: number[] }>): LiveCheckItem {
    const wrong = results.filter((r) => r.status == null || !r.want.includes(r.status));
    return {
        key: "refusals", label: "Forged and unsigned calls are refused",
        status: wrong.length ? "problem" : "ok",
        value: wrong.length ? wrong.map((r) => `${r.name}: ${r.status ?? "no answer"} (want ${r.want.join("/")})`).join("; ") : `${results.length} refused as they should be`,
        detail: { results },
    };
}

async function refusals(): Promise<LiveCheckItem> {
    const b = backendUrl();
    const call = async (name: string, url: string, init: RequestInit, want: number[]) => {
        try {
            const res = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(10_000) });
            return { name, status: res.status, want };
        } catch {
            return { name, want };
        }
    };
    // A webhook with no signature, and one with a wrong signature: never processed (trust plan B5.1d). The body is an empty
    // change list, so even a regression that let it through could not reach anyone.
    const forged = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    return judgeRefusals(await Promise.all([
        call("webhook without a signature", `${b}/api/webhooks/whatsapp/meta`, { method: "POST", headers: { "content-type": "application/json" }, body: forged }, [401, 403]),
        call("webhook with a wrong signature", `${b}/api/webhooks/whatsapp/meta`, {
            method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` }, body: forged,
        }, [401, 403]),
        call("webhook handshake with a wrong token", `${b}/api/webhooks/whatsapp/meta?hub.mode=subscribe&hub.verify_token=live-check-wrong&hub.challenge=1`, { method: "GET" }, [401, 403]),
        call("a family's data without a sign-in", `${b}/api/families/live-check/subjects`, { method: "GET" }, [401, 403]),
    ]));
}

/* ── one run ───────────────────────────────────────────────────────────── */

type Collector = (now: number, trigger: Trigger) => Promise<LiveCheckItem>;
const LABELS: Record<string, string> = {
    services: "Every service up", reminders: "Reminder tick", delivery: "WhatsApp delivery (24 h)", errors: "Errors in the last hour",
    latency: "Saheli's reply time (p90, last hour)", gemini429: "Gemini 429s in the last hour", escalations: "Escalations on time (yesterday)",
    backup: "Nightly backup", cloudsql: "Cloud SQL (engine database)", refusals: "Forged and unsigned calls are refused", engine_routes: "Engine routes others call",
};

export const COLLECTORS: Record<string, Collector> = {
    services, reminders, delivery, errors, latency: () => latency(), gemini429, escalations: () => escalations(), backup, cloudsql: () => cloudSql(),
};
export const DEPLOY_COLLECTORS: Record<string, Collector> = { refusals: () => refusals(), engine_routes: () => engineRoutes() };
export const DEPLOY_CRITICAL = new Set(["services", "reminders", "refusals", "engine_routes"]);

export type RunOpts = {
    trigger: Trigger;
    service?: string;
    sha?: string;
    now?: number;
    collectors?: Record<string, Collector>;
    send?: (subject: string, text: string) => Promise<unknown>;
    /** tests: no database */
    store?: { recentEmails(since: Date): Promise<Array<{ emailedKeys: string[] }>>; existing(hourKey: string): Promise<ILiveCheck | null>; save(row: ILiveCheck): Promise<unknown> };
};

const mongoStore: NonNullable<RunOpts["store"]> = {
    recentEmails: (since) => LiveCheck.find({ trigger: "hourly", emailed: true, at: { $gte: since } }, { emailedKeys: 1 }).lean<Array<{ emailedKeys: string[] }>>(),
    existing: (hourKey) => LiveCheck.findOne({ hourKey, trigger: "hourly" }).lean<ILiveCheck>(),
    save: (row) => LiveCheck.create(row),
};

export async function runLiveCheck(opts: RunOpts): Promise<ILiveCheck> {
    const now = opts.now ?? Date.now();
    const store = opts.store ?? mongoStore;
    const hourKey = hourKeyOf(new Date(now));
    if (opts.trigger === "hourly") {
        const done = await store.existing(hourKey);
        if (done) return done; // a schedule that fired twice in the hour
    }
    const collectors = opts.collectors ?? { ...COLLECTORS, ...(opts.trigger === "deploy" ? DEPLOY_COLLECTORS : {}) };
    const checks = await Promise.all(
        Object.entries(collectors).map(async ([key, fn]): Promise<LiveCheckItem> => {
            try {
                return await fn(now, opts.trigger);
            } catch (e) {
                return { key, label: LABELS[key] || key, status: "unknown", value: `could not check: ${(e as Error).message.slice(0, 160)}` };
            }
        }),
    );
    const order: CheckStatus[] = ["problem", "unknown", "warn", "ok"];
    checks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    // After a deploy only what a deploy can break fails it (and emails); the state of production (reply time, 429s, the
    // ledger, the backup) shows in the same run but is the hourly check's to raise.
    const problems = checks.filter((c) => c.status === "problem" && (opts.trigger !== "deploy" || DEPLOY_CRITICAL.has(c.key))).map((c) => c.key);
    const row: ILiveCheck = {
        hourKey, trigger: opts.trigger, service: opts.service, sha: opts.sha, at: new Date(now), ms: Date.now() - now, ok: !problems.length,
        checks, problems, emailed: false, emailedKeys: [],
    };

    let toEmail = problems;
    if (opts.trigger === "hourly" && problems.length) {
        const recent = await store.recentEmails(new Date(now - LIMITS.emailEveryMs));
        const told = new Set(recent.flatMap((r) => r.emailedKeys || []));
        toEmail = problems.filter((k) => !told.has(k));
    }
    if (toEmail.length) {
        const send = opts.send ?? (async (s: string, t: string) => (await import("../services/email.service")).sendOpsAlert(s, t));
        const { subject, text } = liveCheckEmail(row);
        try {
            await send(subject, text);
            row.emailed = true;
            row.emailedKeys = problems;
        } catch (e) {
            row.emailError = (e as Error).message.slice(0, 200);
        }
    }
    await store.save(row);
    console.log(`[live-check] ${opts.trigger}${opts.service ? ` ${opts.service}` : ""} ${hourKey}: ${problems.length ? `problems ${problems.join(",")}` : "all ok"} (emailed=${row.emailed})`);
    return row;
}

export function liveCheckEmail(row: Pick<ILiveCheck, "trigger" | "service" | "sha" | "at" | "checks" | "problems">): { subject: string; text: string } {
    const when = new Date(row.at.getTime() + IST).toISOString().slice(11, 16);
    const bad = row.checks.filter((c) => row.problems.includes(c.key));
    const head = row.trigger === "deploy"
        ? `After the ${row.service || "?"} deploy${row.sha ? ` (${row.sha.slice(0, 7)})` : ""}: ${bad.length} check${bad.length === 1 ? "" : "s"} failed`
        : `Live check ${when} IST: ${bad.map((c) => c.label.toLowerCase()).join(", ")}`;
    const line = (c: LiveCheckItem) => `${c.status === "problem" ? "✗" : c.status === "warn" ? "!" : c.status === "unknown" ? "?" : "✓"} ${c.label}: ${c.value}`;
    const text = [
        row.trigger === "deploy" ? `The checks after the ${row.service || "?"} deploy found problems in production.` : "The hourly live check found problems in production.",
        "",
        ...bad.map(line),
        "",
        "Everything checked:",
        ...row.checks.map(line),
        "",
        "Admin console, System page: the last 48 checks. Hourly emails repeat a problem at most every 3 hours.",
    ].join("\n");
    return { subject: `Live check: ${head}`.slice(0, 150), text };
}
