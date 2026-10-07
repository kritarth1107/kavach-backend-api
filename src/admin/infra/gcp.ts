/**
 * Google Cloud: what's running (Cloud Run, jobs, schedules, databases, storage, network) and what it costs.
 * Cost comes from the BigQuery billing export when it is connected (exact, per Google service, per day); until
 * then from usage metrics × list prices (pricing.ts), clearly marked as estimates.
 */
import { gapi, gapiAll } from "./google";
import { istDay, istMidnight, lastDays, parseCpu, parseGib } from "./pricing";

export const PROJECT = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || "kavach-care";
export const REGION = process.env.INFRA_GCP_REGION || "asia-south1";
const RUN = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}`;

/** Only these environment settings are read from service configs (model names, never secrets). */
const ENV_ALLOW = new Set(["VERTEX_STT_MODEL", "VERTEX_VISION_MODEL", "BROWSER_AGENT_MODEL", "VERTEX_EMBEDDING_MODEL", "LLM_PROVIDER"]);
/** Setting names that usually hold a secret; flagged when stored as plain text instead of Secret Manager. */
const SECRETISH = /(SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL|MONGODB_URI)$/;
const NOT_SECRET = /(PUBLIC|VERIFY_TOKEN_NAME)/;

export type RunService = {
    name: string; uri: string; revision: string; updatedAt: string | null; updatedBy: string | null; ready: boolean;
    cpu: number; memoryGib: number; minInstances: number; maxInstances: number | null; concurrency: number | null;
    alwaysOn: boolean; ingress: string; publicAccess: boolean | null; env: Record<string, string>;
    /** Names (never values) of settings that look like secrets but are stored as plain text. */
    plainSecrets: string[];
};

type RunV2Service = {
    name: string; uri?: string; latestReadyRevision?: string; updateTime?: string; lastModifier?: string; ingress?: string;
    invokerIamDisabled?: boolean; terminalCondition?: { state?: string };
    template?: {
        scaling?: { minInstanceCount?: number; maxInstanceCount?: number }; maxInstanceRequestConcurrency?: number;
        containers?: Array<{ resources?: { limits?: Record<string, string>; cpuIdle?: boolean }; env?: Array<{ name: string; value?: string; valueSource?: unknown }> }>;
    };
};

export async function runServices(): Promise<RunService[]> {
    const list = await gapiAll<RunV2Service>(`${RUN}/services`, "services");
    return list.map((s) => {
        const c = s.template?.containers?.[0];
        const env: Record<string, string> = {};
        for (const e of c?.env || []) if (ENV_ALLOW.has(e.name) && e.value) env[e.name] = e.value.slice(0, 80);
        const plainSecrets = (c?.env || []).filter((e) => !e.valueSource && !!e.value && SECRETISH.test(e.name) && !NOT_SECRET.test(e.name)).map((e) => e.name);
        return {
            name: s.name.split("/").pop()!,
            uri: s.uri || "",
            revision: (s.latestReadyRevision || "").split("/").pop() || "",
            updatedAt: s.updateTime || null,
            updatedBy: s.lastModifier || null,
            ready: s.terminalCondition?.state === "CONDITION_SUCCEEDED",
            cpu: parseCpu(c?.resources?.limits?.cpu),
            memoryGib: parseGib(c?.resources?.limits?.memory),
            minInstances: s.template?.scaling?.minInstanceCount ?? 0,
            maxInstances: s.template?.scaling?.maxInstanceCount ?? null,
            concurrency: s.template?.maxInstanceRequestConcurrency ?? null,
            alwaysOn: c?.resources?.cpuIdle === false,
            ingress: (s.ingress || "").replace("INGRESS_TRAFFIC_", "").toLowerCase(),
            publicAccess: s.invokerIamDisabled ?? null,
            env,
            plainSecrets,
        };
    });
}

export type RunJob = { name: string; lastRunAt: string | null; lastStatus: string | null; cpu: number; memoryGib: number };

export async function runJobs(): Promise<RunJob[]> {
    type J = { name: string; latestCreatedExecution?: { createTime?: string; completionStatus?: string }; template?: { template?: { containers?: Array<{ resources?: { limits?: Record<string, string> } }> } } };
    const list = await gapiAll<J>(`${RUN}/jobs`, "jobs");
    return list.map((j) => ({
        name: j.name.split("/").pop()!,
        lastRunAt: j.latestCreatedExecution?.createTime || null,
        lastStatus: j.latestCreatedExecution?.completionStatus?.replace("EXECUTION_", "").toLowerCase() || null,
        cpu: parseCpu(j.template?.template?.containers?.[0]?.resources?.limits?.cpu),
        memoryGib: parseGib(j.template?.template?.containers?.[0]?.resources?.limits?.memory),
    }));
}

export type Schedule = { name: string; schedule: string; timeZone: string; state: string; lastAttemptAt: string | null; failed: boolean };

export async function schedules(): Promise<Schedule[]> {
    type S = { name: string; schedule?: string; timeZone?: string; state?: string; lastAttemptTime?: string; status?: { code?: number } };
    const list = await gapiAll<S>(`https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/jobs`, "jobs");
    return list.map((j) => ({
        name: j.name.split("/").pop()!,
        schedule: j.schedule || "",
        timeZone: j.timeZone || "UTC",
        state: (j.state || "").toLowerCase(),
        lastAttemptAt: j.lastAttemptTime || null,
        // Scheduler reports the last attempt's gRPC code; 0/absent = fine. No attempt yet is not a failure.
        failed: !!j.lastAttemptTime && !!j.status?.code && j.status.code > 0,
    }));
}

export type SqlInstance = { name: string; version: string; tier: string; state: string; diskGb: number; diskType: string; region: string; backups: boolean; highAvailability: boolean };

export async function sqlInstances(): Promise<SqlInstance[]> {
    type I = { name: string; databaseVersion?: string; state?: string; region?: string; settings?: { tier?: string; dataDiskSizeGb?: string; dataDiskType?: string; availabilityType?: string; backupConfiguration?: { enabled?: boolean } } };
    const r = await gapi<{ items?: I[] }>(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances`);
    return (r.items || []).map((i) => ({
        name: i.name, version: i.databaseVersion || "", tier: i.settings?.tier || "", state: (i.state || "").toLowerCase(),
        diskGb: Number(i.settings?.dataDiskSizeGb || 0), diskType: i.settings?.dataDiskType || "", region: i.region || "",
        backups: !!i.settings?.backupConfiguration?.enabled, highAvailability: i.settings?.availabilityType === "REGIONAL",
    }));
}

export type FirestoreDb = { name: string; location: string; type: string; edition: string };

export async function firestoreDbs(): Promise<FirestoreDb[]> {
    type D = { name: string; locationId?: string; type?: string; databaseEdition?: string };
    const r = await gapi<{ databases?: D[] }>(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases`);
    return (r.databases || []).map((d) => ({ name: d.name.split("/").pop()!, location: d.locationId || "", type: (d.type || "").toLowerCase(), edition: (d.databaseEdition || "").toLowerCase() }));
}

export type Repo = { name: string; format: string; sizeGb: number; cleanup: boolean };

export async function artifactRepos(): Promise<Repo[]> {
    type R = { name: string; format?: string; sizeBytes?: string; cleanupPolicies?: Record<string, unknown> };
    const r = await gapi<{ repositories?: R[] }>(`https://artifactregistry.googleapis.com/v1/projects/${PROJECT}/locations/${REGION}/repositories`);
    return (r.repositories || []).map((x) => ({ name: x.name.split("/").pop()!, format: (x.format || "").toLowerCase(), sizeGb: Number(x.sizeBytes || 0) / 1e9, cleanup: !!x.cleanupPolicies && Object.keys(x.cleanupPolicies).length > 0 }));
}

export type Vm = { name: string; zone: string; machineType: string; status: string };
export type Disk = { name: string; zone: string; sizeGb: number; type: string; attachedTo: string[] };

export async function computeVms(): Promise<{ vms: Vm[]; disks: Disk[] }> {
    type I = { name: string; machineType?: string; status?: string };
    type D = { name: string; sizeGb?: string; type?: string; users?: string[] };
    const base = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}/aggregated`;
    const [vi, di] = await Promise.all([
        gapi<{ items?: Record<string, { instances?: I[] }> }>(`${base}/instances`),
        gapi<{ items?: Record<string, { disks?: D[] }> }>(`${base}/disks`),
    ]);
    const vms: Vm[] = [];
    for (const [zone, v] of Object.entries(vi.items || {})) for (const i of v.instances || []) vms.push({ name: i.name, zone: zone.replace("zones/", ""), machineType: (i.machineType || "").split("/").pop()!, status: (i.status || "").toLowerCase() });
    const disks: Disk[] = [];
    for (const [zone, v] of Object.entries(di.items || {})) for (const d of v.disks || []) disks.push({ name: d.name, zone: zone.replace("zones/", ""), sizeGb: Number(d.sizeGb || 0), type: (d.type || "").split("/").pop()!, attachedTo: (d.users || []).map((u) => u.split("/").pop()!) });
    return { vms, disks };
}

export type LoadBalancer = { rules: Array<{ name: string; ip: string; ports: string }>; certs: Array<{ name: string; domains: string[]; status: string; expiresAt: string | null }>; backends: string[] };

export async function loadBalancers(): Promise<LoadBalancer> {
    const base = `https://compute.googleapis.com/compute/v1/projects/${PROJECT}`;
    type F = { name: string; IPAddress?: string; portRange?: string };
    type C = { name: string; managed?: { domains?: string[]; status?: string }; expireTime?: string };
    type B = { name: string };
    const [fr, certs, be] = await Promise.all([
        gapi<{ items?: Record<string, { forwardingRules?: F[] }> }>(`${base}/aggregated/forwardingRules`),
        gapi<{ items?: C[] }>(`${base}/global/sslCertificates`),
        gapi<{ items?: B[] }>(`${base}/global/backendServices`),
    ]);
    const rules: LoadBalancer["rules"] = [];
    for (const v of Object.values(fr.items || {})) for (const f of v.forwardingRules || []) rules.push({ name: f.name, ip: f.IPAddress || "", ports: f.portRange || "" });
    return {
        rules,
        certs: (certs.items || []).map((c) => ({ name: c.name, domains: c.managed?.domains || [], status: (c.managed?.status || "").toLowerCase(), expiresAt: c.expireTime || null })),
        backends: (be.items || []).map((b) => b.name),
    };
}

export type Bucket = { name: string; location: string; storageClass: string };

export async function buckets(): Promise<Bucket[]> {
    type B = { name: string; location?: string; storageClass?: string };
    const r = await gapi<{ items?: B[] }>(`https://storage.googleapis.com/storage/v1/b?project=${PROJECT}`);
    return (r.items || []).map((b) => ({ name: b.name, location: (b.location || "").toLowerCase(), storageClass: (b.storageClass || "").toLowerCase() }));
}

export async function secretCount(): Promise<number> {
    return (await gapiAll<unknown>(`https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?pageSize=250`, "secrets")).length;
}

/* ── metrics ──────────────────────────────────────────────────────────────── */

type Point = { interval: { startTime: string; endTime: string }; value: { doubleValue?: number; int64Value?: string } };
type Series = { metric?: { labels?: Record<string, string> }; resource?: { labels?: Record<string, string> }; points?: Point[] };

const num = (p: Point) => p.value.doubleValue ?? Number(p.value.int64Value ?? 0);

async function series(filter: string, start: Date, end: Date, periodS: number, aligner: string, reducer: string, groupBy: string[]): Promise<Series[]> {
    const q = new URLSearchParams({
        filter, "interval.startTime": start.toISOString(), "interval.endTime": end.toISOString(),
        "aggregation.alignmentPeriod": `${Math.max(60, Math.round(periodS))}s`, "aggregation.perSeriesAligner": aligner, "aggregation.crossSeriesReducer": reducer,
    });
    for (const g of groupBy) q.append("aggregation.groupByFields", g);
    return gapiAll<Series>(`https://monitoring.googleapis.com/v3/projects/${PROJECT}/timeSeries?${q}`, "timeSeries", 5);
}

/**
 * A metric summed per IST day for the last `days` days (complete days in daily windows ending at IST midnight, plus
 * today so far), grouped by one label. → { label: { day: value } }
 */
export async function dailyByLabel(metric: string, resourceType: string, label: string, days: number, now = Date.now()): Promise<Record<string, Record<string, number>>> {
    const filter = `metric.type="${metric}" AND resource.type="${resourceType}"`;
    const today = istDay(now);
    const midnight = istMidnight(today);
    const out: Record<string, Record<string, number>> = {};
    const add = (s: Series, day: string, v: number) => {
        const key = s.resource?.labels?.[label.replace("resource.label.", "")] ?? s.metric?.labels?.[label.replace("metric.label.", "")] ?? "all";
        (out[key] ??= {})[day] = (out[key][day] ?? 0) + v;
    };
    const past = await series(filter, new Date(midnight.getTime() - (days - 1) * 86_400_000), midnight, 86_400, "ALIGN_SUM", "REDUCE_SUM", [label]);
    for (const s of past) for (const p of s.points || []) add(s, istDay(new Date(p.interval.endTime).getTime() - 3_600_000), num(p));
    const sinceMidnight = (now - midnight.getTime()) / 1000;
    if (sinceMidnight >= 60) {
        const cur = await series(filter, midnight, new Date(now), sinceMidnight, "ALIGN_SUM", "REDUCE_SUM", [label]);
        for (const s of cur) for (const p of s.points || []) add(s, today, num(p));
    }
    return out;
}

/** The latest value of a gauge metric per label (e.g. Firestore storage bytes). */
export async function latestGauge(metric: string, resourceType: string, label: string, now = Date.now()): Promise<Record<string, number>> {
    const s = await series(`metric.type="${metric}" AND resource.type="${resourceType}"`, new Date(now - 6 * 3_600_000), new Date(now), 3600, "ALIGN_MAX", "REDUCE_SUM", [label]);
    const out: Record<string, number> = {};
    for (const x of s) {
        const key = x.resource?.labels?.[label.replace("resource.label.", "")] ?? "all";
        if (x.points?.[0]) out[key] = num(x.points[0]);
    }
    return out;
}

export type RunTraffic = { requests: number; errors5xx: number; errors4xx: number; p95ms: number | null };

/** Requests in the last 24 h per Cloud Run service, by status class, plus p95 latency. */
export async function runTraffic(now = Date.now()): Promise<Record<string, RunTraffic>> {
    const start = new Date(now - 86_400_000), end = new Date(now);
    const [counts, lat] = await Promise.all([
        series('metric.type="run.googleapis.com/request_count" AND resource.type="cloud_run_revision"', start, end, 86_400, "ALIGN_SUM", "REDUCE_SUM", ["resource.label.service_name", "metric.label.response_code_class"]),
        series('metric.type="run.googleapis.com/request_latencies" AND resource.type="cloud_run_revision"', start, end, 86_400, "ALIGN_DELTA", "REDUCE_PERCENTILE_95", ["resource.label.service_name"]).catch(() => [] as Series[]),
    ]);
    const out: Record<string, RunTraffic> = {};
    for (const s of counts) {
        const name = s.resource?.labels?.service_name || "?";
        const cls = s.metric?.labels?.response_code_class || "";
        const n = (s.points || []).reduce((t, p) => t + num(p), 0);
        const r = (out[name] ??= { requests: 0, errors5xx: 0, errors4xx: 0, p95ms: null });
        r.requests += n;
        if (cls === "5xx") r.errors5xx += n;
        if (cls === "4xx") r.errors4xx += n;
    }
    for (const s of lat) {
        const name = s.resource?.labels?.service_name || "?";
        if (s.points?.[0]) (out[name] ??= { requests: 0, errors5xx: 0, errors4xx: 0, p95ms: null }).p95ms = Math.round(num(s.points[0]));
    }
    return out;
}

/* ── the bill (BigQuery billing export) ───────────────────────────────────── */

export const BILLING_DATASET = process.env.INFRA_BILLING_DATASET || "billing_export";

/** The standard billing export table, if the export has been switched on. */
export async function billingTable(): Promise<string | null> {
    try {
        type T = { tableReference: { tableId: string } };
        const tables = await gapiAll<T>(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/datasets/${BILLING_DATASET}/tables`, "tables");
        const t = tables.find((x) => x.tableReference.tableId.startsWith("gcp_billing_export_v1_"));
        return t ? `${PROJECT}.${BILLING_DATASET}.${t.tableReference.tableId}` : null;
    } catch {
        return null;
    }
}

export type BillRow = { service: string; day: string; cost: number; credits: number; currency: string };

/** Cost and credits per Google service per IST day, for this project, from the billing export. */
export async function billingRows(table: string, days: number): Promise<BillRow[]> {
    const sql = `
SELECT service.description AS service, FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, 'Asia/Kolkata')) AS day, currency,
  SUM(cost) AS cost, SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credits
FROM \`${table}\`
WHERE usage_start_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${Math.min(Math.max(days, 1), 120)} DAY) AND project.id = @project
GROUP BY service, day, currency`;
    type Q = { rows?: Array<{ f: Array<{ v: string | null }> }>; jobComplete?: boolean };
    const r = await gapi<Q>(`https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT}/queries`, {
        method: "POST", timeoutMs: 30_000,
        body: { query: sql, useLegacySql: false, timeoutMs: 25_000, parameterMode: "NAMED", queryParameters: [{ name: "project", parameterType: { type: "STRING" }, parameterValue: { value: PROJECT } }] },
    });
    if (r.jobComplete === false) throw new Error("billing query still running");
    return (r.rows || []).map((row) => ({ service: row.f[0].v || "Other", day: row.f[1].v || "", currency: row.f[2].v || "INR", cost: Number(row.f[3].v || 0), credits: Number(row.f[4].v || 0) }));
}

export { lastDays };
