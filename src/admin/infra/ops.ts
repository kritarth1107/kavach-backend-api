/**
 * Operations detail for the console (founder 21 Oct: "all possible details"): one ECS service in depth, the scheduler
 * and every job it starts, the two databases, and the nightly trainer. Read-only AWS calls with the task role, signed
 * here (no SDK). Each part answers what it can; a refused call becomes a line in `errors`, never a failed page.
 */
import mongoose from "mongoose";
import { engineOrNull } from "../engine";
import { sigv4, taskCreds, type Creds } from "./aws";

const REGION = "ap-south-1";
const CLUSTER = "kavach";
const AURORA = "kavach-ai-pg";
const DOCDB = "kavach-docdb";
const ALB = "app/kavach-alb/1da4dfd81964b43d";

const amz = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const iso = (v: unknown): string | null => {
    if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
    if (typeof v === "string" && v) return new Date(v).toISOString();
    return null;
};

/** An AWS JSON-protocol call (ECS, CloudWatch Logs, CloudWatch). */
async function awsJson<T>(creds: Creds, service: string, host: string, target: string, body: unknown, version = "1.1"): Promise<T> {
    const payload = JSON.stringify(body);
    const amzDate = amz();
    const headers: Record<string, string> = { "content-type": `application/x-amz-json-${version}`, "x-amz-target": target };
    if (creds.token) headers["x-amz-security-token"] = creds.token;
    const auth = sigv4({ method: "POST", host, path: "/", headers, body: payload, region: REGION, service, accessKey: creds.accessKey, secretKey: creds.secretKey, amzDate });
    const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body: payload, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${service} ${target.split(".").pop()} ${res.status}${res.status === 400 || res.status === 403 ? `: ${(await res.text()).slice(0, 160)}` : ""}`);
    return (await res.json()) as T;
}

/** An AWS Query-protocol call (RDS and DocumentDB describe calls); returns the XML. */
async function awsQuery(creds: Creds, service: string, host: string, params: Record<string, string>): Promise<string> {
    const body = new URLSearchParams(params).toString();
    const amzDate = amz();
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded; charset=utf-8" };
    if (creds.token) headers["x-amz-security-token"] = creds.token;
    const auth = sigv4({ method: "POST", host, path: "/", headers, body, region: REGION, service, accessKey: creds.accessKey, secretKey: creds.secretKey, amzDate });
    const res = await fetch(`https://${host}/`, { method: "POST", headers: { ...headers, "x-amz-date": amzDate, Authorization: auth }, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${service} ${params.Action} ${res.status}`);
    return res.text();
}

export const tag = (xml: string, name: string): string | null => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1] ?? null;
export const blocks = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[1]);

const ecs = <T>(c: Creds, op: string, body: unknown) => awsJson<T>(c, "ecs", `ecs.${REGION}.amazonaws.com`, `AmazonEC2ContainerServiceV20141113.${op}`, body);
const logs = <T>(c: Creds, op: string, body: unknown) => awsJson<T>(c, "logs", `logs.${REGION}.amazonaws.com`, `Logs_20140328.${op}`, body);

export type Series = { id: string; label: string; unit: string; points: Array<[string, number]>; last: number | null; max: number | null; avg: number | null };
type Query = { id: string; label: string; unit: string; ns: string; metric: string; dims?: Record<string, string>; stat: string; period?: number; scale?: number };

/** Several CloudWatch series over the last `hours`, oldest first. */
async function metrics(c: Creds, qs: Query[], hours = 24): Promise<Series[]> {
    const end = Math.floor(Date.now() / 1000);
    const period = hours <= 6 ? 300 : hours <= 48 ? 900 : 3600;
    const body = {
        StartTime: end - hours * 3600, EndTime: end, ScanBy: "TimestampAscending",
        MetricDataQueries: qs.map((q) => ({ Id: q.id, ReturnData: true, MetricStat: {
            Metric: { Namespace: q.ns, MetricName: q.metric, Dimensions: Object.entries(q.dims || {}).map(([Name, Value]) => ({ Name, Value })) },
            Period: q.period || period, Stat: q.stat } })),
    };
    const data = await awsJson<{ MetricDataResults?: Array<{ Id: string; Timestamps?: Array<number | string>; Values?: number[] }> }>(
        c, "monitoring", `monitoring.${REGION}.amazonaws.com`, "GraniteServiceVersion20100801.GetMetricData", body, "1.0");
    const byId = new Map((data.MetricDataResults || []).map((r) => [r.Id, r]));
    return qs.map((q) => {
        const r = byId.get(q.id);
        const pts: Array<[string, number]> = (r?.Timestamps || []).map((t, i) => [iso(t) || "", (r?.Values?.[i] ?? 0) * (q.scale ?? 1)] as [string, number])
            .sort((a, b) => a[0].localeCompare(b[0]));
        const vals = pts.map((p) => p[1]);
        return { id: q.id, label: q.label, unit: q.unit, points: pts, last: vals.length ? vals[vals.length - 1] : null,
            max: vals.length ? Math.max(...vals) : null, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null };
    });
}

// ── one ECS service ─────────────────────────────────────────────────────────────

type TaskDef = {
    family?: string; revision?: number; cpu?: string; memory?: string; taskRoleArn?: string; executionRoleArn?: string; registeredAt?: number;
    runtimePlatform?: { cpuArchitecture?: string; operatingSystemFamily?: string };
    containerDefinitions?: Array<{ name?: string; image?: string; cpu?: number; memory?: number; essential?: boolean; command?: string[];
        portMappings?: Array<{ containerPort?: number; protocol?: string; name?: string }>; environment?: Array<{ name?: string; value?: string }>;
        secrets?: Array<{ name?: string }>; healthCheck?: { command?: string[]; interval?: number; retries?: number };
        logConfiguration?: { options?: Record<string, string> } }>;
};

// Values of these settings may be shown; every other setting shows its name only.
const SHOW_VALUE = /^(NODE_ENV|PORT|AWS_REGION|LOG_LEVEL|GCP_PROJECT_ID|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|STT_ORDER|VOICE_STT|LLM_PROVIDER_BACKEND|BRAIN_V2|.*_(MODE|ENABLED|CHECK|PROVIDER|MAX_INR))$/;

function taskDefView(td: TaskDef | undefined) {
    if (!td) return null;
    return {
        family: td.family, revision: td.revision, cpu: td.cpu, memory: td.memory, registeredAt: iso(td.registeredAt),
        arch: td.runtimePlatform?.cpuArchitecture || "X86_64", taskRole: td.taskRoleArn?.split("/").pop() || null, executionRole: td.executionRoleArn?.split("/").pop() || null,
        containers: (td.containerDefinitions || []).map((c) => ({
            name: c.name, image: c.image?.split("/").pop() || "", essential: c.essential !== false, command: (c.command || []).join(" ").slice(0, 200),
            ports: (c.portMappings || []).map((p) => `${p.containerPort}/${p.protocol || "tcp"}`),
            settings: (c.environment || []).map((e) => ({ name: e.name || "", value: SHOW_VALUE.test(e.name || "") ? (e.value || "").slice(0, 120) : null }))
                .sort((a, b) => a.name.localeCompare(b.name)),
            secrets: (c.secrets || []).map((s) => s.name || "").sort(),
            health: c.healthCheck ? { command: (c.healthCheck.command || []).join(" ").slice(0, 160), interval: c.healthCheck.interval, retries: c.healthCheck.retries } : null,
            logGroup: c.logConfiguration?.options?.["awslogs-group"] || null, logPrefix: c.logConfiguration?.options?.["awslogs-stream-prefix"] || null,
        })),
    };
}

type EcsTask = { taskArn?: string; lastStatus?: string; desiredStatus?: string; healthStatus?: string; cpu?: string; memory?: string; createdAt?: number; startedAt?: number;
    stoppedAt?: number; stoppedReason?: string; startedBy?: string; availabilityZone?: string; taskDefinitionArn?: string; launchType?: string; platformVersion?: string;
    containers?: Array<{ name?: string; lastStatus?: string; exitCode?: number; reason?: string; healthStatus?: string; image?: string; imageDigest?: string }> };

const taskView = (t: EcsTask) => ({
    id: (t.taskArn || "").split("/").pop() || "", status: t.lastStatus, desired: t.desiredStatus, health: t.healthStatus || null, startedBy: t.startedBy || null,
    az: t.availabilityZone, taskDef: (t.taskDefinitionArn || "").split("/").pop(), createdAt: iso(t.createdAt), startedAt: iso(t.startedAt), stoppedAt: iso(t.stoppedAt),
    stoppedReason: t.stoppedReason || null, platform: t.platformVersion || null,
    containers: (t.containers || []).map((c) => ({ name: c.name, status: c.lastStatus, exitCode: c.exitCode ?? null, reason: c.reason || null, health: c.healthStatus || null,
        digest: (c.imageDigest || "").slice(7, 19) })),
});

// Phone numbers, emails and long ids are masked in log lines shown to the console.
export const mask = (s: string) => s.replace(/\+?\d[\d\s-]{8,}\d/g, "[number]").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]").slice(0, 400);

async function recentLines(c: Creds, group: string, prefix: string | null, minutes: number, pattern: string, limit: number) {
    // CloudWatch answers a filtered search a page at a time, and a page may be empty while later ones are not.
    const out: Array<{ at: string; text: string; stream: string }> = [];
    let token: string | undefined;
    for (let page = 0; page < 60 && out.length < limit; page++) {
        const r = await logs<{ events?: Array<{ timestamp?: number; message?: string; logStreamName?: string }>; nextToken?: string }>(c, "FilterLogEvents", {
            logGroupName: group, ...(prefix ? { logStreamNamePrefix: prefix } : {}), startTime: Date.now() - minutes * 60_000, filterPattern: pattern,
            limit: limit - out.length, ...(token ? { nextToken: token } : {}) });
        out.push(...(r.events || []).map((e) => ({ at: iso(e.timestamp) || "", text: mask(e.message || ""), stream: (e.logStreamName || "").split("/").pop()?.slice(0, 12) || "" })));
        token = r.nextToken;
        if (!token) break;
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
}

export async function ecsDetail(service: string, hours = 24) {
    const errors: string[] = [];
    const c = await taskCreds();
    if (!c) return { service, errors: ["not on AWS: no task role"] };
    type Svc = { serviceName?: string; status?: string; desiredCount?: number; runningCount?: number; pendingCount?: number; taskDefinition?: string; launchType?: string;
        platformVersion?: string; createdAt?: number; healthCheckGracePeriodSeconds?: number; enableExecuteCommand?: boolean;
        deploymentConfiguration?: { maximumPercent?: number; minimumHealthyPercent?: number; deploymentCircuitBreaker?: { enable?: boolean; rollback?: boolean } };
        deployments?: Array<{ id?: string; status?: string; rolloutState?: string; rolloutStateReason?: string; taskDefinition?: string; desiredCount?: number; runningCount?: number;
            pendingCount?: number; failedTasks?: number; createdAt?: number; updatedAt?: number }>;
        events?: Array<{ createdAt?: number; message?: string }>; loadBalancers?: Array<{ targetGroupArn?: string; containerName?: string; containerPort?: number }>;
        networkConfiguration?: { awsvpcConfiguration?: { subnets?: string[]; assignPublicIp?: string } } };
    const settle = async <T>(what: string, p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { errors.push(`${what}: ${(e as Error).message}`); return null; } };
    const d = await settle("service", ecs<{ services?: Svc[] }>(c, "DescribeServices", { cluster: CLUSTER, services: [service] }));
    const s = d?.services?.[0];
    if (!s) return { service, errors: [...errors, "service not found"] };
    const [td, listed, series] = await Promise.all([
        settle("task definition", ecs<{ taskDefinition?: TaskDef }>(c, "DescribeTaskDefinition", { taskDefinition: s.taskDefinition })),
        settle("tasks", Promise.all([
            ecs<{ taskArns?: string[] }>(c, "ListTasks", { cluster: CLUSTER, serviceName: service, desiredStatus: "RUNNING" }),
            ecs<{ taskArns?: string[] }>(c, "ListTasks", { cluster: CLUSTER, serviceName: service, desiredStatus: "STOPPED" }),
        ])),
        settle("metrics", metrics(c, [
            { id: "cpu", label: "CPU used", unit: "%", ns: "AWS/ECS", metric: "CPUUtilization", dims: { ClusterName: CLUSTER, ServiceName: service }, stat: "Average" },
            { id: "cpumax", label: "CPU peak", unit: "%", ns: "AWS/ECS", metric: "CPUUtilization", dims: { ClusterName: CLUSTER, ServiceName: service }, stat: "Maximum" },
            { id: "mem", label: "Memory used", unit: "%", ns: "AWS/ECS", metric: "MemoryUtilization", dims: { ClusterName: CLUSTER, ServiceName: service }, stat: "Average" },
            { id: "memmax", label: "Memory peak", unit: "%", ns: "AWS/ECS", metric: "MemoryUtilization", dims: { ClusterName: CLUSTER, ServiceName: service }, stat: "Maximum" },
        ], hours)),
    ]);
    const arns = [...(listed?.[0].taskArns || []), ...(listed?.[1].taskArns || []).slice(0, 10)];
    const tasks = arns.length ? await settle("task detail", ecs<{ tasks?: EcsTask[] }>(c, "DescribeTasks", { cluster: CLUSTER, tasks: arns })) : { tasks: [] };
    const view = taskDefView(td?.taskDefinition);
    const main = view?.containers.find((x) => x.logGroup) || null;
    const problems = main?.logGroup ? await settle("logs", recentLines(c, main.logGroup, main.logPrefix, 24 * 60, "?ERROR ?Error ?error ?Traceback ?WARNING ?failed ?Exception", 40)) : null;
    return {
        service, errors,
        status: s.status, desired: s.desiredCount ?? 0, running: s.runningCount ?? 0, pending: s.pendingCount ?? 0, launchType: s.launchType || "FARGATE",
        platform: s.platformVersion || null, createdAt: iso(s.createdAt), graceS: s.healthCheckGracePeriodSeconds ?? null, execCommand: !!s.enableExecuteCommand,
        rollout: { maxPercent: s.deploymentConfiguration?.maximumPercent ?? null, minHealthyPercent: s.deploymentConfiguration?.minimumHealthyPercent ?? null,
            circuitBreaker: !!s.deploymentConfiguration?.deploymentCircuitBreaker?.enable, autoRollback: !!s.deploymentConfiguration?.deploymentCircuitBreaker?.rollback },
        network: { subnets: s.networkConfiguration?.awsvpcConfiguration?.subnets?.length ?? 0, publicIp: s.networkConfiguration?.awsvpcConfiguration?.assignPublicIp === "ENABLED" },
        loadBalancers: (s.loadBalancers || []).map((l) => ({ targetGroup: (l.targetGroupArn || "").split("/")[1] || "", container: l.containerName, port: l.containerPort })),
        deployments: (s.deployments || []).map((x) => ({ id: x.id, status: x.status, rollout: x.rolloutState || null, reason: x.rolloutStateReason || null,
            taskDef: (x.taskDefinition || "").split("/").pop(), desired: x.desiredCount, running: x.runningCount, pending: x.pendingCount, failed: x.failedTasks ?? 0,
            createdAt: iso(x.createdAt), updatedAt: iso(x.updatedAt) })),
        events: (s.events || []).slice(0, 25).map((e) => ({ at: iso(e.createdAt), text: (e.message || "").replace(/^\(service [^)]+\)\s*/, "").slice(0, 300) })),
        taskDef: view,
        tasks: (tasks?.tasks || []).map(taskView).sort((a, b) => (b.startedAt || b.createdAt || "").localeCompare(a.startedAt || a.createdAt || "")),
        metrics: series || [],
        problems: problems || [],
    };
}

// ── the scheduler and its jobs ──────────────────────────────────────────────────

type Kind = "engine" | "backend" | "task" | "eventbridge";
type JobDef = { name: string; cron: string; kind: Kind; target: string; what: string; job?: string; family?: string; logGroup?: string; logPrefix?: string };

/** The live crontab (kavach-cron:202610210021, kavach-infra-aws images/cron/crontab) and the EventBridge backup schedules. */
export const JOBS: JobDef[] = [
    { name: "Task runner", cron: "* * * * *", kind: "engine", target: "/v2/jobs/tasks", job: "tasks", what: "Moves orders, rides and other running tasks forward." },
    { name: "Saheli wake", cron: "*/5 * * * *", kind: "engine", target: "/v2/jobs/wake", job: "wake", what: "Sends due check-ins, nudges, follow-ups and briefs." },
    { name: "Browser sweep", cron: "*/10 * * * *", kind: "engine", target: "/v2/jobs/browser-sweep", job: "browser-sweep", what: "Stops stuck browser agents and checks Browser Use credit." },
    { name: "Fact extract", cron: "*/30 * * * *", kind: "engine", target: "/v2/jobs/extract", job: "extract", what: "Turns new conversations into care-record facts and notes." },
    { name: "Saheli's night (dream)", cron: "0 2 * * *", kind: "task", target: "kavach-dream", job: "dream", family: "kavach-dream", what: "Nightly memory: consolidates notes, embeddings, patterns." },
    { name: "Memory consolidate", cron: "15 2 * * *", kind: "engine", target: "/v2/jobs/consolidate", job: "consolidate", what: "Merges duplicate facts and old versions." },
    { name: "Elder reflection", cron: "30 2 * * *", kind: "backend", target: "/internal/v1/jobs/elder-reflection", what: "The backend's nightly reflection per elder." },
    { name: "Saheli check (night)", cron: "0 3 * * *", kind: "task", target: "kavach-saheli-check", family: "kavach-saheli-check", logGroup: "/kavach/engine", logPrefix: "saheli-night/", what: "The world run and judge: grades sampled replies and scores the night." },
    { name: "Nightly trainer", cron: "0 4 * * *", kind: "task", target: "kavach-trainer", job: "trainer", family: "kavach-trainer", logGroup: "/kavach/engine", logPrefix: "trainer/", what: "Tries instruction-text fixes for open replay cases and opens pull requests." },
    { name: "Draft replay gate", cron: "0 7 * * *", kind: "task", target: "kavach-learn-gate", family: "kavach-learn-gate", logGroup: "/kavach/engine", logPrefix: "learn-gate/", what: "Replays the learned-playbook draft before its canary." },
    { name: "Morning report", cron: "0 8 * * *", kind: "engine", target: "/v2/jobs/morning-report", job: "morning-report", what: "The founder's morning report." },
    { name: "Daily jobs", cron: "0 10 * * *", kind: "engine", target: "/v2/jobs/daily", job: "daily", what: "Daily scores, clean-up and summaries." },
    { name: "Weekly learning", cron: "0 8 * * 0", kind: "engine", target: "/v2/jobs/weekly?plan=true", job: "weekly", what: "Weekly report and the learning plan." },
    { name: "Backup (nightly)", cron: "30 3 * * *", kind: "eventbridge", target: "kavach-backup", family: "kavach-backup", logGroup: "/kavach/backup", logPrefix: "backup/", what: "Encrypted backup of both databases to R2 (EventBridge, 22:00 UTC)." },
    { name: "Backup age check", cron: "0 * * * *", kind: "eventbridge", target: "kavach-backup", family: "kavach-backup", logGroup: "/kavach/backup", logPrefix: "backup/", what: "Hourly: alarms when the newest backup is too old." },
    { name: "Restore drill", cron: "30 4 2 * *", kind: "eventbridge", target: "kavach-backup-drill", family: "kavach-backup-drill", logGroup: "/kavach/restore", logPrefix: "restore/", what: "Monthly: restores the latest backup into a scratch database." },
];

type JobRun = { job: string; lastAt: string; lastMs: number; lastOk: boolean; lastCode: number; runs24h: number; failed24h: number; p90Ms: number | null };

/** When a cron line next fires (IST), for the simple forms used above. */
export function nextRun(cron: string, now = Date.now()): string | null {
    const [m, h, dom, , dow] = cron.split(" ");
    const ist = new Date(now + 5.5 * 3600_000);
    for (let i = 1; i <= 60 * 24 * 32; i++) {
        const t = new Date(ist.getTime() + i * 60_000);
        const okM = m === "*" || (m.startsWith("*/") ? t.getUTCMinutes() % Number(m.slice(2)) === 0 : t.getUTCMinutes() === Number(m));
        const okH = h === "*" || t.getUTCHours() === Number(h);
        const okD = dom === "*" || t.getUTCDate() === Number(dom);
        const okW = dow === "*" || t.getUTCDay() === Number(dow);
        if (okM && okH && okD && okW) return new Date(t.getTime() - 5.5 * 3600_000).toISOString();
    }
    return null;
}

export async function cronView() {
    const errors: string[] = [];
    const c = await taskCreds();
    const runs = await engineOrNull<{ jobs: JobRun[] }>("GET", "/job-runs?days=7");
    if (runs.error) errors.push(`engine job runs: ${runs.error}`);
    const byJob = new Map((runs.data?.jobs || []).map((j) => [j.job, j]));
    // Each task job's runs from its log streams (one stream per run); recent cron output for the backend job and task starts.
    const streams = new Map<string, Array<{ id: string; first: string | null; last: string | null; minutes: number | null }>>();
    let cronLines: Array<{ at: string; text: string; stream: string }> = [];
    let tasks: ReturnType<typeof taskView>[] = [];
    if (c) {
        await Promise.all(JOBS.filter((j) => j.logGroup && j.logPrefix).map(async (j) => {
            try {
                const out = await logs<{ logStreams?: Array<{ logStreamName?: string; firstEventTimestamp?: number; lastEventTimestamp?: number }> }>(c, "DescribeLogStreams",
                    { logGroupName: j.logGroup, logStreamNamePrefix: j.logPrefix, limit: 50 });
                streams.set(j.name, (out.logStreams || []).map((s) => ({ id: (s.logStreamName || "").split("/").pop() || "", first: iso(s.firstEventTimestamp), last: iso(s.lastEventTimestamp),
                    minutes: s.firstEventTimestamp && s.lastEventTimestamp ? Math.round((s.lastEventTimestamp - s.firstEventTimestamp) / 60_000) : null }))
                    .sort((a, b) => (b.first || "").localeCompare(a.first || "")).slice(0, 14));
            } catch (e) { errors.push(`${j.name} logs: ${(e as Error).message}`); }
        }));
        try {
            cronLines = await recentLines(c, "/kavach/restore", "cron/", 26 * 60, "?runtask ?\"arn:aws:ecs\" ?internal ?\"-> 4\" ?\"-> 5\" ?\"-> 000\"", 300);
        } catch (e) { errors.push(`scheduler logs: ${(e as Error).message}`); }
        try {
            const ids = new Set<string>();
            for (const fam of ["cron:kavach-dream", "cron:kavach-saheli-check", "cron:kavach-trainer", "cron:kavach-learn-gate"]) {
                for (const st of ["RUNNING", "STOPPED"]) {
                    const l = await ecs<{ taskArns?: string[] }>(c, "ListTasks", { cluster: CLUSTER, startedBy: fam, desiredStatus: st });
                    (l.taskArns || []).forEach((a) => ids.add(a));
                }
            }
            if (ids.size) tasks = ((await ecs<{ tasks?: EcsTask[] }>(c, "DescribeTasks", { cluster: CLUSTER, tasks: [...ids].slice(0, 100) })).tasks || []).map(taskView);
        } catch (e) { errors.push(`job tasks: ${(e as Error).message}`); }
    } else errors.push("not on AWS: no task role");
    const scheduler = c ? await ecsDetail("cron", 24).catch(() => null) : null;
    const jobs = JOBS.map((j) => {
        const r = j.job ? byJob.get(j.job) : undefined;
        const st = streams.get(j.name) || [];
        const live = tasks.filter((t) => t.startedBy === `cron:${j.target}` || t.taskDef?.startsWith(`${j.target}:`))
            .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        const failedTask = live.find((t) => t.status === "STOPPED" && t.containers.some((x) => x.exitCode != null && x.exitCode !== 0 && x.name !== "replay-db"));
        const backendLines = j.kind === "backend" ? cronLines.filter((l) => l.text.includes(j.target)) : [];
        const lastBackend = backendLines.find((l) => l.text.startsWith("cron "));
        const lastAt = r?.lastAt || st[0]?.first || lastBackend?.at || null;
        const failed = r ? !r.lastOk : failedTask ? true : lastBackend ? !/-> 2\d\d/.test(lastBackend.text) : false;
        return {
            ...j, every: j.cron, nextAt: nextRun(j.cron),
            lastAt, lastMs: r?.lastMs ?? (st[0]?.minutes != null ? st[0].minutes * 60_000 : null), lastCode: r?.lastCode ?? null,
            status: !lastAt ? "never" : failed ? "failed" : live.some((t) => t.status === "RUNNING") ? "running" : "ok",
            runs24h: r?.runs24h ?? null, failed24h: r?.failed24h ?? null, p90Ms: r?.p90Ms ?? null,
            history: st, tasks: live.slice(0, 5), lines: backendLines.slice(0, 8),
        };
    });
    return { at: new Date().toISOString(), scheduler, jobs, recent: cronLines.slice(-60).reverse(), errors };
}

// ── databases ───────────────────────────────────────────────────────────────────

async function rdsDescribe(c: Creds) {
    const host = `rds.${REGION}.amazonaws.com`;
    const [cl, inst] = await Promise.all([
        awsQuery(c, "rds", host, { Action: "DescribeDBClusters", Version: "2014-10-31" }),
        awsQuery(c, "rds", host, { Action: "DescribeDBInstances", Version: "2014-10-31" }),
    ]);
    const clusters = blocks(cl, "DBCluster").map((b) => ({
        id: tag(b, "DBClusterIdentifier"), engine: tag(b, "Engine"), version: tag(b, "EngineVersion"), status: tag(b, "Status"), multiAz: tag(b, "MultiAZ") === "true",
        encrypted: tag(b, "StorageEncrypted") === "true", deletionProtection: tag(b, "DeletionProtection") === "true", backupDays: Number(tag(b, "BackupRetentionPeriod") || 0),
        backupWindow: tag(b, "PreferredBackupWindow"), maintenanceWindow: tag(b, "PreferredMaintenanceWindow"), latestRestorable: tag(b, "LatestRestorableTime"),
        created: tag(b, "ClusterCreateTime"), minAcu: tag(b, "MinCapacity") ? Number(tag(b, "MinCapacity")) : null, maxAcu: tag(b, "MaxCapacity") ? Number(tag(b, "MaxCapacity")) : null,
        members: blocks(b, "DBClusterMember").map((m) => ({ id: tag(m, "DBInstanceIdentifier"), writer: tag(m, "IsClusterWriter") === "true" })),
    }));
    const instances = blocks(inst, "DBInstance").map((b) => ({
        id: tag(b, "DBInstanceIdentifier"), cluster: tag(b, "DBClusterIdentifier"), engine: tag(b, "Engine"), cls: tag(b, "DBInstanceClass"), status: tag(b, "DBInstanceStatus"),
        az: tag(b, "AvailabilityZone"), created: tag(b, "InstanceCreateTime"), insights: tag(b, "PerformanceInsightsEnabled") === "true",
        autoMinorUpgrade: tag(b, "AutoMinorVersionUpgrade") === "true", caCert: tag(b, "CACertificateIdentifier"),
    }));
    return { clusters, instances };
}

async function mongoStats() {
    const db = mongoose.connection?.db;
    if (!db) return null;
    const stats = (await db.command({ dbStats: 1, scale: 1 })) as Record<string, number | string>;
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    const each = await Promise.all(cols.map(async (c) => {
        try {
            const s = (await db.command({ collStats: c.name })) as Record<string, number>;
            return { name: c.name, count: s.count ?? 0, bytes: s.size ?? 0, storageBytes: s.storageSize ?? 0, indexBytes: s.totalIndexSize ?? 0, indexes: s.nindexes ?? 0, avgDoc: s.avgObjSize ?? 0 };
        } catch {
            return { name: c.name, count: await db.collection(c.name).estimatedDocumentCount().catch(() => 0), bytes: 0, storageBytes: 0, indexBytes: 0, indexes: 0, avgDoc: 0 };
        }
    }));
    let server: Record<string, unknown> = {};
    try {
        const s = (await db.admin().command({ serverStatus: 1 })) as { version?: string; uptime?: number; connections?: { current?: number; available?: number };
            opcounters?: Record<string, number> };
        server = { version: s.version, uptimeS: s.uptime, connections: s.connections?.current, available: s.connections?.available, ops: s.opcounters };
    } catch { /* DocumentDB may refuse serverStatus to this user */ }
    return { name: db.databaseName, collections: Number(stats.collections || cols.length), objects: Number(stats.objects || 0), dataBytes: Number(stats.dataSize || 0),
        storageBytes: Number(stats.storageSize || 0), indexBytes: Number(stats.indexSize || 0), indexes: Number(stats.indexes || 0), server,
        byCollection: each.sort((a, b) => b.storageBytes + b.indexBytes - (a.storageBytes + a.indexBytes)) };
}

export async function dataView(hours = 24) {
    const errors: string[] = [];
    const c = await taskCreds();
    const settle = async <T>(what: string, p: Promise<T>): Promise<T | null> => { try { return await p; } catch (e) { errors.push(`${what}: ${(e as Error).message}`); return null; } };
    const rds = { DBClusterIdentifier: AURORA };
    const doc = { DBClusterIdentifier: DOCDB };
    const [describe, auroraM, docM, albM, pg, mongo] = await Promise.all([
        c ? settle("RDS describe", rdsDescribe(c)) : null,
        c ? settle("Aurora metrics", metrics(c, [
            { id: "acu", label: "Capacity (ACU)", unit: "ACU", ns: "AWS/RDS", metric: "ServerlessDatabaseCapacity", dims: rds, stat: "Average" },
            { id: "acuu", label: "Capacity used", unit: "%", ns: "AWS/RDS", metric: "ACUUtilization", dims: rds, stat: "Average" },
            { id: "cpu", label: "CPU", unit: "%", ns: "AWS/RDS", metric: "CPUUtilization", dims: rds, stat: "Average" },
            { id: "conn", label: "Connections", unit: "", ns: "AWS/RDS", metric: "DatabaseConnections", dims: rds, stat: "Maximum" },
            { id: "mem", label: "Free memory", unit: "MB", ns: "AWS/RDS", metric: "FreeableMemory", dims: rds, stat: "Minimum", scale: 1 / 1048576 },
            { id: "rlat", label: "Read latency", unit: "ms", ns: "AWS/RDS", metric: "ReadLatency", dims: rds, stat: "Average", scale: 1000 },
            { id: "wlat", label: "Write latency", unit: "ms", ns: "AWS/RDS", metric: "WriteLatency", dims: rds, stat: "Average", scale: 1000 },
            { id: "riops", label: "Read IOPS", unit: "/s", ns: "AWS/RDS", metric: "ReadIOPS", dims: rds, stat: "Average" },
            { id: "wiops", label: "Write IOPS", unit: "/s", ns: "AWS/RDS", metric: "WriteIOPS", dims: rds, stat: "Average" },
            { id: "vol", label: "Storage used", unit: "GB", ns: "AWS/RDS", metric: "VolumeBytesUsed", dims: rds, stat: "Maximum", scale: 1 / 1073741824 },
            { id: "commit", label: "Commits", unit: "/s", ns: "AWS/RDS", metric: "CommitThroughput", dims: rds, stat: "Average" },
            { id: "dead", label: "Deadlocks", unit: "/s", ns: "AWS/RDS", metric: "Deadlocks", dims: rds, stat: "Sum" },
        ], hours)) : null,
        c ? settle("DocumentDB metrics", metrics(c, [
            { id: "cpu", label: "CPU", unit: "%", ns: "AWS/DocDB", metric: "CPUUtilization", dims: doc, stat: "Average" },
            { id: "conn", label: "Connections", unit: "", ns: "AWS/DocDB", metric: "DatabaseConnections", dims: doc, stat: "Maximum" },
            { id: "mem", label: "Free memory", unit: "MB", ns: "AWS/DocDB", metric: "FreeableMemory", dims: doc, stat: "Minimum", scale: 1 / 1048576 },
            { id: "cache", label: "Cache hit", unit: "%", ns: "AWS/DocDB", metric: "BufferCacheHitRatio", dims: doc, stat: "Average" },
            { id: "rlat", label: "Read latency", unit: "ms", ns: "AWS/DocDB", metric: "ReadLatency", dims: doc, stat: "Average", scale: 1000 },
            { id: "wlat", label: "Write latency", unit: "ms", ns: "AWS/DocDB", metric: "WriteLatency", dims: doc, stat: "Average", scale: 1000 },
            { id: "q", label: "Queries", unit: "/min", ns: "AWS/DocDB", metric: "OpcountersQuery", dims: doc, stat: "Sum" },
            { id: "ins", label: "Inserts", unit: "/min", ns: "AWS/DocDB", metric: "OpcountersInsert", dims: doc, stat: "Sum" },
            { id: "upd", label: "Updates", unit: "/min", ns: "AWS/DocDB", metric: "OpcountersUpdate", dims: doc, stat: "Sum" },
            { id: "vol", label: "Storage used", unit: "GB", ns: "AWS/DocDB", metric: "VolumeBytesUsed", dims: doc, stat: "Maximum", scale: 1 / 1073741824 },
            { id: "lag", label: "Replica lag", unit: "ms", ns: "AWS/DocDB", metric: "DBClusterReplicaLagMaximum", dims: doc, stat: "Maximum" },
        ], hours)) : null,
        c ? settle("load balancer metrics", metrics(c, [
            { id: "req", label: "Requests", unit: "", ns: "AWS/ApplicationELB", metric: "RequestCount", dims: { LoadBalancer: ALB }, stat: "Sum" },
            { id: "t5", label: "App 5xx", unit: "", ns: "AWS/ApplicationELB", metric: "HTTPCode_Target_5XX_Count", dims: { LoadBalancer: ALB }, stat: "Sum" },
            { id: "e5", label: "LB 5xx", unit: "", ns: "AWS/ApplicationELB", metric: "HTTPCode_ELB_5XX_Count", dims: { LoadBalancer: ALB }, stat: "Sum" },
            { id: "t4", label: "App 4xx", unit: "", ns: "AWS/ApplicationELB", metric: "HTTPCode_Target_4XX_Count", dims: { LoadBalancer: ALB }, stat: "Sum" },
            { id: "rt", label: "Response p90", unit: "ms", ns: "AWS/ApplicationELB", metric: "TargetResponseTime", dims: { LoadBalancer: ALB }, stat: "p90", scale: 1000 },
            { id: "conns", label: "Active connections", unit: "", ns: "AWS/ApplicationELB", metric: "ActiveConnectionCount", dims: { LoadBalancer: ALB }, stat: "Sum" },
        ], hours)) : null,
        engineOrNull<Record<string, unknown>>("GET", "/db-stats"),
        settle("DocumentDB stats", mongoStats()),
    ]);
    if (!c) errors.push("not on AWS: no task role");
    if (pg.error) errors.push(`Aurora stats from the engine: ${pg.error}`);
    return {
        at: new Date().toISOString(), hours, errors,
        aurora: { cluster: describe?.clusters.find((x) => x.id === AURORA) || null, instances: describe?.instances.filter((x) => x.cluster === AURORA) || [], metrics: auroraM || [], stats: pg.data },
        docdb: { cluster: describe?.clusters.find((x) => x.id === DOCDB) || null, instances: describe?.instances.filter((x) => x.cluster === DOCDB) || [], metrics: docM || [], stats: mongo },
        alb: { name: "kavach-alb", metrics: albM || [] },
    };
}

// ── the nightly trainer ─────────────────────────────────────────────────────────

type Pr = { number: number; title: string; state: string; merged_at: string | null; created_at: string; closed_at: string | null; html_url: string;
    labels?: Array<{ name: string }>; head?: { ref?: string } };

export async function trainerView() {
    const errors: string[] = [];
    const runs = await engineOrNull<{ runs: unknown[] }>("GET", "/trainer-runs?limit=60");
    if (runs.error) errors.push(`engine: ${runs.error}`);
    let prs: Array<{ number: number; title: string; state: "open" | "merged" | "closed"; at: string; closedAt: string | null; url: string; branch: string }> = [];
    try {
        const token = process.env.GITHUB_TOKEN;
        const res = await fetch("https://api.github.com/repos/kritarth1107/kawach-ai-engine/pulls?state=all&per_page=100", {
            headers: { accept: "application/vnd.github+json", "user-agent": "kavach-admin", ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error(`GitHub ${res.status}`);
        prs = ((await res.json()) as Pr[]).filter((p) => (p.labels || []).some((l) => l.name === "saheli-trainer")).map((p) => ({
            number: p.number, title: p.title, state: p.merged_at ? "merged" : p.state === "open" ? "open" : "closed", at: p.created_at, closedAt: p.merged_at || p.closed_at,
            url: p.html_url, branch: p.head?.ref || "" }));
    } catch (e) { errors.push(`pull requests: ${(e as Error).message}`); }
    const c = await taskCreds();
    let tasks: ReturnType<typeof taskView>[] = [];
    let td = null;
    if (c) {
        try {
            const ids = new Set<string>();
            for (const by of ["cron:kavach-trainer", "manual:trainer-first", "manual:trainer-second"]) {
                for (const st of ["RUNNING", "STOPPED"]) ((await ecs<{ taskArns?: string[] }>(c, "ListTasks", { cluster: CLUSTER, startedBy: by, desiredStatus: st })).taskArns || []).forEach((a) => ids.add(a));
            }
            if (ids.size) tasks = ((await ecs<{ tasks?: EcsTask[] }>(c, "DescribeTasks", { cluster: CLUSTER, tasks: [...ids] })).tasks || []).map(taskView);
            td = taskDefView((await ecs<{ taskDefinition?: TaskDef }>(c, "DescribeTaskDefinition", { taskDefinition: "kavach-trainer" })).taskDefinition);
        } catch (e) { errors.push(`ECS: ${(e as Error).message}`); }
    }
    return { at: new Date().toISOString(), schedule: "0 4 * * *", nextAt: nextRun("0 4 * * *"), runs: runs.data?.runs || [], prs, tasks, taskDef: td, errors };
}
