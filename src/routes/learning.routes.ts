import { NextFunction, Request, Response, Router } from "express";
import * as learning from "../controllers/learning.controller";
import { protect } from "../middleware/auth.middleware";

const router = Router();
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

router.get("/check", protect, wrap(learning.getAdminCheck));
router.get("/learning", protect, wrap(learning.getLearning));
router.post("/learning/playbooks/:version/:action(approve|block)", protect, wrap(learning.postPlaybookAction));
router.post("/learning/rules/:id/:action(approve|reject)", protect, wrap(learning.postRuleAction));

export default router;
