import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import {
    deleteMySession,
    getMyProfile,
    getMySessions,
    patchMyProfile,
    revokeOtherSessions,
} from "../controllers/user.controller";

const router = Router();

router.get("/me", protect, getMyProfile);
router.patch("/me", protect, patchMyProfile);
router.get("/me/sessions", protect, getMySessions);
router.post("/me/sessions/revoke-others", protect, revokeOtherSessions);
router.delete("/me/sessions/:sessionId", protect, deleteMySession);

export default router;
