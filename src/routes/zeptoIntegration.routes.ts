import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import {
    deleteZeptoConnectHandler,
    getZeptoConnectHandler,
    getZeptoOAuthCallbackHandler,
    getZeptoStatusHandler,
    postZeptoOAuthCallbackHandler,
} from "../controllers/zeptoIntegration.controller";

const router = Router();

router.get("/zepto/callback", getZeptoOAuthCallbackHandler);
router.post("/zepto/callback", postZeptoOAuthCallbackHandler);

export default router;

export const familyZeptoRouter = Router();
familyZeptoRouter.get("/:familyId/integrations/zepto/connect", protect, getZeptoConnectHandler);
familyZeptoRouter.get("/:familyId/integrations/zepto/status", protect, getZeptoStatusHandler);
familyZeptoRouter.delete("/:familyId/integrations/zepto", protect, deleteZeptoConnectHandler);
