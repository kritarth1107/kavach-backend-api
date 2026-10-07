/**
 * Money and days for the Infrastructure pages: INR everywhere, IST days, and list-price estimates for when a
 * provider's real bill isn't connected. Estimates are labelled as such in the console; billed numbers win.
 *
 * Cloud Run, asia-south1 (Tier 2), list prices (https://cloud.google.com/run/pricing):
 *   instance-based (CPU always allocated): $0.0000216 / vCPU-s, $0.0000024 / GiB-s
 *   request-based: $0.0000336 / vCPU-s, $0.0000035 / GiB-s, $0.40 / million requests
 * The monthly free tier (per billing account) is ignored, so estimates run slightly high.
 */
export const USD_INR = Number(process.env.INFRA_USD_INR) || 88; // same rate the engine uses for model prices

export const RUN_PRICE = {
    instance: { cpu: 0.0000216, gib: 0.0000024 },
    request: { cpu: 0.0000336, gib: 0.0000035, perMillionRequests: 0.4 },
};

/** Cloud SQL (Enterprise, zonal) per hour by tier, Mumbai list price in USD; storage per GB-month. */
export const SQL_TIER_USD_HOUR: Record<string, number> = {
    "db-f1-micro": 0.0126,
    "db-g1-small": 0.0347,
};
export const SQL_SSD_USD_GB_MONTH = 0.204;
export const ARTIFACT_USD_GB_MONTH = 0.1; // first 0.5 GB free
export const SCHEDULER_USD_JOB_MONTH = 0.1; // first 3 jobs free
export const PD_STANDARD_USD_GB_MONTH = 0.048;
export const PD_BALANCED_USD_GB_MONTH = 0.12;
export const LB_RULE_USD_HOUR = 0.025; // global external Application Load Balancer, per forwarding rule
/** Firestore Enterprise (us-central1 list; https://cloud.google.com/firestore/enterprise/pricing). */
export const FIRESTORE = { readPerMillion: 0.05, writePerMillion: 0.26, gibMonth: 0.24 };

export const inr = (usd: number) => usd * USD_INR;
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-10-07" for the IST calendar day of a moment. */
export function istDay(d: Date | number = Date.now()): string {
    return new Date(new Date(d).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/** The UTC moment an IST day starts. */
export function istMidnight(day: string): Date {
    return new Date(new Date(`${day}T00:00:00Z`).getTime() - 5.5 * 3_600_000);
}

/** The last `n` IST days, oldest first, ending today. */
export function lastDays(n: number, now = Date.now()): string[] {
    const today = istMidnight(istDay(now)).getTime();
    return Array.from({ length: n }, (_, i) => istDay(today + 6 * 3_600_000 - (n - 1 - i) * 86_400_000));
}

export function daysInMonth(day: string): number {
    const [y, m] = day.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Per-month cost spread over days: what a fixed monthly charge costs per day. */
export const perDay = (monthly: number, day: string) => monthly / daysInMonth(day);

export type Totals = { today: number | null; yesterday: number | null; mtd: number | null; forecast: number | null; avg7: number | null };

/**
 * Today, yesterday, month to date and a month forecast from a daily series (IST days → INR).
 * Forecast = complete days this month + the last 7 complete days' average × the rest of the month (today included,
 * because today is still running).
 */
export function totals(daily: Record<string, number>, now = Date.now()): Totals {
    const today = istDay(now);
    const days = Object.keys(daily);
    if (!days.length) return { today: null, yesterday: null, mtd: null, forecast: null, avg7: null };
    const yesterday = istDay(istMidnight(today).getTime() - 12 * 3_600_000);
    const month = today.slice(0, 7);
    const complete = days.filter((d) => d < today).sort();
    const last7 = complete.slice(-7);
    const avg7 = last7.length ? last7.reduce((s, d) => s + daily[d], 0) / last7.length : daily[today] ?? 0;
    const doneThisMonth = complete.filter((d) => d.startsWith(month));
    const doneSum = doneThisMonth.reduce((s, d) => s + daily[d], 0);
    const remaining = daysInMonth(today) - doneThisMonth.length;
    return {
        today: round2(daily[today] ?? 0),
        yesterday: daily[yesterday] != null ? round2(daily[yesterday]) : complete.some((d) => d < yesterday) ? 0 : null, // nothing ran = ₹0
        mtd: round2(doneSum + (daily[today] ?? 0)),
        forecast: round2(doneSum + avg7 * remaining),
        avg7: round2(avg7),
    };
}

/** Adds daily series together. */
export function sumDaily(series: Array<Record<string, number> | null | undefined>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of series) for (const [d, v] of Object.entries(s || {})) out[d] = (out[d] ?? 0) + v;
    return out;
}

/** Cloud Run cost for billable instance-seconds of one service. */
export function runCostUsd(seconds: number, cpu: number, gib: number, alwaysOn: boolean, requests = 0): number {
    if (alwaysOn) return seconds * (cpu * RUN_PRICE.instance.cpu + gib * RUN_PRICE.instance.gib);
    return seconds * (cpu * RUN_PRICE.request.cpu + gib * RUN_PRICE.request.gib) + (requests / 1e6) * RUN_PRICE.request.perMillionRequests;
}

/** "2" → 2, "1000m" → 1; "4Gi" → 4, "512Mi" → 0.5. */
export function parseCpu(v: string | undefined): number {
    if (!v) return 1;
    return v.endsWith("m") ? Number(v.slice(0, -1)) / 1000 : Number(v) || 1;
}
export function parseGib(v: string | undefined): number {
    if (!v) return 0.5;
    const n = parseFloat(v);
    if (v.endsWith("Gi")) return n;
    if (v.endsWith("Mi")) return n / 1024;
    if (v.endsWith("G")) return (n * 1e9) / 2 ** 30;
    if (v.endsWith("M")) return (n * 1e6) / 2 ** 30;
    return n / 2 ** 30;
}
