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
        // The old outreach messages went with the old brain (trust plan A1) and the silence alert reads the delivery ledger
        // (escalation.service, run by the care-nudge tick, trust plan B2): nothing is left for this tick to do.
        res.json({ success: true, job: "outreach-tick", retired: true });
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

/**
 * Test hook (job secret + smoke-fixture families only): fire one companion nudge now and/or run
 * the silence-alert check with a shortened grace, to exercise follow-ups without waiting hours.
 * Body: { phone: "+9991000000xx", action: "fire" | "check" | "status", graceMinutes?: number }
 */
export async function postNudgeSimJob(req: Request, res: Response, next: NextFunction) {
    try {
        assertJobAuth(req);
        const phone = String(req.body?.phone ?? "");
        const { isSmokeFixturePhone } = await import("../services/smokeFixtures.service");
        if (!isSmokeFixturePhone(phone)) throw new AppError("nudge-sim is limited to smoke fixture phones", 403);
        const { resolveWhatsAppSender } = await import("../services/identityResolver.service");
        const who = await resolveWhatsAppSender(phone);
        const { familyId, userId: recipientUserId } = who;
        const action = String(req.body?.action ?? "status");
        const streakSvc = await import("../services/saheliNudgeStreak.service");
        let result: unknown = null;
        if (action === "fire") {
            // The old (v1) outreach message is gone (trust plan A1); check-ins come from the engine's regular nudges.
            result = { retired: true };
        } else if (action === "check") {
            const graceMinutes = Number(req.body?.graceMinutes);
            result = await streakSvc.checkSilenceAndAlert(familyId, recipientUserId, {
                graceMs: Number.isFinite(graceMinutes) ? Math.max(0, graceMinutes) * 60_000 : undefined,
                respectQuietHours: false,
            });
        }
        const { streak, companion } = await streakSvc.loadStreak(familyId, recipientUserId);
        res.json({
            success: true,
            job: "nudge-sim",
            action,
            result,
            streak: streak.map((n) => ({ text: n.text, wamid: n.wamid, sentAt: n.sentAt })),
            silenceAlertAt: companion?.silenceAlertAt ?? null,
        });
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


/**
 * The nightly reflection that wrote the old Mongo profile is retired for every family (trust plan A1): the engine's
 * nightly brief, mood and baselines replace it. The scheduler's call is answered (and logged) until its job is removed.
 */
export async function postReflectionJob(req: Request, res: Response, next: NextFunction) {
    try {
        const alt = req.header("X-Kavach-Secret");
        if (!(alt && alt === config.aiEngine.apiSecret)) assertJobAuth(req);
        console.log("[jobs] elder-reflection called: retired (the engine's nightly brief replaces it)");
        res.json({ success: true, job: "reflection", retired: true });
    } catch (err) {
        next(err);
    }
}

/** The daily "0 writes to the old memory stores" check (trust plan A1): GET the last 7 days, POST to count now. */
export async function legacyWritesJob(req: Request, res: Response, next: NextFunction) {
    try {
        assertJobAuth(req);
        const L = await import("../services/legacyWriteCheck.service");
        if (req.method === "POST") {
            res.json({ success: true, job: "legacy-writes", result: await L.runLegacyWriteCheck(new Date(), { force: true }) });
            return;
        }
        res.json({ success: true, job: "legacy-writes", ...(await L.legacyWriteReport(Number(req.query.days ?? 7) || 7)) });
    } catch (err) {
        next(err);
    }
}
