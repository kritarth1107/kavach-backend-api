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

import * as careMemory from "../controllers/careMemory.controller";

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

// Saheli's care memory and tasks (ai-engine /v2/dash), caregivers only
const cm = "/:familyId/subjects/:subjectUserId/care-memory";
router.get(`${cm}/overview`, protect, wrap(careMemory.getOverview));
router.get(`${cm}/home`, protect, wrap(careMemory.getHome));
router.get(`${cm}/history`, protect, wrap(careMemory.getFactHistory));
router.get(`${cm}/events`, protect, wrap(careMemory.getEvents));
router.post(`${cm}/facts`, protect, wrap(careMemory.postFact));
router.post(`${cm}/facts/stop`, protect, wrap(careMemory.postStopFact));
router.post(`${cm}/facts/resolve`, protect, wrap(careMemory.postResolveFact));
router.post(`${cm}/loops/:loopId/close`, protect, wrap(careMemory.postCloseLoop));
router.put(`${cm}/notes`, protect, wrap(careMemory.putNote));
router.post(`${cm}/tasks/:taskId/input`, protect, wrap(careMemory.postTaskInput));
router.post(`${cm}/tasks/:taskId/cancel`, protect, wrap(careMemory.postTaskCancel));
router.get(`${cm}/tasks/:taskId/live`, protect, wrap(careMemory.getTaskLive));
router.get(`${cm}/stock`, protect, wrap(careMemory.getStock));
router.post(`${cm}/stock`, protect, wrap(careMemory.postStock));
router.post(`${cm}/stock/:key/order`, protect, wrap(careMemory.postRefillOrder));
router.get(`${cm}/emergency`, protect, wrap(careMemory.getEmergency));
router.get(`${cm}/care-team`, protect, wrap(careMemory.getCareTeam));
router.post(`${cm}/appointments/question`, protect, wrap(careMemory.postAppointmentQuestion));
router.get(`${cm}/report`, protect, wrap(careMemory.getReport));
router.get(`${cm}/wellbeing`, protect, wrap(careMemory.getWellbeing));
router.get(`${cm}/patterns`, protect, wrap(careMemory.getPatterns));
router.get(`${cm}/outcomes`, protect, wrap(careMemory.getOutcomes));
router.post(`${cm}/outcomes`, protect, wrap(careMemory.postOutcome));
router.post(`${cm}/feedback`, protect, wrap(careMemory.postFeedback));
router.get(`${cm}/consent`, protect, wrap(careMemory.getConsent));
router.post(`${cm}/consent`, protect, wrap(careMemory.postConsent));
router.get(`${cm}/family-tasks`, protect, wrap(careMemory.getFamilyTasks));
router.post(`${cm}/family-tasks`, protect, wrap(careMemory.postFamilyTask));
router.post(`${cm}/family-tasks/:taskId/done`, protect, wrap(careMemory.postFamilyTaskDone));
router.get(`${cm}/spending`, protect, wrap(careMemory.getSpending));
router.get(`${cm}/emergency-link`, protect, wrap(careMemory.getEmergencyLink));
router.post(`${cm}/emergency-link`, protect, wrap(careMemory.postEmergencyLink));
router.delete(`${cm}/emergency-link`, protect, wrap(careMemory.deleteEmergencyLink));

export default router;
