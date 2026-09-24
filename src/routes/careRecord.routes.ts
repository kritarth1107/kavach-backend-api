import { Router } from "express";
import { protect } from "../middleware/auth.middleware";
import {
    getCareBriefHandler,
    getDoctorBriefHandler,
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
import {
    getPartnerIntegrationDetailHandler,
    getPartnerOrderSettingsHandler,
    patchPartnerOrderSettingsHandler,
} from "../controllers/integrationPartner.controller";

const router = Router();

router.get("/:familyId/subjects/:subjectUserId/care-record/events", protect, getCareRecordEventsHandler);
router.get("/:familyId/subjects/:subjectUserId/care-record/timeline", protect, getCareRecordTimelineHandler);
router.get("/:familyId/subjects/:subjectUserId/care-record/metrics", protect, getCareRecordMetricsHandler);
router.get("/:familyId/subjects/:subjectUserId/care-brief", protect, getCareBriefHandler);
router.get("/:familyId/subjects/:subjectUserId/doctor-brief", protect, getDoctorBriefHandler);

router.get("/:familyId/approvals/pending", protect, getPendingApprovalsHandler);
router.post("/:familyId/subjects/:subjectUserId/orders/suggest", protect, postSuggestOrderHandler);
router.post("/:familyId/orders/:orderId/approve", protect, postApproveOrderHandler);
router.post("/:familyId/orders/:orderId/pay", protect, postPayOrderHandler);
router.post("/:familyId/orders/:orderId/reject", protect, postRejectOrderHandler);
router.get("/:familyId/orders/history", protect, getOrderHistoryHandler);
router.get("/:familyId/integrations", protect, getIntegrationsHandler);
router.get("/:familyId/integrations/:partner/detail", protect, getPartnerIntegrationDetailHandler);
router.get("/:familyId/integrations/:partner/settings", protect, getPartnerOrderSettingsHandler);
router.patch("/:familyId/integrations/:partner/settings", protect, patchPartnerOrderSettingsHandler);

router.get("/:familyId/channel-identities", protect, getChannelIdentitiesHandler);
router.post("/:familyId/channel-identities", protect, postChannelIdentityHandler);

export default router;
