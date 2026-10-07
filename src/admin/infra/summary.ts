/**
 * The Infrastructure snapshot: every service Kavach runs on, which provider it lives at, its state, and what it
 * costs per day and per month (with a month forecast). Built from live APIs and cached for 10 minutes.
 *
 * Cost sources, best first: "billed" (the provider's own bill: GCP billing export, Meta pricing analytics, AWS Cost
 * Explorer), "metered" (our own counters: the engine's model ledger, Browser Use balance drops), "estimate" (usage
 * metrics × list prices), "free" (inside a free plan), "none" (not measured yet: shown, never guessed).
 */
import mongoose, { Schema } from "mongoose";
import { engineOrNull } from "../engine";
import { awsBill } from "./aws";
import * as gcp from "./gcp";
import { settle } from "./google";
import {
    ARTIFACT_USD_GB_MONTH, FIRESTORE, LB_RULE_USD_HOUR, PD_BALANCED_USD_GB_MONTH, PD_STANDARD_USD_GB_MONTH, SCHEDULER_USD_JOB_MONTH,
    SQL_SSD_USD_GB_MONTH, SQL_TIER_USD_HOUR, USD_INR, inr, lastDays, perDay, round2, runCostUsd, sumDaily, totals, type Totals,
} from "./pricing";
import { browserUseAccount, elevenLabsUsage, whatsappBill } from "./vendors";

export type Provider = "GCP" | "AWS" | "Cloudflare" | "Meta" | "Browser Use" | "ElevenLabs" | "Resend";
export type CostSource = "billed" | "metered" | "estimate" | "free" | "none";
export type Status = "ok" | "warn" | "down" | "stopped" | "planned" | "unknown";

export type InfraService = {
    id: string; name: string; provider: Provider; category: string; purpose: string; usedBy: string;
    status: Status; facts: Array<{ label: string; value: string }>; source: CostSource; note?: string; console?: string;
    totals: Totals; daily: Record<string, number>;
};
export type Connection = { id: string; name: string; provider: Provider; connected: boolean; detail: string; howTo?: string[] };
export type Alert = { level: "warn" | "info"; text: string; action?: string };
export type Snapshot = {
    at: string; usdInr: number; days: string[]; totals: Totals; daily: Array<{ day: string; inr: number }>;
    providers: Array<{ provider: Provider; services: number; source: CostSource | "mixed"; totals: Totals }>;
    services: InfraService[]; schedules: gcp.Schedule[]; jobs: gcp.RunJob[];
    connections: Connection[]; alerts: Alert[]; balances: Array<{ name: string; provider: Provider; value: string; low: boolean }>;
    errors: string[];
};

const DAYS = 30;
const at = (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(iso)) : "—";
const CONSOLE = (path: string) => `https://console.cloud.google.com/${path}?project=${gcp.PROJECT}`;

const RUN_INFO: Record<string, { name: string; purpose: string; usedBy: string }> = {
    "kavach-backend": { name: "Family backend API", purpose: "WhatsApp webhooks, reminders, orders, dashboard API", usedBy: "Families, Saheli" },
    "kawach-ai-engine": { name: "Saheli AI engine", purpose: "Saheli's brain, memory, task agents", usedBy: "Backend" },
    "kavach-dashboard": { name: "Family dashboard", purpose: "app.kavach.care for caregivers", usedBy: "Caregivers" },
    "kavach-admin": { name: "Admin console", purpose: "This console", usedBy: "Kavach team" },
    "kavach-admin-api": { name: "Admin API", purpose: "The console's locked API", usedBy: "Admin console" },
};

/** Google bill service names → our rows. Cloud Run is split across services by usage. */
const BILL_MAP: Array<[RegExp, string]> = [
    [/^cloud run$/i, "run"], [/^cloud sql$/i, "sql"], [/vertex|gemini|generative language/i, "vertex"], [/artifact registry/i, "artifacts"],
    [/firestore|datastore/i, "firestore"], [/cloud scheduler/i, "scheduler"], [/^compute engine$/i, "compute"], [/networking|load balanc/i, "lb"],
    [/secret manager/i, "secrets"], [/cloud storage/i, "storage"], [/logging|monitoring|trace/i, "observability"], [/speech/i, "speech"],
    [/bigquery/i, "bigquery"],
];

/* ── Browser Use balance history (its spend = how much the balance went down each day) ── */

// Plain index (Firestore's MongoDB compatibility has no unique indexes); upserts by key keep one row per day.
const balanceSchema = new Schema({ key: { type: String, required: true, index: true }, provider: String, day: String, balance: Number, at: Date }, { collection: "admin_infra_balances", versionKey: false });
const Balance = mongoose.models.AdminInfraBalance || mongoose.model("AdminInfraBalance", balanceSchema);

async function balanceSpend(provider: string, balanceUsd: number | null, days: string[]): Promise<Record<string, number>> {
    const today = days[days.length - 1];
    if (balanceUsd != null) await Balance.updateOne({ key: `${provider}:${today}` }, { $set: { provider, day: today, balance: balanceUsd, at: new Date() } }, { upsert: true });
    const rows = await Balance.find({ provider, day: { $gte: days[0] } }).lean<Array<{ day: string; balance: number }>>();
    const by = new Map(rows.map((r) => [r.day, r.balance]));
    const out: Record<string, number> = {};
    for (let i = 1; i < days.length; i++) {
        const a = by.get(days[i - 1]), b = by.get(days[i]);
        if (a != null && b != null) out[days[i]] = inr(Math.max(0, a - b)); // a top-up (balance up) counts as 0
    }
    return out;
}

/* ── build ────────────────────────────────────────────────────────────────── */

type EngineSpend = { today: number; softCap: number; hardCap: number; rows: Array<{ day: string; role: string; model: string; calls: number; tokensIn: number; tokensOut: number; costInr: number }> };

export async function buildSnapshot(now = Date.now()): Promise<Snapshot> {
    const errors: string[] = [];
    const days = lastDays(DAYS, now);
    const today = days[days.length - 1];
    const keep = (d: Record<string, number>) => Object.fromEntries(Object.entries(d).filter(([k]) => k >= days[0] && k <= today));

    const [run, jobs, scheds, sql, fsdbs, repos, compute, lb, bucketList, secrets, runSeconds, jobSeconds, traffic, fsReads, fsWrites, fsBytes, billTable, spend, wa, bu, el, aws] = await Promise.all([
        settle("Cloud Run", gcp.runServices, errors),
        settle("Cloud Run jobs", gcp.runJobs, errors),
        settle("Cloud Scheduler", gcp.schedules, errors),
        settle("Cloud SQL", gcp.sqlInstances, errors),
        settle("Firestore", gcp.firestoreDbs, errors),
        settle("Artifact Registry", gcp.artifactRepos, errors),
        settle("Compute Engine", gcp.computeVms, errors),
        settle("Load balancer", gcp.loadBalancers, errors),
        settle("Cloud Storage", gcp.buckets, errors),
        settle("Secret Manager", gcp.secretCount, errors),
        settle("Cloud Run usage", () => gcp.dailyByLabel("run.googleapis.com/container/billable_instance_time", "cloud_run_revision", "resource.label.service_name", DAYS, now), errors),
        settle("Cloud Run job usage", () => gcp.dailyByLabel("run.googleapis.com/container/billable_instance_time", "cloud_run_job", "resource.label.job_name", DAYS, now), errors),
        settle("Cloud Run traffic", () => gcp.runTraffic(now), errors),
        settle("Firestore reads", () => gcp.dailyByLabel("firestore.googleapis.com/api/billable_read_units", "firestore.googleapis.com/Database", "resource.label.database_id", DAYS, now), errors),
        settle("Firestore writes", () => gcp.dailyByLabel("firestore.googleapis.com/api/billable_write_units", "firestore.googleapis.com/Database", "resource.label.database_id", DAYS, now), errors),
        settle("Firestore storage", () => gcp.latestGauge("firestore.googleapis.com/storage/data_and_index_storage_bytes", "firestore.googleapis.com/Database", "resource.label.database_id", now), errors),
        gcp.billingTable(),
        engineOrNull<EngineSpend>("GET", "/spend?days=35"),
        whatsappBill(35, now),
        browserUseAccount(),
        elevenLabsUsage(),
        awsBill(35, now),
    ]);

    // The Google bill, when the export is on: net cost (after credits) per row id per day, in INR.
    let bill: Record<string, Record<string, number>> | null = null;
    if (billTable) {
        const rows = await settle("Billing export", () => gcp.billingRows(billTable, 40), errors);
        if (rows) {
            bill = {};
            for (const r of rows) {
                const id = BILL_MAP.find(([re]) => re.test(r.service))?.[1] || "other";
                const v = (r.cost + r.credits) * (r.currency === "USD" ? USD_INR : 1);
                (bill[id] ??= {})[r.day] = (bill[id][r.day] ?? 0) + v;
            }
        }
    }
    const billed = (id: string) => (bill ? keep(bill[id] || {}) : null);

    // Days the project was actually running (any Cloud Run usage): fixed monthly charges are spread over these.
    const runningDays = new Set(Object.values(runSeconds || {}).flatMap((d) => Object.keys(d)));
    const fixedDaily = (monthlyUsd: number) => Object.fromEntries([...runningDays].filter((d) => d >= days[0]).map((d) => [d, inr(perDay(monthlyUsd, d))]));

    const services: InfraService[] = [];
    const add = (s: Omit<InfraService, "totals">) => services.push({ ...s, daily: keep(s.daily), totals: totals(keep(s.daily), now) });

    // Cloud Run services: usage × list price, scaled to the billed Cloud Run total when the bill is connected.
    const runEst: Record<string, Record<string, number>> = {};
    for (const s of run || []) {
        const secs = runSeconds?.[s.name] || {};
        runEst[s.name] = Object.fromEntries(Object.entries(secs).map(([d, v]) => [d, inr(runCostUsd(v, s.cpu, s.memoryGib, s.alwaysOn))]));
    }
    const runBilled = billed("run");
    if (runBilled) {
        for (const d of Object.keys(runBilled)) {
            const estTotal = Object.values(runEst).reduce((t, e) => t + (e[d] ?? 0), 0);
            for (const e of Object.values(runEst)) e[d] = estTotal > 0 ? ((e[d] ?? 0) / estTotal) * runBilled[d] : 0;
        }
    }
    for (const s of run || []) {
        const t = traffic?.[s.name];
        const errRate = t && t.requests ? t.errors5xx / t.requests : 0;
        const info = RUN_INFO[s.name] || { name: s.name, purpose: "Cloud Run service", usedBy: "—" };
        add({
            id: `run:${s.name}`, name: info.name, provider: "GCP", category: "Compute", purpose: info.purpose, usedBy: info.usedBy,
            status: !s.ready ? "down" : errRate >= 0.02 ? "warn" : "ok",
            facts: [
                { label: "Service", value: s.name },
                { label: "Size", value: `${s.cpu} vCPU · ${round2(s.memoryGib)} GiB` },
                { label: "Instances", value: `${s.minInstances}–${s.maxInstances ?? "∞"}${s.minInstances > 0 ? " (always on)" : ""}` },
                { label: "Requests 24 h", value: t ? `${t.requests.toLocaleString("en-IN")}${t.errors5xx ? ` · ${t.errors5xx} errors` : ""}` : "—" },
                { label: "p95 latency", value: t?.p95ms != null ? `${t.p95ms} ms` : "—" },
                { label: "Revision", value: s.revision },
                { label: "Deployed", value: `${at(s.updatedAt)}${s.updatedBy ? ` by ${s.updatedBy.split("@")[0]}` : ""}` },
            ],
            source: runBilled ? "billed" : "estimate", note: runBilled ? "Google's Cloud Run total, split by each service's usage" : "Instance time × Mumbai list price (free tier not subtracted)",
            console: CONSOLE(`run/detail/${gcp.REGION}/${s.name}/metrics`), daily: runEst[s.name] || {},
        });
    }

    // Cloud Run jobs (backups, Saheli's night).
    if (jobs?.length) {
        const daily = sumDaily(jobs.map((j) => Object.fromEntries(Object.entries(jobSeconds?.[j.name] || {}).map(([d, v]) => [d, inr(runCostUsd(v, j.cpu, j.memoryGib, false))]))));
        const failed = jobs.filter((j) => j.lastStatus === "failed");
        add({
            id: "run:jobs", name: "Cloud Run jobs", provider: "GCP", category: "Compute", purpose: "Nightly backup, Saheli's night (memory)", usedBy: "Scheduler",
            status: failed.length ? "warn" : "ok", facts: jobs.map((j) => ({ label: j.name, value: `${j.lastStatus || "never run"}${j.lastRunAt ? ` · ${at(j.lastRunAt)}` : ""}` })),
            source: "estimate", console: CONSOLE("run/jobs"), daily,
        });
    }

    // Scheduler.
    if (scheds) {
        const failed = scheds.filter((j) => j.failed);
        add({
            id: "scheduler", name: "Cloud Scheduler", provider: "GCP", category: "Automation", purpose: `${scheds.length} timed jobs (Saheli wake-ups, tasks, backups)`, usedBy: "Backend, engine",
            status: failed.length ? "warn" : "ok", facts: [{ label: "Jobs", value: String(scheds.length) }, { label: "Failing", value: failed.length ? failed.map((f) => f.name).join(", ") : "none" }],
            source: billed("scheduler") ? "billed" : "estimate", console: CONSOLE("cloudscheduler"),
            daily: billed("scheduler") || fixedDaily(Math.max(0, scheds.length - 3) * SCHEDULER_USD_JOB_MONTH),
        });
    }

    // Firestore (main database, MongoDB-compatible).
    for (const db of fsdbs || []) {
        const reads = fsReads?.[db.name] || {}, writes = fsWrites?.[db.name] || {};
        const gib = (fsBytes?.[db.name] ?? 0) / 2 ** 30;
        const est: Record<string, number> = {};
        for (const d of new Set([...Object.keys(reads), ...Object.keys(writes)])) {
            est[d] = inr(((reads[d] ?? 0) / 1e6) * FIRESTORE.readPerMillion + ((writes[d] ?? 0) / 1e6) * FIRESTORE.writePerMillion + perDay(gib * FIRESTORE.gibMonth, d));
        }
        const r24 = reads[today] ?? 0, w24 = writes[today] ?? 0;
        add({
            id: `firestore:${db.name}`, name: "Main database", provider: "GCP", category: "Database", purpose: "Families, people, messages, reminders, orders (MongoDB-compatible)", usedBy: "Backend, admin API",
            status: "ok", facts: [{ label: "Database", value: `${db.name} · ${db.edition} · ${db.location}` }, { label: "Stored", value: `${round2(gib)} GiB` }, { label: "Today", value: `${Math.round(r24).toLocaleString("en-IN")} read units · ${Math.round(w24).toLocaleString("en-IN")} write units` }],
            source: billed("firestore") ? "billed" : "estimate", note: billed("firestore") ? undefined : "Read/write units × us-central1 list price", console: CONSOLE("firestore/databases"),
            daily: billed("firestore") || est,
        });
    }

    // Cloud SQL (Postgres: Saheli's memory, model ledger).
    for (const i of sql || []) {
        const hourly = SQL_TIER_USD_HOUR[i.tier];
        const diskMonth = i.diskGb * (i.diskType.includes("HDD") ? 0.09 : SQL_SSD_USD_GB_MONTH);
        add({
            id: `sql:${i.name}`, name: "Saheli memory database", provider: "GCP", category: "Database", purpose: "Postgres + pgvector: memory, care record, model ledger", usedBy: "AI engine",
            status: i.state !== "runnable" ? "down" : i.backups ? "ok" : "warn",
            facts: [{ label: "Instance", value: `${i.name} · ${i.version}` }, { label: "Tier", value: i.tier }, { label: "Disk", value: `${i.diskGb} GB ${i.diskType.replace("PD_", "")}` }, { label: "Automatic backups", value: i.backups ? "on" : "off" }],
            source: billed("sql") ? "billed" : hourly ? "estimate" : "none", console: CONSOLE(`sql/instances/${i.name}/overview`),
            daily: billed("sql") || (hourly ? fixedDaily(hourly * 730 + diskMonth) : {}),
        });
    }

    // Vertex AI (Gemini): the engine's own ledger until the bill is connected.
    const ledger: Record<string, number> = {};
    for (const r of spend.data?.rows || []) ledger[r.day] = (ledger[r.day] ?? 0) + r.costInr;
    add({
        id: "vertex", name: "Vertex AI (Gemini)", provider: "GCP", category: "AI", purpose: "Saheli's models, embeddings, voice-note and photo reading", usedBy: "AI engine, backend",
        status: spend.data ? (spend.data.today >= spend.data.softCap ? "warn" : "ok") : "unknown",
        facts: spend.data ? [{ label: "Today", value: `₹${round2(spend.data.today)} of ₹${spend.data.softCap} soft cap` }, { label: "Hard cap", value: `₹${spend.data.hardCap}/day` }] : [{ label: "Engine", value: spend.error || "not reachable" }],
        source: billed("vertex") ? "billed" : "metered", note: billed("vertex") ? undefined : "The engine's model ledger (backend voice/photo calls not included)", console: CONSOLE("vertex-ai"),
        daily: billed("vertex") || ledger,
    });

    // Artifact Registry.
    for (const r of repos || []) {
        add({
            id: `artifacts:${r.name}`, name: "Container images", provider: "GCP", category: "Storage", purpose: "Docker images for every deploy", usedBy: "Deploys",
            status: !r.cleanup && r.sizeGb > 20 ? "warn" : "ok", facts: [{ label: "Repository", value: `${r.name} (${r.format})` }, { label: "Size", value: `${round2(r.sizeGb)} GB` }, { label: "Cleanup policy", value: r.cleanup ? "yes" : "none" }],
            source: billed("artifacts") ? "billed" : "estimate", console: CONSOLE(`artifacts/docker/${gcp.PROJECT}/${gcp.REGION}/${r.name}`),
            daily: billed("artifacts") || fixedDaily(Math.max(0, r.sizeGb - 0.5) * ARTIFACT_USD_GB_MONTH),
        });
    }

    // Load balancer (app.kavach.care).
    if (lb?.rules.length) {
        const soon = lb.certs.filter((c) => c.expiresAt && new Date(c.expiresAt).getTime() - now < 21 * 86_400_000);
        add({
            id: "lb", name: "Load balancer", provider: "GCP", category: "Network", purpose: `HTTPS for ${lb.certs.flatMap((c) => c.domains).join(", ") || "the dashboard"}`, usedBy: "Caregivers",
            status: lb.certs.some((c) => c.status && c.status !== "active") || soon.length ? "warn" : "ok",
            facts: [...lb.rules.map((r) => ({ label: r.name, value: `${r.ip}:${r.ports}` })), ...lb.certs.map((c) => ({ label: "Certificate", value: `${c.domains.join(", ")} · ${c.status}${c.expiresAt ? ` · renews by ${c.expiresAt.slice(0, 10)}` : ""}` }))],
            source: billed("lb") ? "billed" : "estimate", console: CONSOLE("net-services/loadbalancing/list/loadBalancers"),
            daily: billed("lb") || fixedDaily(lb.rules.length * LB_RULE_USD_HOUR * 730),
        });
    }

    // Compute Engine (VMs and their disks).
    if (compute && (compute.vms.length || compute.disks.length)) {
        const running = new Set(compute.vms.filter((v) => v.status === "running").map((v) => v.name));
        const idleDisks = compute.disks.filter((d) => !d.attachedTo.some((u) => running.has(u)));
        const diskMonth = compute.disks.reduce((t, d) => t + d.sizeGb * (d.type.includes("standard") ? PD_STANDARD_USD_GB_MONTH : PD_BALANCED_USD_GB_MONTH), 0);
        add({
            id: "compute", name: "Virtual machines", provider: "GCP", category: "Compute", purpose: compute.vms.map((v) => v.name).join(", ") || "Disks", usedBy: "—",
            status: compute.vms.length && !running.size ? "stopped" : "ok",
            facts: [...compute.vms.map((v) => ({ label: v.name, value: `${v.machineType} · ${v.status}` })), ...compute.disks.map((d) => ({ label: `Disk ${d.name}`, value: `${d.sizeGb} GB ${d.type}` }))],
            source: billed("compute") ? "billed" : "estimate", note: idleDisks.length ? "Stopped machines still pay for their disks" : undefined, console: CONSOLE("compute/instances"),
            daily: billed("compute") || fixedDaily(diskMonth),
        });
    }

    // Smaller Google services: shown with what we know; cost only from the bill.
    if (secrets != null) add({ id: "secrets", name: "Secret Manager", provider: "GCP", category: "Security", purpose: "API keys and passwords for every service", usedBy: "All services", status: "ok", facts: [{ label: "Secrets", value: String(secrets) }], source: billed("secrets") ? "billed" : "estimate", console: CONSOLE("security/secret-manager"), daily: billed("secrets") || fixedDaily(Math.max(0, secrets - 6) * 0.06) });
    for (const b of bucketList || []) add({ id: `storage:${b.name}`, name: "Cloud Storage", provider: "GCP", category: "Storage", purpose: "Memory exports", usedBy: "AI engine", status: "ok", facts: [{ label: "Bucket", value: `${b.name} · ${b.location} · ${b.storageClass}` }], source: billed("storage") ? "billed" : "none", console: CONSOLE("storage/browser"), daily: billed("storage") || {} });
    add({ id: "observability", name: "Logging & monitoring", provider: "GCP", category: "Operations", purpose: "Logs, metrics, traces of every service", usedBy: "All services", status: "ok", facts: [], source: billed("observability") ? "billed" : "none", note: billed("observability") ? undefined : "50 GiB of logs a month are free", console: CONSOLE("logs/query"), daily: billed("observability") || {} });
    if (bill?.speech) add({ id: "speech", name: "Speech-to-Text", provider: "GCP", category: "AI", purpose: "Voice notes to text (fallback)", usedBy: "Backend", status: "ok", facts: [], source: "billed", daily: billed("speech") || {} });
    if (bill?.bigquery) add({ id: "bigquery", name: "BigQuery", provider: "GCP", category: "Data", purpose: "The billing export behind these numbers", usedBy: "Admin API", status: "ok", facts: [], source: "billed", daily: billed("bigquery") || {} });
    if (bill?.other) add({ id: "other-gcp", name: "Other Google services", provider: "GCP", category: "Other", purpose: "Anything else on the Google bill", usedBy: "—", status: "ok", facts: [], source: "billed", daily: billed("other") || {} });

    // WhatsApp (Meta): the real bill.
    const waToday = wa.volume[today] ?? 0;
    add({
        id: "whatsapp", name: "WhatsApp Cloud API", provider: "Meta", category: "Messaging", purpose: "Saheli's WhatsApp number: messages, reminders, alerts", usedBy: "Backend",
        status: wa.connected ? "ok" : "unknown",
        facts: wa.connected ? [{ label: "Today", value: `${waToday} messages · ₹${round2(wa.daily[today] ?? 0)}` }, ...Object.entries(wa.byCategory).map(([k, v]) => ({ label: `35 days: ${k}`, value: `${v.volume.toLocaleString("en-IN")} · ₹${round2(v.cost)}` }))] : [{ label: "Billing", value: wa.note || "not connected" }],
        source: wa.connected ? "billed" : "none", note: wa.connected ? "Meta's pricing analytics (replies inside 24 h are free)" : undefined, console: "https://business.facebook.com/wa/manage/insights/",
        daily: wa.daily,
    });

    // Browser Use: balance and its daily drop.
    const buDaily = bu.connected ? await settle("Browser Use history", () => balanceSpend("browser-use", bu.balanceUsd, days), errors) : null;
    add({
        id: "browser-use", name: "Browser Use", provider: "Browser Use", category: "AI agents", purpose: "The ordering agent's cloud browsers (Swiggy, 1mg, Uber…)", usedBy: "Backend, engine",
        status: !bu.connected ? "unknown" : (bu.balanceUsd ?? 0) < 5 ? "warn" : "ok",
        facts: bu.connected ? [{ label: "Balance", value: `$${round2(bu.balanceUsd ?? 0)}` }, { label: "Plan", value: bu.freeTier ? "free tier" : "paid" }, { label: "Browsers now", value: `${bu.activeSessions ?? 0} of ${bu.concurrentLimit ?? "?"}` }] : [{ label: "Account", value: bu.note || "not connected" }],
        source: bu.connected ? "metered" : "none", note: "Daily drop in the credit balance (a top-up shows as 0)", console: "https://cloud.browser-use.com/billing",
        daily: buDaily || {},
    });

    // ElevenLabs.
    add({
        id: "elevenlabs", name: "ElevenLabs", provider: "ElevenLabs", category: "AI", purpose: "Saheli's voice replies and voice reminders", usedBy: "Backend",
        status: el.connected ? (el.used != null && el.limit ? (el.used / el.limit > 0.9 ? "warn" : "ok") : "ok") : "unknown",
        facts: el.connected ? [{ label: "Plan", value: el.tier || "—" }, { label: "Characters", value: `${(el.used ?? 0).toLocaleString("en-IN")} of ${(el.limit ?? 0).toLocaleString("en-IN")}` }, { label: "Resets", value: el.resetsAt?.slice(0, 10) || "—" }] : [{ label: "Usage", value: el.note || "not connected" }],
        source: "none", note: "Monthly plan; usage shown when a read-only key is added", console: "https://elevenlabs.io/app/subscription", daily: {},
    });

    add({ id: "resend", name: "Resend", provider: "Resend", category: "Email", purpose: "Uptime alerts, admin sign-in codes, caregiver emails", usedBy: "Backend, admin API, uptime monitor", status: "ok", facts: [{ label: "Domain", value: "emails.kavach.care" }, { label: "Key", value: "send-only (usage not readable)" }], source: "none", console: "https://resend.com/emails", daily: {} });
    add({ id: "cloudflare", name: "Cloudflare", provider: "Cloudflare", category: "Edge & storage", purpose: "R2: nightly backups and cdn.kavach.care; Worker: uptime monitor", usedBy: "Backups, emails, uptime", status: "ok", facts: [{ label: "R2", value: "backups + public CDN" }, { label: "Worker", value: "uptime check every few minutes, KV state" }], source: "none", note: "Cloudflare billing not connected (within free limits so far)", console: "https://dash.cloudflare.com/", daily: {} });

    // AWS: standby AI (Bedrock, Mumbai), not in use yet.
    const awsSvc = Object.entries(aws.byService);
    if (awsSvc.length) for (const [name, daily] of awsSvc) add({ id: `aws:${name}`, name, provider: "AWS", category: /bedrock/i.test(name) ? "AI" : "Other", purpose: /bedrock/i.test(name) ? "Backup AI models" : "AWS service", usedBy: "—", status: "ok", facts: [], source: "billed", daily });
    else add({ id: "aws:bedrock", name: "Amazon Bedrock", provider: "AWS", category: "AI", purpose: "Backup AI if Gemini is down (ap-south-1, Mumbai)", usedBy: "Planned", status: "planned", facts: [{ label: "Credits", value: "$100 (Oct 2026)" }, { label: "Billing", value: aws.connected ? "connected" : "not connected" }], source: aws.connected ? "billed" : "none", daily: {} });

    /* ── roll-ups ── */

    const all = sumDaily(services.map((s) => s.daily));
    const providers = [...new Set(services.map((s) => s.provider))].map((p) => {
        const list = services.filter((s) => s.provider === p);
        const sources = new Set(list.filter((s) => s.source !== "none").map((s) => s.source));
        return { provider: p, services: list.length, source: sources.size === 1 ? [...sources][0] : sources.size ? ("mixed" as const) : ("none" as const), totals: totals(sumDaily(list.map((s) => s.daily)), now) };
    });

    const connections: Connection[] = [
        {
            id: "gcp-billing", name: "Google Cloud bill (BigQuery export)", provider: "GCP", connected: !!bill,
            detail: bill ? `Exact Google costs from ${billTable}` : "Google costs are estimates until the billing export is on",
            howTo: bill ? undefined : [
                "Google Cloud console → Billing → Billing export → BigQuery export.",
                `Standard usage cost → Edit settings → project ${gcp.PROJECT}, dataset ${gcp.BILLING_DATASET} (already created) → Save.`,
                "Numbers switch to the real bill within a few hours.",
            ],
        },
        { id: "meta", name: "WhatsApp bill (Meta)", provider: "Meta", connected: wa.connected, detail: wa.connected ? `Meta pricing analytics, ${wa.currency}` : wa.note || "not connected" },
        { id: "browser-use", name: "Browser Use balance", provider: "Browser Use", connected: bu.connected, detail: bu.connected ? "Balance read every refresh; daily spend = balance drop" : bu.note || "not connected" },
        {
            id: "aws", name: "AWS bill (Cost Explorer)", provider: "AWS", connected: aws.connected, detail: aws.connected ? "Daily AWS cost per service" : aws.note || "not connected",
            howTo: aws.connected ? undefined : [
                "AWS console → IAM → create user kavach-billing-reader with only ce:GetCostAndUsage (and enable Cost Explorer once).",
                "Create an access key; store it in Google Secret Manager as aws-billing-access-key-id and aws-billing-secret-access-key.",
                "Add both to the admin API deploy (deploy-admin-api.yml, --set-secrets) and redeploy.",
            ],
        },
        {
            id: "elevenlabs", name: "ElevenLabs usage", provider: "ElevenLabs", connected: el.connected, detail: el.connected ? "Characters this period" : el.note || "not connected",
            howTo: el.connected ? undefined : ["ElevenLabs → Developers → API keys → new key with only User: Read.", "Store it in Secret Manager as admin-elevenlabs-usage-key."],
        },
    ];

    const alerts: Alert[] = [];
    for (const s of services) {
        if (s.id.startsWith("artifacts:") && s.status === "warn") {
            const gb = s.facts.find((f) => f.label === "Size")?.value;
            alerts.push({ level: "warn", text: `Container images take ${gb} with no cleanup policy (≈₹${Math.round(s.totals.forecast ?? 0)}/month).`, action: "Add a cleanup policy keeping the latest 10 images per service." });
        }
        if (s.id.startsWith("sql:") && s.status === "warn") alerts.push({ level: "warn", text: "The Saheli memory database (Cloud SQL) has automatic backups off.", action: "Turn on daily backups (7 days) on the instance." });
        if (s.id === "compute" && s.status === "stopped") alerts.push({ level: "info", text: `A stopped VM still pays for its disk (${s.purpose}).`, action: "Delete the VM and its disk if it's no longer needed." });
        if (s.id.startsWith("run:") && s.status === "down") alerts.push({ level: "warn", text: `${s.name} isn't ready.` });
        if (s.id.startsWith("run:") && s.id !== "run:jobs" && s.status === "warn") alerts.push({ level: "warn", text: `${s.name}: more than 2% of requests failed in the last 24 hours.` });
        if (s.id === "browser-use" && s.status === "warn") alerts.push({ level: "warn", text: `Browser Use credit is low (${s.facts[0]?.value}). Orders stop when it runs out.`, action: "Top up Browser Use credits." });
        if (s.id === "vertex" && s.status === "warn") alerts.push({ level: "warn", text: "Model spend today passed the soft cap: Saheli is on the cheapest models." });
        if (s.id === "scheduler" && s.status === "warn") alerts.push({ level: "warn", text: `Scheduled jobs failing: ${s.facts[1]?.value}.` });
        if (s.id === "run:jobs" && s.status === "warn") alerts.push({ level: "warn", text: "A Cloud Run job's last run failed (backup or Saheli's night)." });
    }
    for (const r of run || []) {
        if (r.plainSecrets.length) alerts.push({ level: "warn", text: `${RUN_INFO[r.name]?.name || r.name} keeps ${r.plainSecrets.join(", ")} as plain settings, readable by anyone who can view the service.`, action: "Move them to Secret Manager (--set-secrets) and redeploy." });
    }
    const alwaysOn = (run || []).filter((s) => s.minInstances > 0);
    const google = providers.find((p) => p.provider === "GCP")?.totals.avg7 ?? 0;
    if (alwaysOn.length && google > 0) {
        const rows = services.filter((x) => alwaysOn.some((r) => x.id === `run:${r.name}`));
        const perDayInr = rows.reduce((t, x) => t + (x.totals.avg7 ?? 0), 0);
        alerts.push({ level: "info", text: `${rows.map((x) => x.name).join(" and ")} keep an instance running all day: ≈₹${Math.round(perDayInr)}/day, ${Math.round((perDayInr / google) * 100)}% of Google spend.`, action: "Check their size (vCPU, memory) against real load; smaller instances cut this directly." });
    }
    if (!bill) alerts.push({ level: "info", text: "Google costs are estimates: connect the billing export for exact numbers (steps below)." });

    const balances: Snapshot["balances"] = [];
    if (bu.connected && bu.balanceUsd != null) balances.push({ name: "Browser Use credit", provider: "Browser Use", value: `$${round2(bu.balanceUsd)}`, low: bu.balanceUsd < 5 });
    balances.push({ name: "AWS credits", provider: "AWS", value: "$100", low: false });

    return {
        at: new Date(now).toISOString(), usdInr: USD_INR, days, totals: totals(all, now),
        daily: days.map((d) => ({ day: d, inr: round2(all[d] ?? 0) })), providers, services,
        schedules: scheds || [], jobs: jobs || [], connections, alerts, balances, errors,
    };
}

/* ── cache: one build at a time, 10 minutes ── */

let cached: { at: number; snap: Snapshot } | null = null;
let building: Promise<Snapshot> | null = null;

export async function snapshot(fresh = false): Promise<Snapshot> {
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && (age < 10 * 60_000) && !(fresh && age > 60_000)) return cached.snap;
    building ??= buildSnapshot().then((snap) => {
        cached = { at: Date.now(), snap };
        return snap;
    }).finally(() => {
        building = null;
    });
    return building;
}

