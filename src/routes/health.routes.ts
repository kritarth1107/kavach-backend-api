import { Router } from "express";
import { getDetailedHealth, getEngineHealth, getHealth } from "../controllers/health.controller";

const router = Router();

router.get("/", getHealth);
router.get("/detailed", getDetailedHealth);
router.get("/engine", getEngineHealth);

export default router;
