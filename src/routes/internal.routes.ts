import { Router } from "express";
import { executeTool } from "../controllers/saheliTools.controller";
import {
    postCareNudgeJob,
    postMemoryConsolidationJob,
    postMemoryDreamJob,
    postOutreachJob,
    getSaheliMemoryContextHandler,
} from "../controllers/jobs.controller";

const router = Router();

router.post("/v1/saheli/tools/execute", executeTool);
router.post("/v1/jobs/outreach-tick", postOutreachJob);
router.post("/v1/jobs/care-nudge-tick", postCareNudgeJob);
router.post("/v1/jobs/memory-consolidation", postMemoryConsolidationJob);
router.post("/v1/jobs/memory-dream", postMemoryDreamJob);
router.get("/v1/saheli/memory-context/:familyId/:recipientUserId", getSaheliMemoryContextHandler);
router.get("/v1/saheli/memory-context", getSaheliMemoryContextHandler);

export default router;
