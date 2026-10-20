/**
 * AWS: daily cost per service from Cost Explorer, with a read-only billing key (AWS_BILLING_ACCESS_KEY_ID /
 * AWS_BILLING_SECRET_ACCESS_KEY; IAM policy: ce:GetCostAndUsage only). Signed with AWS Signature V4, no SDK.
 */
import { createHash, createHmac } from "crypto";
import { USD_INR, istDay } from "./pricing";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

export type SignInput = {
    method: string; host: string; path: string; query?: string; headers: Record<string, string>; body: string;
    region: string; service: string; accessKey: string; secretKey: string; amzDate: string; // YYYYMMDDTHHMMSSZ
};

/** AWS Signature Version 4: returns the Authorization header value. */
export function sigv4(i: SignInput): string {
    const date = i.amzDate.slice(0, 8);
    const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: i.host, "x-amz-date": i.amzDate };
    const names = Object.keys(headers).sort();
    const canonical = [i.method, i.path, i.query || "", names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), sha(i.body)].join("\n");
    const scope = `${date}/${i.region}/${i.service}/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", i.amzDate, scope, sha(canonical)].join("\n");
    const key = hmac(hmac(hmac(hmac(`AWS4${i.secretKey}`, date), i.region), i.service), "aws4_request");
    return `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${createHmac("sha256", key).update(toSign).digest("hex")}`;
}

export type AwsBill = { connected: boolean; daily: Record<string, number>; byService: Record<string, Record<string, number>>; credits: Record<string, number>; note?: string };

export function awsConfigured(): boolean {
    return !!process.env.AWS_BILLING_ACCESS_KEY_ID && !!process.env.AWS_BILLING_SECRET_ACCESS_KEY;
}

export type Creds = { accessKey: string; secretKey: string; token?: string };

/** The ECS task role. Absent when this process is not on Fargate. */
export async function taskCreds(): Promise<Creds | null> {
    const rel = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    if (!rel) return null;
    const res = await fetch(`http://169.254.170.2${rel}`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string };
    if (!j.AccessKeyId || !j.SecretAccessKey) return null;
    return { accessKey: j.AccessKeyId, secretKey: j.SecretAccessKey, token: j.Token };
}

async function ecsJson<T>(target: string, body: unknown, creds: Creds): Promise<T> {
    const host = "ecs.ap-south-1.amazonaws.com";
    const payload = JSON.stringify(body);
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.1", "x-amz-target": target };
    if (creds.token) headers["x-amz-security-token"] = creds.token;
    const auth = sigv4({ method: "POST", host, path: "/", headers, body: payload, region: "ap-south-1", service: "ecs", accessKey: creds.accessKey, secretKey: creds.secretKey, amzDate });
    const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body: payload, signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`ECS ${res.status}`);
    return (await res.json()) as T;
}

export type EcsService = {
    name: string; desired: number; running: number; pending: number; rollout: string | null; taskDef: string;
    deployedAt: string | null; deploying: boolean; lastEvent: { at: string; text: string } | null;
};

const iso = (v: unknown): string | null => {
    if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
    if (typeof v === "string" && v) return new Date(v).toISOString();
    return null;
};

/**
 * Live services in cluster kavach. Null when this process cannot read ECS. ListServices takes no cluster-scoped
 * permission in IAM, so when it is refused the known service names are described directly (DescribeServices is allowed
 * on service/kavach/*).
 */
export async function ecsServices(known: string[] = []): Promise<EcsService[] | null> {
    const creds = await taskCreds();
    if (!creds) return null;
    let names: string[] = [];
    try {
        const listed = await ecsJson<{ serviceArns?: string[] }>("AmazonEC2ContainerServiceV20141113.ListServices", { cluster: "kavach" }, creds);
        names = listed.serviceArns || [];
    } catch {
        names = known;
    }
    if (!names.length) return [];
    type Described = {
        serviceName?: string; desiredCount?: number; runningCount?: number; pendingCount?: number; taskDefinition?: string;
        deployments?: Array<{ status?: string; rolloutState?: string; updatedAt?: number | string; createdAt?: number | string }>;
        events?: Array<{ createdAt?: number | string; message?: string }>;
    };
    const described = await ecsJson<{ services?: Described[] }>(
        "AmazonEC2ContainerServiceV20141113.DescribeServices", { cluster: "kavach", services: names.slice(0, 10) }, creds);
    return (described.services || []).map((s) => {
        const primary = s.deployments?.find((d) => d.status === "PRIMARY");
        const ev = s.events?.[0];
        return {
            name: s.serviceName || "",
            desired: s.desiredCount ?? 0,
            running: s.runningCount ?? 0,
            pending: s.pendingCount ?? 0,
            rollout: primary?.rolloutState || null,
            taskDef: (s.taskDefinition || "").split("/").pop() || "",
            deployedAt: iso(primary?.createdAt),
            deploying: (s.deployments?.length ?? 0) > 1,
            lastEvent: ev?.message ? { at: iso(ev.createdAt) || "", text: ev.message.replace(/^\(service [^)]+\)\s*/, "").slice(0, 200) } : null,
        };
    });
}

export type ReplyHour = { at: string; p50Ms: number | null; p90Ms: number | null; turns: number };

export type Slo = {
    uptime: boolean | null;
    replyP50Ms: number | null;
    replyP90Ms: number | null;
    replyHours: ReplyHour[];
    digest: string | null;
    singaporeCalls: number | null;
    deliveryRate: number | null;
    alertsOnTime: boolean | null;
};

export type DayDigest = {
    calls: number;
    throttles: number;
    brainP90Ms: number | null;
    replyP50Ms: number | null;
    replyP90Ms: number | null;
    turns: number;
    singapore: number;
};

function lastValue(values?: number[]): number | null {
    if (!values?.length) return null;
    const n = values[values.length - 1];
    return Number.isFinite(n) ? n : null;
}

function sumValues(values?: number[]): number {
    return (values || []).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

/** Worst of the returned p90 points. Two buckets can appear when the window does not sit on a period boundary. */
function worst(values?: number[]): number | null {
    const nums = (values || []).filter((n) => Number.isFinite(n));
    return nums.length ? Math.max(...nums) : null;
}

const seconds = (n: number | string): number => {
    if (typeof n === "number") return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(n);
    return Number.isFinite(parsed) ? parsed : 0;
};

export function digestLine(d: DayDigest): string {
    const s = (n: number | null) => (n == null ? "no samples" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
    return `Gemini last 24 hours (a small blip stays on this line, it is not mailed): ${d.calls} calls, ${d.throttles} throttles, worst brain hour p90 ${s(d.brainP90Ms)}. Reply time last hour: median ${s(d.replyP50Ms)}, p90 ${s(d.replyP90Ms)} over ${d.turns} turns. ${d.singapore} calls went to Singapore today.`;
}

/** IST midnight as a UTC epoch ms. CloudWatch hours sit on UTC, so a count from here misses at most the first half hour. */
function istMidnight(now: number): number {
    const shift = 330 * 60_000;
    const ist = new Date(now + shift);
    return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - shift;
}

function sumSince(rows: Map<string, MetricRow>, prefix: string, fromMs: number): number {
    const labeled = [...rows.entries()].filter(([id]) => id.startsWith(`${prefix} `));
    const use = labeled.length ? labeled : [...rows.entries()].filter(([id]) => id === prefix);
    let n = 0;
    for (const [, row] of use) {
        const times = row.Timestamps || [];
        const vals = row.Values || [];
        for (let i = 0; i < times.length && i < vals.length; i++) {
            if (seconds(times[i]) >= fromMs && Number.isFinite(vals[i])) n += vals[i];
        }
    }
    return Math.round(n);
}

type MetricRow = { Id?: string; Values?: number[]; Timestamps?: Array<number | string> };

function stat(id: string, namespace: string, metric: string, period: number, s: string, role?: string) {
    const dimensions = role ? { Dimensions: [{ Name: "Role", Value: role }] } : {};
    return { Id: id, ReturnData: true, MetricStat: { Metric: { Namespace: namespace, MetricName: metric, ...dimensions }, Period: period, Stat: s } };
}

/** Last day from CloudWatch. Reply time is the backend's message-in to reply-out. Null off Fargate or when CloudWatch does not answer. */
export async function slo(now = Date.now()): Promise<Slo | null> {
    const creds = await taskCreds();
    if (!creds) return null;
    const end = Math.floor(now / 1000);
    const body = JSON.stringify({
        StartTime: end - 86_400, EndTime: end,
        MetricDataQueries: [
            stat("p50", "Kavach/Live", "reply-ms", 3600, "p50"),
            stat("p90", "Kavach/Live", "reply-ms", 3600, "p90"),
            stat("turns", "Kavach/Live", "reply-ms", 3600, "SampleCount"),
            stat("sent", "Kavach/Delivery", "Sent", 3600, "Sum"),
            stat("failed", "Kavach/Delivery", "Failed", 3600, "Sum"),
            stat("ticks", "Kavach/Live", "reminder-ticks", 900, "Sum"),
            stat("gCalls", "Kavach/Gemini", "Calls", 3600, "Sum"),
            stat("gThrottles", "Kavach/Gemini", "Throttles", 3600, "Sum"),
            stat("gBrain", "Kavach/Gemini", "LatencyMs", 3600, "p90", "brain"),
            stat("gHard", "Kavach/Gemini", "LatencyMs", 3600, "p90", "brain_hard"),
            { Id: "sgp", Expression: "SEARCH('{Kavach/Gemini,Role,Region} MetricName=\"Calls\" Region=\"asia-southeast1\"', 'Sum', 3600)", ReturnData: true },
            { Id: "healthy", Expression: "SEARCH('{AWS/ApplicationELB,LoadBalancer} MetricName=\"HealthyHostCount\"', 'Average', 300)", ReturnData: true },
        ],
    });
    const host = "monitoring.ap-south-1.amazonaws.com";
    const amzDate = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers: Record<string, string> = { "content-type": "application/x-amz-json-1.0", "x-amz-target": "GraniteServiceVersion20100801.GetMetricData" };
    if (creds.token) headers["x-amz-security-token"] = creds.token;
    try {
        const auth = sigv4({ method: "POST", host, path: "/", headers, body, region: "ap-south-1", service: "monitoring", accessKey: creds.accessKey, secretKey: creds.secretKey, amzDate });
        const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return null;
        const data = (await res.json()) as { MetricDataResults?: MetricRow[] };
        const rows = new Map((data.MetricDataResults || []).map((r) => [r.Id || "", r]));
        const values = (id: string) => rows.get(id)?.Values;
        const sent = lastValue(values("sent")) ?? 0;
        const failed = lastValue(values("failed")) ?? 0;
        const healthy = [...rows.entries()].filter(([id]) => id === "healthy" || id.startsWith("healthy"));
        const up = healthy.some(([, row]) => (lastValue(row.Values) ?? 0) > 0);
        const ticks = lastValue(values("ticks"));
        const byAt = new Map<number, ReplyHour>();
        const take = (id: string, put: (hour: ReplyHour, n: number) => void) => {
            const row = rows.get(id);
            const times = row?.Timestamps || [];
            const nums = row?.Values || [];
            for (let i = 0; i < times.length && i < nums.length; i++) {
                const at = seconds(times[i]);
                if (!at || !Number.isFinite(nums[i])) continue;
                const hour = byAt.get(at) || { at: new Date(at).toISOString(), p50Ms: null, p90Ms: null, turns: 0 };
                put(hour, nums[i]);
                byAt.set(at, hour);
            }
        };
        take("p50", (hour, n) => { hour.p50Ms = n; });
        take("p90", (hour, n) => { hour.p90Ms = n; });
        take("turns", (hour, n) => { hour.turns = n; });
        const replyHours = [...byAt.entries()].sort((a, b) => a[0] - b[0]).map(([, hour]) => hour);
        const latest = [...replyHours].reverse().find((hour) => hour.turns > 0) ?? replyHours[replyHours.length - 1];
        const brainP90 = worst([...(values("gBrain") || []), ...(values("gHard") || [])]);
        const singaporeCalls = sumSince(rows, "sgp", istMidnight(now));
        const digest = digestLine({
            calls: sumValues(values("gCalls")),
            throttles: sumValues(values("gThrottles")),
            brainP90Ms: brainP90,
            replyP50Ms: latest?.p50Ms ?? null,
            replyP90Ms: latest?.p90Ms ?? null,
            turns: latest?.turns ?? 0,
            singapore: singaporeCalls,
        });
        return {
            uptime: healthy.length ? up : null,
            replyP50Ms: latest?.p50Ms ?? null,
            replyP90Ms: latest?.p90Ms ?? null,
            replyHours,
            digest,
            singaporeCalls,
            deliveryRate: sent + failed > 0 ? sent / (sent + failed) : null,
            alertsOnTime: ticks == null ? null : ticks >= 3,
        };
    } catch {
        return null;
    }
}

/** Timed work on the AWS copy. The backend tick also sends the daily snapshot after 21:00 IST. */
export const AWS_SCHEDULES: Array<{ name: string; schedule: string; owner: "backend" | "cron"; job: string | null }> = [
    { name: "Care reminders", schedule: "* * * * *", owner: "backend", job: null },
    { name: "Task runner", schedule: "* * * * *", owner: "cron", job: "tasks" },
    { name: "Saheli wake", schedule: "*/5 * * * *", owner: "cron", job: "wake" },
    { name: "Browser sweep", schedule: "*/10 * * * *", owner: "cron", job: "browser-sweep" },
    { name: "Fact extract", schedule: "*/30 * * * *", owner: "cron", job: "extract" },
    { name: "Saheli's night", schedule: "0 2 * * *", owner: "cron", job: "dream" },
    { name: "Memory consolidate", schedule: "15 2 * * *", owner: "cron", job: "consolidate" },
    { name: "Elder reflection", schedule: "30 2 * * *", owner: "cron", job: null },
    { name: "Replay gate", schedule: "30 3 * * *", owner: "cron", job: null },
    { name: "Morning report", schedule: "0 8 * * *", owner: "cron", job: "morning-report" },
    { name: "Daily jobs", schedule: "0 10 * * *", owner: "cron", job: "daily" },
    { name: "Weekly learning", schedule: "0 8 * * 0", owner: "cron", job: "weekly" },
];

/** Cost per AWS service per day (UTC days from Cost Explorer, close enough to IST for a daily view). */
export async function awsBill(days: number, now = Date.now()): Promise<AwsBill> {
    if (!awsConfigured()) return { connected: false, daily: {}, byService: {}, credits: {}, note: "No AWS billing key yet" };
    const host = "ce.us-east-1.amazonaws.com";
    const start = new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(now + 86_400_000).toISOString().slice(0, 10);
    const body = JSON.stringify({
        TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }, { Type: "DIMENSION", Key: "RECORD_TYPE" }],
    });
    const amzDate = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const headers = { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSInsightsIndexService.GetCostAndUsage" };
    const auth = sigv4({ method: "POST", host, path: "/", headers, body, region: "us-east-1", service: "ce", accessKey: process.env.AWS_BILLING_ACCESS_KEY_ID!, secretKey: process.env.AWS_BILLING_SECRET_ACCESS_KEY!, amzDate });
    try {
        const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body, signal: AbortSignal.timeout(15_000) });
        type R = { ResultsByTime?: Array<{ TimePeriod: { Start: string }; Groups?: Array<{ Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }> }>; message?: string; Message?: string };
        const data = (await res.json().catch(() => ({}))) as R;
        if (!res.ok) return { connected: false, daily: {}, byService: {}, credits: {}, note: (data.message || data.Message || `AWS answered ${res.status}`).slice(0, 200) };
        const out: AwsBill = { connected: true, daily: {}, byService: {}, credits: {} };
        for (const t of data.ResultsByTime || []) {
            const day = istDay(new Date(`${t.TimePeriod.Start}T12:00:00Z`));
            for (const g of t.Groups || []) {
                const [service, recordType] = g.Keys;
                const amt = Number(g.Metrics.UnblendedCost.Amount) * (g.Metrics.UnblendedCost.Unit === "USD" ? USD_INR : 1);
                if (recordType === "Credit") out.credits[day] = (out.credits[day] ?? 0) + amt;
                else {
                    out.daily[day] = (out.daily[day] ?? 0) + amt;
                    (out.byService[service] ??= {})[day] = ((out.byService[service] ?? {})[day] ?? 0) + amt;
                }
            }
        }
        return out;
    } catch {
        return { connected: false, daily: {}, byService: {}, credits: {}, note: "AWS didn't answer" };
    }
}
