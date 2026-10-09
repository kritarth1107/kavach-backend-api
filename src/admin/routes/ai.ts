/** Saheli's AI: model spend, ordering agents, learning (playbooks, rules) with approve/block. Via the engine's /v2/admin. */
import { z } from "zod";
import { AdminError } from "../auth";
import { engine } from "../engine";
import type { RouteDef } from "../router";

export function aiRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/ai/spend", perm: "overview.read", action: "ai.spend",
            handler: async ({ query }) => ({ data: await engine("GET", `/spend?days=${Math.min(Math.max(Number(query.days) || 30, 1), 90)}`) }),
        },
        {
            method: "get", path: "/ai/agents", perm: "overview.read", action: "ai.agents",
            handler: async ({ query }) => ({ data: await engine("GET", `/metrics?days=${Math.min(Math.max(Number(query.days) || 7, 1), 90)}`, undefined, 40_000) }),
        },
        {
            method: "get", path: "/ai/learning", perm: "overview.read", action: "ai.learning",
            handler: async ({ query }) => {
                // Only what the page shows: never the anonymised conversation snippets (examples, evidence, samples).
                const l = await engine<Record<string, unknown> & { playbooks?: Array<Record<string, unknown>>; ruleProposals?: Array<Record<string, unknown>>; gaps?: Array<Record<string, unknown>> }>("GET", `/learn?weeks=${Math.min(Math.max(Number(query.weeks) || 8, 1), 52)}`, undefined, 45_000);
                return {
                    data: {
                        messages: l.messages, scored: l.scored, avgScore: l.avgScore, corpus: l.corpus, trend: l.trend,
                        playbooks: (l.playbooks || []).map((p) => ({ version: p.version, status: p.status, scope: p.scope, createdAt: p.createdAt, note: p.note,
                            lessons: Array.isArray(p.lessons) ? p.lessons.length : 0, approvedBy: p.approvedBy, liveSince: p.liveSince })),
                        ruleProposals: (l.ruleProposals || []).map((r) => ({ id: r.id, situation: r.situation, rule: r.rule, why: r.why, status: r.status, at: r.at })),
                        gaps: (l.gaps || []).map((g) => ({ label: g.label ?? g.gap ?? g.key ?? null, n: g.n ?? g.count ?? null })),
                    },
                };
            },
        },
        {
            method: "get", path: "/ai/flywheel", perm: "overview.read", action: "ai.flywheel",
            // numbers only (no conversation text): tasks, conversations, check-ins, per-family adherence/delegation, learning, credit
            handler: async ({ query }) => ({ data: await engine("GET", `/flywheel?days=${Math.min(Math.max(Number(query.days) || 14, 1), 90)}`, undefined, 45_000) }),
        },
        {
            method: "post", path: "/ai/playbooks/:version", perm: "learning.manage", action: "ai.playbook",
            handler: async ({ admin, params, body }) => {
                const version = Number(params.version);
                const input = z.object({ action: z.enum(["approve", "block"]) }).safeParse(body);
                if (!Number.isInteger(version) || version < 1 || !input.success) throw new AdminError(400, "bad_input");
                const data = await engine("POST", `/learn/playbooks/${version}/${input.data.action}`, { by: admin.email.slice(0, 64) });
                return { target: `playbook:${version}`, detail: { action: input.data.action }, data };
            },
        },
        {
            method: "post", path: "/ai/rules/:id", perm: "learning.manage", action: "ai.rule",
            handler: async ({ admin, params, body }) => {
                const id = Number(params.id);
                const input = z.object({ approve: z.boolean() }).safeParse(body);
                if (!Number.isInteger(id) || id < 1 || !input.success) throw new AdminError(400, "bad_input");
                const data = await engine("POST", `/learn/rules/${id}`, { by: admin.email.slice(0, 64), approve: input.data.approve });
                return { target: `rule:${id}`, detail: { approve: input.data.approve }, data };
            },
        },
    ];
}
