/**
 * Jobs the admin API runs for a scheduler rather than a person: POST /admin/jobs/live-check (quality plan F7, F8).
 * Only ADMIN_JOB_SA may call (the GitHub deploy identity, on its hourly schedule and after each deploy): Cloud Run IAM
 * checks the Google ID token, and verifyCaller checks it is that account. No admin session, no data about anyone: the
 * answer is the checks' values, and a job can only run the read-only live check.
 */
import express, { type Router } from "express";
import { AdminError, verifyCaller, type AdminConfig } from "./auth";

export function buildJobsRouter(cfg: AdminConfig, deps: { verify?: typeof verifyCaller; run?: typeof import("./liveCheck").runLiveCheck } = {}): Router {
    const router = express.Router();
    const jobSa = (process.env.ADMIN_JOB_SA || "").toLowerCase().trim();
    router.post("/live-check", async (req, res) => {
        try {
            if (!jobSa && !cfg.insecureLocal) throw new AdminError(503, "jobs_not_configured");
            await (deps.verify ?? verifyCaller)(req.header("authorization"), { ...cfg, webServiceAccount: jobSa });
            const body = (req.body || {}) as { trigger?: string; service?: string; sha?: string };
            const trigger = body.trigger === "deploy" ? "deploy" : body.trigger === "manual" ? "manual" : "hourly";
            const service = typeof body.service === "string" ? /^[a-z][a-z-]{0,39}/.exec(body.service)?.[0] : undefined;
            const sha = typeof body.sha === "string" ? /^[0-9a-f]{7,40}/i.exec(body.sha)?.[0] : undefined;
            const run = deps.run ?? (await import("./liveCheck")).runLiveCheck;
            const row = await run({ trigger, service, sha });
            res.status(200).json({
                ok: row.ok, trigger: row.trigger, hourKey: row.hourKey, problems: row.problems, emailed: row.emailed,
                checks: row.checks.map(({ key, label, status, value }) => ({ key, label, status, value })),
            });
        } catch (e) {
            const status = e instanceof AdminError ? e.status : 500;
            if (status === 500) console.error("[live-check] job failed:", (e as Error).message);
            res.status(status).json({ error: e instanceof AdminError ? e.code : "job_failed" });
        }
    });
    return router;
}
