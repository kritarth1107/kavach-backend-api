import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";

import { executeTool } from "../controllers/saheliTools.controller";
import {
    postCareNudgeJob,
    postMemoryConsolidationJob,
    postMemoryDreamJob,
    postOutreachJob,
    postNudgeSimJob,
    postReflectionJob,
    postDailySnapshotJob,
    getSaheliMemoryContextHandler,
} from "../controllers/jobs.controller";

const router = Router();

// Express 4 does not catch a rejected async handler: the error went to unhandledRejection and the engine waited
// 35 s for an answer that never came (live 2026-10-09 15:05: Maa's Blinkit price never reached her). Errors now
// reach the error handler and come back as a status at once.
const safe =
    (fn: (req: Request, res: Response) => unknown): RequestHandler =>
    (req: Request, res: Response, next: NextFunction) =>
        Promise.resolve()
            .then(() => fn(req, res))
            .catch(next);

router.post("/v1/saheli/tools/execute", safe(executeTool));
router.post("/v1/jobs/outreach-tick", postOutreachJob);
router.post("/v1/jobs/care-nudge-tick", postCareNudgeJob);
router.post("/v1/jobs/nudge-sim", postNudgeSimJob);
router.post("/v1/jobs/memory-consolidation", postMemoryConsolidationJob);
router.post("/v1/jobs/memory-dream", postMemoryDreamJob);
router.post("/v1/jobs/elder-reflection", postReflectionJob);
router.post("/v1/jobs/daily-snapshot", postDailySnapshotJob);
router.get("/v1/saheli/memory-context/:familyId/:recipientUserId", getSaheliMemoryContextHandler);
router.get("/v1/saheli/memory-context", getSaheliMemoryContextHandler);

export default router;
