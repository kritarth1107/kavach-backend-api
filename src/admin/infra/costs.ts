/**
 * The cost analyser (founder 21 Oct: "every cost, today, yesterday, this month so far, forecast… platform-wise with
 * separate projects… count credits… do not miss a minor even").
 *
 * Every platform is read from its own bill where one exists, and each number says where it came from:
 * - AWS: Cost Explorer with the task role. Cost per service per day before credits, credits, refunds and tax as their own
 *   record types, this month's usage types, AWS's own month forecast, and every credit applied since the account began.
 * - Google Cloud: the BigQuery billing export (every project on the billing account). Cost per project, service and day,
 *   each credit type (free trial, promotion, free tier, discounts), this month's top SKUs per project.
 * - WhatsApp (Meta pricing analytics), Browser Use (balance drop per day), ElevenLabs (Kavach's credits only): the
 *   connectors in vendors.ts and the snapshot.
 * - Credit grants (how much a provider gave and when it ends) are not readable from any API, so the team enters them here;
 *   remaining = granted − used since the grant started (from the bill).
 * Amounts are in INR; USD bills are converted at USD_INR (pricing.ts).
 */
import mongoose, { Schema } from "mongoose";
import { engineOrNull } from "../engine";
import { sigv4, taskCreds } from "./aws";
import * as gcp from "./gcp";
import { gapi, gcpReadable } from "./google";
import { istDay, USD_INR } from "./pricing";
import { snapshot } from "./summary";
import { browserUseAccount, browserUseHistory, elevenLabsUsage, whatsappBill } from "./vendors";

const r2 = (v: number) => Math.round(v * 100) / 100;

// ── credit grants (entered by the team) ────────────────────────────────────────

const grantSchema = new Schema({
    grantId: { type: String, required: true, index: true },
    provider: { type: String, required: true }, // "AWS" | "GCP" | "ElevenLabs" | "Browser Use" | "Meta" | …
    project: { type: String, default: null }, // a GCP project, when the grant is for one
    label: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, enum: ["INR", "USD"], default: "USD" },
    startsAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    note: { type: String, default: null },
    by: String, at: Date,
}, { collection: "admin_credit_grants", versionKey: false });
const Grant = mongoose.models.AdminCreditGrant || mongoose.model("AdminCreditGrant", grantSchema);
export type GrantDoc = { grantId: string; provider: string; project: string | null; label: string; amount: number; currency: "INR" | "USD"; startsAt: Date; expiresAt: Date | null; note: string | null; by?: string; at?: Date };

export async function listGrants(): Promise<GrantDoc[]> {
    return Grant.find({}).sort({ startsAt: 1 }).lean<GrantDoc[]>();
}

export async function saveGrant(g: Omit<GrantDoc, "grantId" | "at"> & { grantId?: string }, by: string): Promise<GrantDoc> {
    const grantId = g.grantId || new mongoose.Types.ObjectId().toHexString();
    await Grant.updateOne({ grantId }, { $set: { ...g, grantId, by, at: new Date() } }, { upsert: true });
    return (await Grant.findOne({ grantId }).lean<GrantDoc>())!;
}

export async function deleteGrant(grantId: string): Promise<boolean> {
    return (await Grant.deleteOne({ grantId })).deletedCount > 0;
}

// ── shared shapes ───────────────────────────────────────────────────────────────

export type Period = { today: number; yesterday: number; last7: number; mtd: number; lastMonth: number | null; forecast: number; avgDay7: number };
export type Line = { name: string; group?: string; unit?: "credits"; period: Period; gross?: Period; credits?: Period; daily: Record<string, number>; detail?: Array<{ label: string; value: string }> };

function days(now: number) {
    const today = istDay(new Date(now));
    const yesterday = istDay(new Date(now - 86_400_000));
    const month = today.slice(0, 7);
    const d = new Date(`${month}-01T00:00:00+05:30`);
    const last = new Date(d.getTime() - 86_400_000);
    const lastMonth = istDay(last).slice(0, 7);
    const dim = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const dayOfMonth = Number(today.slice(8, 10));
    return { today, yesterday, month, lastMonth, dim, dayOfMonth, week: Array.from({ length: 7 }, (_, i) => istDay(new Date(now - (i + 1) * 86_400_000))) };
}

/** Today, yesterday, last 7 complete days, month to date, last month, and a forecast: month to date + the last 7 days' pace for the days left. */
export function period(daily: Record<string, number>, now = Date.now(), knownForecast?: number | null): Period {
    const d = days(now);
    const sum = (keys: string[]) => keys.reduce((t, k) => t + (daily[k] ?? 0), 0);
    const all = Object.keys(daily);
    const mtd = sum(all.filter((k) => k.startsWith(d.month)));
    const last7 = sum(d.week);
    const avg = last7 / 7;
    const lm = all.filter((k) => k.startsWith(d.lastMonth));
    return {
        today: r2(daily[d.today] ?? 0), yesterday: r2(daily[d.yesterday] ?? 0), last7: r2(last7), mtd: r2(mtd),
        lastMonth: lm.length ? r2(sum(lm)) : null,
        forecast: r2(knownForecast ?? mtd - (daily[d.today] ?? 0) + avg * (d.dim - d.dayOfMonth + 1)), avgDay7: r2(avg),
    };
}

const add = (into: Record<string, number>, day: string, v: number) => { into[day] = (into[day] ?? 0) + v; };
const sumDaily = (list: Array<Record<string, number>>) => { const o: Record<string, number> = {}; for (const d of list) for (const [k, v] of Object.entries(d)) add(o, k, v); return o; };

// ── AWS ─────────────────────────────────────────────────────────────────────────

type CeGroup = { Keys: string[]; Metrics: Record<string, { Amount: string; Unit: string }> };
async function ce<T>(target: string, body: unknown): Promise<T> {
    const c = await taskCreds();
    if (!c) throw new Error("not on AWS");
    const host = "ce.us-east-1.amazonaws.com";
    const payload = JSON.stringify(body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", "x-amz-target": `AWSInsightsIndexService.${target}` };
    if (c.token) headers["x-amz-security-token"] = c.token;
    const auth = sigv4({ method: "POST", host, path: "/", headers, body: payload, region: "us-east-1", service: "ce", accessKey: c.accessKey, secretKey: c.secretKey, amzDate });
    const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body: payload, signal: AbortSignal.timeout(20_000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Cost Explorer ${target}: ${(data as { message?: string; Message?: string }).message || (data as { Message?: string }).Message || res.status}`);
    return data as T;
}
const inr = (m: { Amount: string; Unit: string }) => Number(m.Amount) * (m.Unit === "USD" ? USD_INR : 1);

async function awsCosts(now: number, errors: string[]) {
    const d = days(now);
    const start = `${d.lastMonth}-01`;
    const end = new Date(now + 86_400_000).toISOString().slice(0, 10);
    type R = { ResultsByTime?: Array<{ TimePeriod: { Start: string }; Groups?: CeGroup[] }>; NextPageToken?: string };
    const byService: Record<string, Record<string, number>> = {};
    const byType: Record<string, Record<string, number>> = {}; // record type (Usage, Credit, Refund, Tax, …) -> day -> INR
    let token: string | undefined;
    do {
        const r = await ce<R>("GetCostAndUsage", { TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"],
            GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }, { Type: "DIMENSION", Key: "RECORD_TYPE" }], ...(token ? { NextPageToken: token } : {}) });
        for (const t of r.ResultsByTime || []) {
            const day = istDay(new Date(`${t.TimePeriod.Start}T12:00:00Z`));
            for (const g of t.Groups || []) {
                const [service, type] = g.Keys;
                const v = inr(g.Metrics.UnblendedCost);
                add((byType[type] ??= {}), day, v);
                if (type === "Usage" || type === "SavingsPlanRecurringFee" || type === "RIFee" || type === "Recurring reservation fee") add((byService[service] ??= {}), day, v);
            }
        }
        token = r.NextPageToken;
    } while (token);
    // this month's usage types (what inside a service costs money)
    const usage: Array<{ service: string; usageType: string; inr: number; quantity: number; unit: string }> = [];
    try {
        const r = await ce<{ ResultsByTime?: Array<{ Groups?: CeGroup[] }> }>("GetCostAndUsage", { TimePeriod: { Start: `${d.month}-01`, End: end }, Granularity: "MONTHLY",
            Metrics: ["UnblendedCost", "UsageQuantity"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }, { Type: "DIMENSION", Key: "USAGE_TYPE" }],
            Filter: { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } } });
        for (const t of r.ResultsByTime || []) for (const g of t.Groups || []) {
            const v = inr(g.Metrics.UnblendedCost);
            if (v > 0.005) usage.push({ service: g.Keys[0], usageType: g.Keys[1], inr: r2(v), quantity: Number(g.Metrics.UsageQuantity?.Amount || 0), unit: g.Metrics.UsageQuantity?.Unit || "" });
        }
        usage.sort((a, b) => b.inr - a.inr);
    } catch (e) { errors.push(`AWS usage types: ${(e as Error).message}`); }
    // every credit since the account began (Cost Explorer keeps 13 months)
    const creditsByMonth: Record<string, number> = {};
    try {
        const from = new Date(now - 395 * 86_400_000).toISOString().slice(0, 8) + "01";
        const r = await ce<{ ResultsByTime?: Array<{ TimePeriod: { Start: string }; Total?: Record<string, { Amount: string; Unit: string }> }> }>("GetCostAndUsage", {
            TimePeriod: { Start: from, End: end }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"], Filter: { Dimensions: { Key: "RECORD_TYPE", Values: ["Credit"] } } });
        for (const t of r.ResultsByTime || []) {
            const v = t.Total?.UnblendedCost ? inr(t.Total.UnblendedCost) : 0;
            if (v) creditsByMonth[t.TimePeriod.Start.slice(0, 7)] = r2(-v);
        }
    } catch (e) { errors.push(`AWS credits history: ${(e as Error).message}`); }
    // AWS's own forecast for the rest of the month: before credits (usage only) and after (net)
    const forecast = { gross: null as number | null, net: null as number | null };
    const nextMonth = new Date(`${d.month}-01T00:00:00Z`); nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const fStart = new Date(now + 86_400_000).toISOString().slice(0, 10), fEnd = nextMonth.toISOString().slice(0, 10);
    if (fStart < fEnd) {
        for (const [k, filter] of [["gross", { Dimensions: { Key: "RECORD_TYPE", Values: ["Usage"] } }], ["net", undefined]] as const) {
            try {
                const r = await ce<{ Total?: { Amount: string; Unit: string } }>("GetCostForecast", { TimePeriod: { Start: fStart, End: fEnd }, Metric: "UNBLENDED_COST", Granularity: "MONTHLY", ...(filter ? { Filter: filter } : {}) });
                if (r.Total) forecast[k] = inr(r.Total);
            } catch (e) {
                const m = (e as Error).message;
                // A new account: AWS will not forecast yet; the page uses month so far + the last 7 days' pace instead.
                if (k === "net") errors.push(/historical data/i.test(m) ? "AWS has too little history to forecast yet; the AWS forecast is this month so far + the last 7 days' pace" : `AWS forecast: ${m}`);
            }
        }
    }
    return { byService, byType, usage, creditsByMonth, forecast };
}

// ── Google Cloud ────────────────────────────────────────────────────────────────

type BqRow = { f: Array<{ v: string | null }> };
async function bq(sql: string): Promise<BqRow[]> {
    const r = await gapi<{ rows?: BqRow[]; jobComplete?: boolean }>(`https://bigquery.googleapis.com/bigquery/v2/projects/${gcp.PROJECT}/queries`, {
        method: "POST", timeoutMs: 40_000, body: { query: sql, useLegacySql: false, timeoutMs: 35_000 } });
    if (r.jobComplete === false) throw new Error("billing query still running");
    return r.rows || [];
}

async function gcpCosts(now: number, table: string) {
    const d = days(now);
    const since = `${d.lastMonth}-01`;
    const rate = (cur: string | null) => (cur === "USD" ? USD_INR : 1);
    // per project, service, day: cost before credits; then each credit type (two queries, so a line with several credits
    // never repeats its cost)
    const projects: Record<string, { services: Record<string, { gross: Record<string, number>; credits: Record<string, number> }>; creditTypes: Record<string, Record<string, number>> }> = {};
    const at = (p: string | null, s: string | null) => ((projects[p || "(account)"] ??= { services: {}, creditTypes: {} }).services[s || "Other"] ??= { gross: {}, credits: {} });
    for (const r of await bq(`
SELECT IFNULL(project.id, '(account)') p, service.description s, FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, 'Asia/Kolkata')) d, currency c, SUM(cost) cost
FROM \`${table}\` WHERE DATE(usage_start_time, 'Asia/Kolkata') >= '${since}' GROUP BY p, s, d, c`)) {
        const [p, s, day, cur, cost] = r.f.map((x) => x.v);
        add(at(p, s).gross, day!, Number(cost || 0) * rate(cur));
    }
    for (const r of await bq(`
SELECT IFNULL(project.id, '(account)') p, service.description s, FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, 'Asia/Kolkata')) d, currency c, x.type t, SUM(x.amount) a
FROM \`${table}\`, UNNEST(credits) x WHERE DATE(usage_start_time, 'Asia/Kolkata') >= '${since}' GROUP BY p, s, d, c, t`)) {
        const [p, s, day, cur, t, amt] = r.f.map((x) => x.v);
        const v = Number(amt || 0) * rate(cur);
        add(at(p, s).credits, day!, v);
        add(((projects[p || "(account)"].creditTypes[t || "OTHER"] ??= {})), day!, v);
    }
    // this month's top SKUs per project
    const skus = (await bq(`
SELECT IFNULL(project.id, '(account)') p, service.description s, sku.description k, currency c, SUM(cost) gross,
  SUM(IFNULL((SELECT SUM(x.amount) FROM UNNEST(credits) x), 0)) cr, SUM(usage.amount_in_pricing_units) q, ANY_VALUE(usage.pricing_unit) u
FROM \`${table}\` WHERE DATE(usage_start_time, 'Asia/Kolkata') >= '${d.month}-01'
GROUP BY p, s, k, c HAVING ABS(gross) > 0.001 ORDER BY gross DESC LIMIT 200`)).map((r) => {
        const [p, s, k, cur, cost, cr, q, u] = r.f.map((x) => x.v);
        return { project: p || "(account)", service: s || "", sku: k || "", gross: r2(Number(cost) * rate(cur)), credits: r2(Number(cr) * rate(cur)), quantity: Number(q || 0), unit: u || "" };
    });
    // every credit since the export began, by type and name (free trial, promotions…)
    const creditNames = (await bq(`
SELECT c.type t, IFNULL(c.name, '') n, IFNULL(c.full_name, '') fn, currency cur, SUM(c.amount) a, MIN(DATE(usage_start_time, 'Asia/Kolkata')) first, MAX(DATE(usage_start_time, 'Asia/Kolkata')) last
FROM \`${table}\`, UNNEST(credits) c GROUP BY t, n, fn, cur ORDER BY a`)).map((r) => {
        const [t, n, fn, cur, a, first, last] = r.f.map((x) => x.v);
        return { type: t || "", name: fn || n || t || "", used: r2(-Number(a) * rate(cur)), first: first || "", last: last || "" };
    });
    const exportStarted = (await bq(`SELECT MIN(DATE(usage_start_time, 'Asia/Kolkata')) FROM \`${table}\``))[0]?.f[0]?.v || null;
    return { projects, skus, creditNames, exportStarted };
}

// ── the page ────────────────────────────────────────────────────────────────────

const PROJECT_TAG: Record<string, string> = { "kavach-care": "production", "kavach-eval-1015": "eval", "sunny-ship-508214-q1": "old project" };
const CREDIT_TYPE: Record<string, string> = {
    FREE_TIER: "Free tier", PROMOTION: "Promotion / free-trial credit", SUSTAINED_USAGE_DISCOUNT: "Sustained-use discount",
    COMMITTED_USAGE_DISCOUNT: "Committed-use discount", COMMITTED_USAGE_DISCOUNT_DOLLAR_BASE: "Committed-use discount", DISCOUNT: "Discount",
    SUBSCRIPTION_BENEFIT: "Subscription benefit", RESELLER_MARGIN: "Reseller margin", FEE_UTILIZATION_OFFSET: "Fee offset",
};

// Cost Explorer charges per request, so one analysis serves every caller for 10 minutes (refresh forces a new one).
let cache: { at: number; value: Awaited<ReturnType<typeof analyse>> } | null = null;
export async function costAnalysis(now = Date.now(), fresh = false) {
    if (!fresh && cache && now - cache.at < 10 * 60_000) return cache.value;
    const value = await analyse(now);
    cache = { at: now, value };
    return value;
}

async function analyse(now = Date.now()) {
    const errors: string[] = [];
    const settle = async <T>(what: string, p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { errors.push(`${what}: ${(e as Error).message}`); return null; } };
    const table = gcpReadable() ? await settle("Google billing export", gcp.billingTable()) : null;
    const [aws, g, snap, grants, spend] = await Promise.all([
        settle("AWS", awsCosts(now, errors)),
        table ? settle("Google Cloud", gcpCosts(now, table)) : Promise.resolve(null),
        settle("vendors", snapshot(false)),
        listGrants(),
        engineOrNull<{ today: number; softCap: number; hardCap: number; rows: Array<{ day: string; role: string; model: string; calls: number; tokensIn: number; tokensOut: number; costInr: number }> }>("GET", "/spend?days=62"),
    ]);
    const platforms: Array<{ id: string; name: string; source: string; connected: boolean; note?: string; period: Period; gross?: Period; credits?: Period;
        netDaily: Record<string, number>; grossDaily: Record<string, number>; unit?: "credits"; allTime?: { amount: number; since: string | null; note: string };
        groups: Array<{ name: string; tag?: string; period: Period; gross?: Period; credits?: Period; lines: Line[]; creditTypes?: Line[] }>; extra?: unknown }> = [];

    // AWS
    if (aws) {
        const credit = aws.byType.Credit || {};
        const other = Object.entries(aws.byType).filter(([t]) => !["Usage", "Credit", "SavingsPlanRecurringFee", "RIFee"].includes(t));
        const gross = sumDaily(Object.values(aws.byService));
        const net = sumDaily([gross, credit, ...other.map(([, v]) => v)]);
        const lines: Line[] = Object.entries(aws.byService).map(([name, daily]) => ({ name, period: period(daily, now), daily,
            detail: aws.usage.filter((u) => u.service === name).slice(0, 12).map((u) => ({ label: u.usageType, value: `₹${u.inr.toLocaleString("en-IN")} · ${Math.round(u.quantity * 100) / 100} ${u.unit}` })) }))
            .sort((a, b) => b.period.mtd - a.period.mtd);
        for (const [t, daily] of other) lines.push({ name: t, period: period(daily, now), daily });
        platforms.push({
            id: "aws", name: "AWS", source: "Cost Explorer (the bill)", connected: true, netDaily: net, grossDaily: gross,
            period: period(net, now, aws.forecast.net != null ? period(net, now).mtd + aws.forecast.net : null),
            gross: period(gross, now, aws.forecast.gross != null ? period(gross, now).mtd + aws.forecast.gross : null), credits: period(credit, now),
            groups: [{ name: "Account 743887469650 (ap-south-1 and global)", period: period(net, now), lines }],
            extra: { usageTypes: aws.usage, creditsByMonth: aws.creditsByMonth, forecastFromAws: aws.forecast, recordTypes: Object.keys(aws.byType) },
        });
    } else platforms.push({ id: "aws", name: "AWS", source: "Cost Explorer", connected: false, note: "Cost Explorer did not answer", period: period({}, now), groups: [], netDaily: {}, grossDaily: {} });

    // Google Cloud
    if (g && !g.exportStarted) {
        platforms.push({ id: "gcp", name: "Google Cloud", source: "BigQuery billing export", connected: false, note: "Export is on; Google has not delivered the first rows yet (usually within a day)",
            period: period({}, now), groups: [], netDaily: {}, grossDaily: {} });
    } else if (g) {
        const groups = Object.entries(g.projects).map(([project, p]) => {
            const lines: Line[] = Object.entries(p.services).map(([name, s]) => {
                const net = sumDaily([s.gross, s.credits]);
                return { name, period: period(net, now), gross: period(s.gross, now), credits: period(s.credits, now), daily: net,
                    detail: g.skus.filter((k) => k.project === project && k.service === name).slice(0, 15).map((k) => ({ label: k.sku, value: `₹${k.gross.toLocaleString("en-IN")} before credits · ₹${(k.gross + k.credits).toLocaleString("en-IN")} after · ${Math.round(k.quantity * 100) / 100} ${k.unit}` })) };
            }).sort((a, b) => b.gross!.mtd - a.gross!.mtd);
            const gross = sumDaily(Object.values(p.services).map((s) => s.gross));
            const credits = sumDaily(Object.values(p.services).map((s) => s.credits));
            return { name: project, tag: PROJECT_TAG[project] || "other project", period: period(sumDaily([gross, credits]), now), gross: period(gross, now), credits: period(credits, now), lines,
                creditTypes: Object.entries(p.creditTypes).map(([t, daily]) => ({ name: CREDIT_TYPE[t] || t, period: period(daily, now), daily })) };
        }).sort((a, b) => (a.tag === "production" ? -1 : b.tag === "production" ? 1 : b.gross!.mtd - a.gross!.mtd));
        const all = (k: "gross" | "credits") => sumDaily(Object.values(g.projects).flatMap((p) => Object.values(p.services).map((s) => s[k])));
        platforms.push({
            id: "gcp", name: "Google Cloud", source: `BigQuery billing export (since ${g.exportStarted || "—"})`, connected: true,
            netDaily: sumDaily([all("gross"), all("credits")]), grossDaily: all("gross"),
            period: period(sumDaily([all("gross"), all("credits")]), now), gross: period(all("gross"), now), credits: period(all("credits"), now), groups,
            extra: { creditNames: g.creditNames, exportStarted: g.exportStarted, skus: g.skus },
        });
    } else platforms.push({ id: "gcp", name: "Google Cloud", source: "BigQuery billing export", connected: false,
        note: table ? "The billing export did not answer" : "No billing export rows yet (Google fills it within a few hours of switching it on)", period: period({}, now), groups: [], netDaily: {}, grossDaily: {} });

    // WhatsApp: Meta's pricing analytics, read directly (every conversation type, paid and free)
    const wa = await whatsappBill(62, now).catch(() => null);
    if (wa?.connected) {
        const rate = wa.currency === "USD" ? USD_INR : 1;
        const daily = Object.fromEntries(Object.entries(wa.daily).map(([k, v]) => [k, v * rate]));
        const cats = Object.entries(wa.byCategory).sort((a, b) => b[1].cost - a[1].cost);
        platforms.push({ id: "meta", name: "WhatsApp (Meta)", source: "Meta pricing analytics (the bill), last 62 days", connected: true, period: period(daily, now), netDaily: daily, grossDaily: daily,
            groups: [{ name: "WhatsApp Business account", period: period(daily, now), lines: [{ name: "Conversations and messages", period: period(daily, now), daily,
                detail: cats.map(([c, v]) => ({ label: c, value: `${v.volume.toLocaleString("en-IN")} messages · ₹${r2(v.cost * rate).toLocaleString("en-IN")} (62 days)` })) }] }] });
    } else platforms.push({ id: "meta", name: "WhatsApp (Meta)", source: "Meta pricing analytics", connected: false, note: wa?.note || "Meta did not answer", period: period({}, now), groups: [], netDaily: {}, grossDaily: {} });

    // Browser Use: every run's own cost since the account began (agent task cost + browser proxy cost, USD)
    const svc = (id: string) => snap?.services.find((s) => s.id === id);
    const [bu, buh] = await Promise.all([browserUseAccount().catch(() => null), browserUseHistory().catch(() => null)]);
    if (buh?.connected) {
        const task: Record<string, number> = {}, proxy: Record<string, number> = {}, runs: Record<string, number> = {};
        let usd = 0, failed = 0;
        for (const [d, x] of Object.entries(buh.daily)) {
            task[d] = x.taskUsd * USD_INR; proxy[d] = x.proxyUsd * USD_INR; runs[d] = x.tasks; usd += x.taskUsd + x.proxyUsd; failed += x.failed;
        }
        const daily = sumDaily([task, proxy]);
        platforms.push({ id: "browser-use", name: "Browser Use", source: "Every run's own cost (agent tasks + browser proxy), since the account began", connected: true,
            period: period(daily, now), netDaily: daily, grossDaily: daily,
            allTime: { amount: r2(usd * USD_INR), since: buh.firstAt, note: `$${r2(usd)} over ${buh.tasks} agent runs (${failed} failed) and ${buh.sessions} browser sessions` },
            groups: [{ name: "Browser Use account", period: period(daily, now), lines: [
                { name: "Agent runs (orders, rides, checks)", period: period(task, now), daily: task, detail: [
                    { label: "All time", value: `$${r2(Object.values(buh.daily).reduce((t, x) => t + x.taskUsd, 0))} · ${buh.tasks} runs · ${failed} failed` },
                    { label: "Runs this month", value: String(Object.entries(runs).filter(([d]) => d.startsWith(days(now).month)).reduce((t, [, v]) => t + v, 0)) }] },
                { name: "Browser proxy (Indian IPs)", period: period(proxy, now), daily: proxy, detail: [
                    { label: "All time", value: `$${r2(Object.values(buh.daily).reduce((t, x) => t + x.proxyUsd, 0))} · ${Math.round(Object.values(buh.daily).reduce((t, x) => t + x.proxyMb, 0))} MB · ${buh.sessions} sessions` }] },
                ...(bu?.connected ? [{ name: "Balance", period: period({}, now), daily: {}, detail: [{ label: "Credit left now", value: `$${bu.balanceUsd?.toFixed(2)} (₹${Math.round((bu.balanceUsd ?? 0) * USD_INR).toLocaleString("en-IN")})` }] }] : []),
            ] }] });
    } else platforms.push({ id: "browser-use", name: "Browser Use", source: "Browser Use run records", connected: false, note: buh?.note || "Browser Use did not answer", period: period({}, now), groups: [], netDaily: {}, grossDaily: {} });

    // ElevenLabs: credits, not ₹ (the plan fee is not readable with the voice key). API = Kavach's backend.
    const el = await elevenLabsUsage(now).catch(() => null);
    const api = el?.bySource?.API || {};
    const web = el?.bySource?.Website || {};
    const prod = (k: string) => Object.fromEntries(Object.entries(el?.daily || {}).map(([d, v]) => [d, v[k] || 0]));
    platforms.push({ id: "elevenlabs", name: "ElevenLabs", source: "Usage log in credits (the plan's ₹ fee is not readable with the voice key)", connected: !!el?.connected, unit: "credits",
        note: el?.connected ? "Credits, not ₹; not added to the ₹ totals" : el?.note, period: period(sumDaily([api, web]), now), netDaily: {}, grossDaily: {},
        allTime: { amount: Object.values(api).reduce((a, b) => a + b, 0), since: Object.keys(api).sort()[0] || null, note: "credits through the API (Kavach) in the last 60 days" },
        groups: [{ name: "Where the credits went", period: period(sumDaily([api, web]), now), lines: [
            { name: "Kavach (through the API)", unit: "credits", period: period(api, now), daily: api },
            { name: "ElevenLabs website (people, not Kavach)", unit: "credits", period: period(web, now), daily: web },
            { name: "Spoken replies (text-to-speech, all sources)", unit: "credits", period: period(prod("TTS"), now), daily: prod("TTS") },
            { name: "Voice notes (speech-to-text, all sources)", unit: "credits", period: period(prod("STT"), now), daily: prod("STT") },
            { name: "Models used (30 days, all sources)", unit: "credits", period: period({}, now), daily: {}, detail: (el?.models || []).slice(0, 20).map((m) => ({ label: m.model, value: `${m.last30.toLocaleString("en-IN")} credits` })) },
        ] }] });

    for (const [id, name, rowId, source] of [["resend", "Resend", "resend", "Email; usage not readable with a send-only key"], ["cloudflare", "Cloudflare", "cloudflare", "R2 and the uptime Worker; billing not connected (free limits so far)"]] as const) {
        const s = svc(rowId);
        platforms.push({ id, name, source, connected: false, note: "no bill to read", period: period({}, now), netDaily: {}, grossDaily: {},
            groups: [{ name, period: period({}, now), lines: [{ name: s?.name || name, period: period({}, now), daily: {}, detail: (s?.facts || []).map((f) => ({ label: f.label, value: f.value })) }] }] });
    }

    // Engine model ledger (metered; Gemini is on the Google bill, so it is shown for detail and not added again)
    const ledgerDaily: Record<string, number> = {};
    const month = days(now).month;
    const byRole: Record<string, { calls: number; tokensIn: number; tokensOut: number; inr: number }> = {};
    const byModel: Record<string, { calls: number; tokensIn: number; tokensOut: number; inr: number }> = {};
    for (const x of spend.data?.rows || []) {
        add(ledgerDaily, x.day, x.costInr);
        if (!x.day.startsWith(month)) continue;
        for (const [m, k] of [[byRole, x.role], [byModel, x.model]] as const) {
            const o = (m[k] ??= { calls: 0, tokensIn: 0, tokensOut: 0, inr: 0 });
            o.calls += x.calls; o.tokensIn += x.tokensIn; o.tokensOut += x.tokensOut; o.inr = r2(o.inr + x.costInr);
        }
    }
    const models = { period: period(ledgerDaily, now), daily: ledgerDaily, byRole, byModel, caps: { today: spend.data?.today ?? null, soft: spend.data?.softCap ?? null, hard: spend.data?.hardCap ?? null },
        note: "The engine's own estimate of live model calls (tokens × list price). Gemini is billed on Google Cloud, so this is detail, not added to totals." };

    // Credits: what each provider applied, and what is left of each grant the team entered
    const used = (provider: string, project: string | null, from: Date, to: Date | null): number | null => {
        const inRange = (day: string) => day >= istDay(from) && (!to || day <= istDay(to));
        if (provider === "AWS") {
            if (!aws) return null;
            const months = Object.entries(aws.creditsByMonth).filter(([m]) => m >= istDay(from).slice(0, 7));
            return r2(months.reduce((t, [, v]) => t + v, 0)); // monthly granularity from Cost Explorer
        }
        if (provider === "GCP") {
            if (!g) return null;
            let t = 0;
            for (const [p, proj] of Object.entries(g.projects)) {
                if (project && p !== project) continue;
                for (const [type, daily] of Object.entries(proj.creditTypes)) {
                    if (type !== "PROMOTION") continue;
                    for (const [day, v] of Object.entries(daily)) if (inRange(day)) t += -v;
                }
            }
            return r2(t);
        }
        if (provider === "Browser Use") return null; // worked out from the balance below
        return null;
    };
    const buBalance = (platforms.find((p) => p.id === "browser-use")?.groups[0]?.lines.find((l) => l.name === "Balance")?.detail?.[0]?.value || "").match(/\$([\d.]+)/);
    const credits = grants.map((gr) => {
        const amount = gr.amount * (gr.currency === "USD" ? USD_INR : 1);
        // Browser Use: what was topped up minus the balance left is what was spent
        const u = gr.provider === "Browser Use" && buBalance ? r2(amount - Number(buBalance[1]) * USD_INR)
            : used(gr.provider, gr.project, new Date(gr.startsAt), gr.expiresAt ? new Date(gr.expiresAt) : null);
        const platform = platforms.find((p) => p.name.startsWith(gr.provider) || p.id === gr.provider.toLowerCase());
        const burn = platform?.credits ? -platform.credits.avgDay7 : null;
        const left = u != null ? r2(amount - u) : null;
        return { grantId: gr.grantId, provider: gr.provider, project: gr.project, label: gr.label, amount: gr.amount, currency: gr.currency, amountInr: r2(amount),
            startsAt: gr.startsAt, expiresAt: gr.expiresAt, note: gr.note, used: u, left, burnPerDay: burn != null ? r2(burn) : null,
            daysLeft: left != null && burn && burn > 0 ? Math.floor(left / burn) : null,
            expiresInDays: gr.expiresAt ? Math.ceil((new Date(gr.expiresAt).getTime() - now) / 86_400_000) : null };
    });

    const totalDaily = sumDaily(platforms.map((p) => p.netDaily));
    const grossDaily = sumDaily(platforms.map((p) => p.grossDaily));
    const awsF = platforms.find((p) => p.id === "aws");
    const forecastTotal = r2(platforms.reduce((t, p) => t + p.period.forecast, 0));
    return {
        at: new Date(now).toISOString(), usdInr: USD_INR, errors,
        total: { ...period(totalDaily, now), forecast: forecastTotal }, gross: period(grossDaily, now),
        creditsApplied: r2((awsF?.credits?.mtd ?? 0) + (platforms.find((p) => p.id === "gcp")?.credits?.mtd ?? 0)),
        daily: Object.entries(totalDaily).sort().map(([day, v]) => ({ day, net: r2(v), gross: r2(grossDaily[day] ?? 0) })),
        platforms, models, credits,
    };
}
