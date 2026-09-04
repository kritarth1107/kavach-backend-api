import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import {
    deleteMcpConnectHandler,
    getMcpConnectHandler,
    getMcpOAuthCallbackHandler,
    getMcpStatusHandler,
    postMcpOAuthCallbackHandler,
} from "../controllers/mcpIntegration.controller";

const router = Router();

router.get("/:partner/callback", getMcpOAuthCallbackHandler);
router.post("/:partner/callback", postMcpOAuthCallbackHandler);

export default router;

export const familyMcpRouter = Router();
familyMcpRouter.get(
    "/:familyId/integrations/:partner/connect",
    protect,
    getMcpConnectHandler,
);
familyMcpRouter.get(
    "/:familyId/integrations/:partner/status",
    protect,
    getMcpStatusHandler,
);
familyMcpRouter.delete(
    "/:familyId/integrations/:partner",
    protect,
    deleteMcpConnectHandler,
);
