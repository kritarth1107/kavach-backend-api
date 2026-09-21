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
        return postMemoryDreamJob(req, res, next);
    } catch (err) {
        next(err);
    }
}

export async function postMemoryDreamJob(req: Request, res: Response, next: NextFunction) {
    try {
        assertJobAuth(req);
        res.json({
            success: true,
            job: "memory-dream",
            message:
                "Dream job runs on kawach-ai-engine Cloud Run Job (python -m app.jobs.dream --all). Trigger via GCP Scheduler or engine CLI.",
        });
    } catch (err) {
        next(err);
    }
}

export async function getSaheliMemoryContextHandler(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        assertJobAuth(req);
        const { buildSaheliMemoryContext, buildSaheliMemoryContextByAiIds } = await import(
            "../services/saheliMemoryContext.service"
        );
        const aiFamilyId = String(req.query.aiFamilyId ?? "");
        const aiElderId = String(req.query.aiElderId ?? "");
        if (aiFamilyId && aiElderId) {
            const ctx = await buildSaheliMemoryContextByAiIds(aiFamilyId, aiElderId);
            if (!ctx) throw new AppError("AI tenant mapping not found", 404);
            return res.json({ data: ctx });
        }
        const { familyId, recipientUserId } = req.params;
        if (!familyId || !recipientUserId) {
            throw new AppError("familyId and recipientUserId required", 400);
        }
        const ctx = await buildSaheliMemoryContext(familyId, recipientUserId);
        if (!ctx) throw new AppError("AI tenant mapping not found", 404);
        res.json({ data: ctx });
    } catch (err) {
        next(err);
    }
}
