import { Request, Response, NextFunction } from "express";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

function assertJobAuth(req: Request) {
    const secret = config.health.secret;
    if (!secret) throw new AppError("Job endpoints not configured", 503);
    const header = req.headers["x-kavach-job-secret"] ?? req.query.secret;
    if (header !== secret) throw new AppError("Unauthorized job request", 401);
}

export async function postOutreachJob(req: Request, res: Response, next: NextFunction) {
    try {
        assertJobAuth(req);
        const { runOutreachTick } = await import("../workers/outreachScheduler");
        await runOutreachTick();
        res.json({ success: true, job: "outreach-tick" });
    } catch (err) {
        next(err);
    }
}

export async function postCareNudgeJob(req: Request, res: Response, next: NextFunction) {
    try {
        assertJobAuth(req);
        const { runCareNudgeJob } = await import("../workers/careNudgeScheduler");
        const result = await runCareNudgeJob();
        res.json({ success: true, job: "care-nudge-tick", ...result });
    } catch (err) {
        next(err);
    }
}

export async function postMemoryConsolidationJob(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        assertJobAuth(req);
        const { runMemoryConsolidationTick } = await import(
            "../workers/memoryConsolidationScheduler"
        );
        const result = await runMemoryConsolidationTick();
        res.json({ success: true, job: "memory-consolidation", ...result });
    } catch (err) {
        next(err);
    }
}
