/** Infrastructure: every service we run on (GCP, AWS, others), its state, spend per day and month, and AI models. */
import { engineOrNull } from "../engine";
import { github } from "../infra/github";
import { models } from "../infra/models";
import { AdminError } from "../auth";
import { costAnalysis, deleteGrant, saveGrant } from "../infra/costs";
import { cronView, dataView, ecsDetail, trainerView } from "../infra/ops";
import { ECS_NAMES, snapshot } from "../infra/summary";
import type { RouteDef } from "../router";

type JobRuns = Array<{ job: string; lastAt: string; lastMs: number; lastOk: boolean; lastCode: number; runs24h: number; failed24h: number; p90Ms: number | null }>;

export function infraRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/infra", perm: "infra.read", action: "infra.overview",
            handler: async ({ query }) => {
                const s = await snapshot(query.fresh === "1");
                return { data: { at: s.at, usdInr: s.usdInr, totals: s.totals, daily: s.daily, providers: s.providers, alerts: s.alerts, connections: s.connections, balances: s.balances, errors: s.errors,
                    top: [...s.services].filter((x) => (x.totals.mtd ?? 0) > 0).sort((a, b) => (b.totals.mtd ?? 0) - (a.totals.mtd ?? 0)).slice(0, 8).map(({ daily: _d, facts: _f, ...x }) => x) } };
            },
        },
        {
            method: "get", path: "/infra/services", perm: "infra.read", action: "infra.services",
            handler: async ({ query }) => {
                const [s, runs] = await Promise.all([snapshot(query.fresh === "1"), engineOrNull<{ jobs: JobRuns }>("GET", "/job-runs?days=3")]);
                // Job runs are read live (the snapshot is cached for minutes): the engine keeps every /v2/jobs call and the night run.
                const byJob = new Map((runs.data?.jobs || []).map((j) => [j.job, j]));
                const schedules = s.schedules.map((x) => {
                    const r = (x as { job?: string | null }).job ? byJob.get((x as { job?: string | null }).job!) : undefined;
                    return r ? { ...x, lastAttemptAt: r.lastAt, failed: !r.lastOk, lastMs: r.lastMs, runs24h: r.runs24h, failed24h: r.failed24h, p90Ms: r.p90Ms, tracked: true }
                        : { ...x, tracked: x.name === "Care reminders" };
                });
                return { data: { at: s.at, totals: s.totals, services: s.services.map(({ daily: _d, ...x }) => x), schedules, jobs: s.jobs, errors: [...s.errors, ...(runs.error ? [`job runs: ${runs.error}`] : [])] } };
            },
        },
        {
            method: "get", path: "/infra/ecs/:service", perm: "infra.read", action: "infra.ecs",
            handler: async ({ params, query }) => {
                if (!ECS_NAMES.includes(params.service)) return { data: { service: params.service, errors: ["not a Kavach service"] } };
                return { data: await ecsDetail(params.service, Math.max(1, Math.min(168, Number(query.hours) || 24))) };
            },
        },
        {
            method: "get", path: "/infra/costs", perm: "infra.read", action: "infra.costs",
            handler: async () => ({ data: await costAnalysis() }),
        },
        {
            // A credit grant (no provider API tells how much was given or when it ends): remaining = amount − used on the bill.
            method: "post", path: "/infra/costs/credits", perm: "spend.manage", action: "infra.credit_grant",
            handler: async ({ admin, body }) => {
                const b = (body || {}) as Record<string, unknown>;
                const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
                const amount = Number(b.amount);
                const startsAt = new Date(String(b.startsAt || ""));
                const expiresAt = b.expiresAt ? new Date(String(b.expiresAt)) : null;
                const provider = str(b.provider, 40), label = str(b.label, 120);
                if (!provider || !label || !Number.isFinite(amount) || amount <= 0 || isNaN(startsAt.getTime()) || (expiresAt && isNaN(expiresAt.getTime()))) throw new AdminError(400, "bad_input");
                const g = await saveGrant({ grantId: str(b.grantId, 40) || undefined, provider, project: str(b.project, 80) || null, label, amount,
                    currency: b.currency === "INR" ? "INR" : "USD", startsAt, expiresAt, note: str(b.note, 300) || null }, admin.email);
                return { target: `credit:${g.grantId}`, data: { grantId: g.grantId } };
            },
        },
        {
            method: "post", path: "/infra/costs/credits/:grantId/delete", perm: "spend.manage", action: "infra.credit_grant_delete",
            handler: async ({ params }) => ({ target: `credit:${params.grantId}`, data: { deleted: await deleteGrant(params.grantId) } }),
        },
        {
            method: "get", path: "/infra/cron", perm: "infra.read", action: "infra.cron",
            handler: async () => ({ data: await cronView() }),
        },
        {
            method: "get", path: "/infra/data", perm: "infra.read", action: "infra.data",
            handler: async ({ query }) => ({ data: await dataView(Math.max(1, Math.min(168, Number(query.hours) || 24))) }),
        },
        {
            method: "get", path: "/infra/trainer", perm: "infra.read", action: "infra.trainer",
            handler: async () => ({ data: await trainerView() }),
        },
        {
            method: "get", path: "/infra/github", perm: "infra.read", action: "infra.github",
            handler: async ({ query }) => ({ data: await github(query.fresh === "1") }),
        },
        {
            method: "get", path: "/infra/telemetry", perm: "infra.read", action: "infra.telemetry",
            handler: async ({ query }) => {
                const hours = Math.max(1, Math.min(168, Number(query.hours) || 24));
                const t = await engineOrNull<unknown>("GET", `/telemetry?hours=${hours}`);
                return { data: { hours, at: new Date().toISOString(), telemetry: t.data, error: t.error ?? null } };
            },
        },
        {
            method: "get", path: "/infra/models", perm: "infra.read", action: "infra.models",
            handler: async () => ({ data: await models() }),
        },
    ];
}
