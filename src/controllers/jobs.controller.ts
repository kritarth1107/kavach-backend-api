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
            const { deliverSaheliOutreach } = await import("../services/saheliOutreach.service");
            result = await deliverSaheliOutreach({
                familyId,
                recipientUserId,
                outreachKind: "casual",
                force: true,
                ignoreSpacing: true,
            });
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

/**
 * Nightly reflection (Cloud Scheduler ~02:30 IST). Auth: X-Kavach-Job-Secret or X-Kavach-Secret.
 * Body: { dayKey?: "YYYY-MM-DD" } for all elders, or { familyId, recipientUserId, dayKey? } / { phone }
 * (phone limited to smoke fixtures) for one elder on demand.
 */
export async function postReflectionJob(req: Request, res: Response, next: NextFunction) {
    try {
        const alt = req.header("X-Kavach-Secret");
        if (!(alt && alt === config.aiEngine.apiSecret)) assertJobAuth(req);
        const { reflectAll, reflectElderDay } = await import("../services/profile/reflection.service");
        const dayKey = req.body?.dayKey ? String(req.body.dayKey) : undefined;
        if (dayKey && !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) throw new AppError("dayKey must be YYYY-MM-DD", 400);
        let who: { familyId: string; recipientUserId: string } | null = null;
        if (req.body?.phone) {
            const phone = String(req.body.phone);
            const { isSmokeFixturePhone } = await import("../services/smokeFixtures.service");
            if (!isSmokeFixturePhone(phone)) throw new AppError("phone is limited to smoke fixture phones", 403);
            const { resolveWhatsAppSender } = await import("../services/identityResolver.service");
            const r = await resolveWhatsAppSender(phone);
            who = { familyId: r.familyId, recipientUserId: r.userId };
        } else if (req.body?.familyId && req.body?.recipientUserId) {
            who = { familyId: String(req.body.familyId), recipientUserId: String(req.body.recipientUserId) };
        }
        if (who) {
            res.json({ success: true, job: "reflection", result: await reflectElderDay(who, dayKey, { model: req.body?.model ? String(req.body.model) : undefined }) });
            return;
        }
        // Long run: answer now, keep working (Cloud Run keeps CPU for in-flight work only with always-on CPU; the
        // per-elder loop is short, so we await it but cap the scheduler's wait via its own deadline).
        res.json({ success: true, job: "reflection", ...(await reflectAll(dayKey)) });
    } catch (err) {
        next(err);
    }
}
