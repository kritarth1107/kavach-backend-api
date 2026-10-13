import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import { decideApprovalHandler, deleteWhyHandler, dismissTaskHandler, getDelegateHandler } from "../controllers/delegate.controller";

/** Saheli as a persistent delegate (mounted under /api/families). */
const router = Router();
router.get("/:familyId/recipients/:recipientUserId/saheli/delegate", protect, getDelegateHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/why/:whyId", protect, deleteWhyHandler);
// What Saheli may do is the family's boundaries in the care record (care-memory/boundaries), trust plan A1.
router.post("/:familyId/saheli/approvals/:taskId", protect, decideApprovalHandler);
router.post("/:familyId/saheli/tasks/:taskId/dismiss", protect, dismissTaskHandler);
export default router;
