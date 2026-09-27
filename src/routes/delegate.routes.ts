import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { decideApprovalHandler, deleteWhyHandler, dismissTaskHandler, getDelegateHandler, patchPermissionsHandler } from "../controllers/delegate.controller";

/** Saheli as a persistent delegate (mounted under /api/families). */
const router = Router();
router.get("/:familyId/recipients/:recipientUserId/saheli/delegate", protect, getDelegateHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/why/:whyId", protect, deleteWhyHandler);
router.patch("/:familyId/saheli/permissions", protect, patchPermissionsHandler);
router.post("/:familyId/saheli/approvals/:taskId", protect, decideApprovalHandler);
router.post("/:familyId/saheli/tasks/:taskId/dismiss", protect, dismissTaskHandler);
export default router;
