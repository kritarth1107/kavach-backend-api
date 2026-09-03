import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import {
    getCareBriefHandler,
    getCareRecordEventsHandler,
    getCareRecordMetricsHandler,
    getCareRecordTimelineHandler,
    getChannelIdentitiesHandler,
    getIntegrationsHandler,
    getOrderHistoryHandler,
    getPendingApprovalsHandler,
    postApproveOrderHandler,
    postChannelIdentityHandler,
    postPayOrderHandler,
    postRejectOrderHandler,
    postSuggestOrderHandler,
} from "../controllers/careRecord.controller";

const router = Router();

router.get("/:familyId/subjects/:subjectUserId/care-record/events", protect, getCareRecordEventsHandler);
router.get("/:familyId/subjects/:subjectUserId/care-record/timeline", protect, getCareRecordTimelineHandler);
router.get("/:familyId/subjects/:subjectUserId/care-record/metrics", protect, getCareRecordMetricsHandler);
router.get("/:familyId/subjects/:subjectUserId/care-brief", protect, getCareBriefHandler);

router.get("/:familyId/approvals/pending", protect, getPendingApprovalsHandler);
router.post("/:familyId/subjects/:subjectUserId/orders/suggest", protect, postSuggestOrderHandler);
router.post("/:familyId/orders/:orderId/approve", protect, postApproveOrderHandler);
router.post("/:familyId/orders/:orderId/pay", protect, postPayOrderHandler);
router.post("/:familyId/orders/:orderId/reject", protect, postRejectOrderHandler);
router.get("/:familyId/orders/history", protect, getOrderHistoryHandler);
router.get("/:familyId/integrations", protect, getIntegrationsHandler);

router.get("/:familyId/channel-identities", protect, getChannelIdentitiesHandler);
router.post("/:familyId/channel-identities", protect, postChannelIdentityHandler);

export default router;
