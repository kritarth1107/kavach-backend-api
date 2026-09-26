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

import {
    getActivityHandler,
    getDailySnapshotHandler,
    listDailySnapshotsHandler,
    postDailySnapshotHandler,
} from "../controllers/activity.controller";

import {
    createFamilyAddressHandler,
    deleteFamilyAddressHandler,
    getFamilyAddressHandler,
    listFamilyAddressesHandler,
    setDefaultFamilyAddressHandler,
    updateFamilyAddressHandler,
} from "../controllers/familyAddress.controller";

const router = Router();

// Express 4: forward async errors (AppError 403/404/429) to the error middleware.
const wrap =
    (fn: (req: import("express").Request, res: import("express").Response) => Promise<void>) =>
    (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) =>
        fn(req, res).catch(next);

// Family address book (docs/address-book-api.md)
router.get("/:familyId/addresses", protect, wrap(listFamilyAddressesHandler));
router.post("/:familyId/addresses", protect, wrap(createFamilyAddressHandler));
router.get("/:familyId/addresses/:addressId", protect, wrap(getFamilyAddressHandler));
router.patch("/:familyId/addresses/:addressId", protect, wrap(updateFamilyAddressHandler));
router.delete("/:familyId/addresses/:addressId", protect, wrap(deleteFamilyAddressHandler));
router.put("/:familyId/addresses/:addressId/default", protect, wrap(setDefaultFamilyAddressHandler));

// Caregiver activity feed + daily snapshot (docs/activity-api-contract.md)
router.get("/:familyId/subjects/:subjectUserId/activity", protect, wrap(getActivityHandler));
router.get("/:familyId/subjects/:subjectUserId/daily-snapshot", protect, wrap(getDailySnapshotHandler));
router.post("/:familyId/subjects/:subjectUserId/daily-snapshot", protect, wrap(postDailySnapshotHandler));
router.get("/:familyId/subjects/:subjectUserId/daily-snapshots", protect, wrap(listDailySnapshotsHandler));

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
