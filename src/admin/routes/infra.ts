/** Infrastructure: every service we run on (GCP, AWS, others), its state, spend per day and month, and AI models. */
import { models } from "../infra/models";
import { snapshot } from "../infra/summary";
import type { RouteDef } from "../router";

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
                const s = await snapshot(query.fresh === "1");
                return { data: { at: s.at, totals: s.totals, services: s.services.map(({ daily: _d, ...x }) => x), schedules: s.schedules, jobs: s.jobs, errors: s.errors } };
            },
        },
        {
            method: "get", path: "/infra/models", perm: "infra.read", action: "infra.models",
            handler: async () => ({ data: await models() }),
        },
    ];
}
