/**
 * The admin "Daily score" page (trust plan C1, A2, C2, C3), via the engine's /v2/admin routes:
 * - the live score (the three checks of 3 Oct and their minimum), its 30-day trend and every failure
 * - the memory score per family, the nightly world score (per language, household type, topic), replay case counts
 * - the judge's monthly calibration: people's yes/no on its verdicts
 * Masked by default like every admin view: first names become "Sarla D."-style, and what a failure quotes (Saheli's
 * words, what they said, a medicine or reminder) is shown only to roles with break-glass access.
 */
import { z } from "zod";
import { AdminError } from "../auth";
import { engine } from "../engine";
import { maskName } from "../mask";
import { can } from "../permissions";
import type { RouteDef } from "../router";

const QUOTES = ["words", "said", "item", "old", "new", "expected", "got", "problems", "reply", "note"] as const;

/** One failure line as the page may show it: names masked; quotes only with break-glass access. */
export function maskFailure(f: Record<string, unknown>, reveal: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { ...f };
    if (typeof out.person === "string") out.person = maskName(out.person) || "";
    if (!reveal) for (const k of QUOTES) if (k in out) delete out[k];
    return out;
}

export function maskPage(page: Record<string, unknown>, reveal: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = { ...page };
    out.failures = Array.isArray(page.failures) ? (page.failures as Array<Record<string, unknown>>).map((f) => maskFailure(f, reveal)) : [];
    if (Array.isArray(page.memory)) {
        out.memory = (page.memory as Array<Record<string, unknown>>).map((m) => ({
            ...m, failures: Array.isArray(m.failures) ? (m.failures as Array<Record<string, unknown>>).map((f) => maskFailure(f, reveal)) : [],
            unknowns: Array.isArray(m.unknowns) ? (m.unknowns as string[]).map((u) => (reveal ? u : u.replace(/^[^:]+:/, (n) => `${maskName(n.slice(0, -1)) || "someone"}:`))) : [],
        }));
    }
    if (page.today && typeof page.today === "object") {
        const today = { ...(page.today as Record<string, Record<string, unknown>>) };
        for (const [k, v] of Object.entries(today)) {
            const detail = { ...((v?.detail as Record<string, unknown>) || {}) };
            if (!reveal) delete detail.invented;
            if (Array.isArray(detail.checked)) detail.checked = (detail.checked as Array<Record<string, unknown>>).map((c) => maskFailure(c, reveal));
            today[k] = { ...v, detail };
        }
        out.today = today;
    }
    const world = page.world as { latest?: { scores?: Record<string, unknown> } } | undefined;
    if (world?.latest?.scores) {
        // invented families: the probes' texts are safe, but the page needs numbers only
        const { examples: _e, judge_failures: _j, ...scores } = world.latest.scores as Record<string, unknown>;
        out.world = { ...world, latest: { ...world.latest, scores } };
    }
    out.reveal = reveal;
    return out;
}

export function qualityRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/quality/daily-score", perm: "overview.read", action: "quality.daily_score",
            handler: async ({ admin, query }) => {
                const days = Math.min(Math.max(Number(query.days) || 30, 1), 90);
                const day = /^\d{4}-\d{2}-\d{2}$/.test(query.day || "") ? `&day=${query.day}` : "";
                const page = await engine<Record<string, unknown>>("GET", `/daily-score?days=${days}${day}`, undefined, 45_000);
                return { data: maskPage(page, can(admin.role, "care.breakglass")), detail: { days, day: query.day || null } };
            },
        },
        {
            method: "get", path: "/quality/eval-scores", perm: "overview.read", action: "quality.eval_scores",
            handler: async ({ query }) => ({ data: await engine("GET", `/eval-scores?days=${Math.min(Math.max(Number(query.days) || 30, 1), 120)}`, undefined, 30_000) }),
        },
        {
            // the replies to label carry what was said: break-glass roles only, every read audited
            method: "get", path: "/quality/calibration", perm: "care.breakglass", action: "quality.calibration",
            handler: async ({ query }) => {
                const batch = /^\d{4}-\d{2}$/.test(query.batch || "") ? `?batch=${query.batch}` : "";
                return { data: await engine("GET", `/calibration${batch}`, undefined, 30_000) };
            },
        },
        {
            method: "post", path: "/quality/calibration/:id", perm: "care.breakglass", action: "quality.calibration_label",
            handler: async ({ admin, params, body }) => {
                const input = z.object({ good: z.boolean(), note: z.string().max(500).optional() }).safeParse(body);
                if (!input.success || !/^\d+$/.test(params.id || "")) throw new AdminError(400, "bad_request");
                const data = await engine("POST", `/calibration/${params.id}`, { good: input.data.good, by: admin.email, note: input.data.note || "" });
                return { data, target: `judge_label:${params.id}`, detail: { good: input.data.good } };
            },
        },
    ];
}
