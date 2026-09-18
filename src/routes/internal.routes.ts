import { Router } from "express";
import { executeTool } from "../controllers/saheliTools.controller";

const router = Router();

router.post("/v1/saheli/tools/execute", executeTool);

export default router;
