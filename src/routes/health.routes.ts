import { Router } from "express";
import { getDetailedHealth, getEngineHealth, getHealth, getModelsHealth, getRemindersHealth } from "../controllers/health.controller";

const router = Router();

router.get("/", getHealth);
router.get("/detailed", getDetailedHealth);
router.get("/engine", getEngineHealth);
router.get("/reminders", getRemindersHealth);
router.get("/models", getModelsHealth);

export default router;
