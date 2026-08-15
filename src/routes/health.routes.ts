import { Router } from "express";
import { getDetailedHealth, getHealth } from "../controllers/health.controller";

const router = Router();

router.get("/", getHealth);
router.get("/detailed", getDetailedHealth);

export default router;
