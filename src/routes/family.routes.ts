import { Router } from "express";
import {
    careActionHandler,
    confirmFactHandler,
    dismissAlertHandler,
    dismissDeviationHandler,
    editFactHandler,
    getProfileHandler,
    rejectFactHandler,
    retentionHandler,
} from "../controllers/elderProfile.controller";
import { deleteUsualDeclineHandler, deleteUsualItemHandler, getUsualsHandler } from "../controllers/usuals.controller";
import {
    acceptInvitation,
    acceptInvitationByIdHandler,
    createFamily,
    deleteInvitation,
    deleteMember,
    getFamily,
    getFamilySwitcher,
    getPendingInvitations,
    inviteMember,
    listFamilies,
    listFamilyMembers,
    patchInvitationDetails,
    patchMemberDetails,
    patchMemberStatus,
    rejectInvitationByIdHandler,
    setPrimaryFamilyHandler,
    switchActiveFamily,
    updateFamily,
} from "../controllers/family.controller";
import {
    getRecipientCareSchedule,
    patchRecipientCareSchedule,
    postRecipientCareSchedule,
    putScheduleCompletion,
    removeRecipientCareSchedule,
} from "../controllers/careSchedule.controller";
import {
    getCompanionSettings,
    getCompanionActivity,
    patchCompanionSettings,
    triggerOutreach,
    getFamilyMemories,
    forgetFamilyMemory,
    correctFamilyMemory,
    getSaheliMemoryProfile,
    getSaheliMemoryEntity,
    getSaheliMemoryEntityHistory,
} from "../controllers/saheliCompanion.controller";
import {
    getActiveOrderSessionHandler,
    getOrderSessionCatalogHandler,
    getOrderSessionHandler,
    getOrderSessionMenuHandler,
    patchOrderSessionAddressHandler,
    patchOrderSessionCartItemHandler,
    postOrderSessionCartItemHandler,
    postOrderSessionSubmitHandler,
    postStartOrderSessionHandler,
} from "../controllers/orderOrchestrator.controller";
import { postPlaceCodOrderHandler } from "../controllers/orderAgent.controller";
import {
    createCaregiverSaheliChatSessionHandler,
    createSaheliChatSessionHandler,
    getActivity,
    getBriefing,
    getCaregiverSaheliChat,
    getOverview,
    getSaheliChat,
    getSaheliInsightsHandler,
    listCaregiverSaheliChatSessionsHandler,
    listSaheliChatSessionsHandler,
    postCaregiverSaheliChat,
    postSaheliChat,
    postSaheliCheckIn,
} from "../controllers/saheli.controller";
import {
    deleteRecipientLab,
    downloadRecipientLab,
    getRecipientLabDetail,
    getRecipientLabs,
    getRecipientLabTrends,
    postRecipientLab,
    postRecipientLabUpload,
} from "../controllers/memoryDocument.controller";
import {
    getCommandCenterHandler,
    getFamilySearchHandler,
    getNotificationsHandler,
    patchNotificationReadHandler,
    postNotificationsReadAllHandler,
} from "../controllers/dashboard.controller";
import { postSaheliMemoryRefreshHandler } from "../controllers/saheliCompanion.controller";
import { familyDocumentUpload } from "../middleware/upload.middleware";
import { protect } from "../middleware/auth.middleware";

const router = Router();

router.get("/switcher", protect, getFamilySwitcher);
router.patch("/active", protect, switchActiveFamily);
router.patch("/primary", protect, setPrimaryFamilyHandler);
router.get("/invitations/pending", protect, getPendingInvitations);
router.post("/invitations/accept", protect, acceptInvitation);
router.post("/invitations/respond/accept", protect, acceptInvitationByIdHandler);
router.post("/invitations/respond/reject", protect, rejectInvitationByIdHandler);
router.get("/", protect, listFamilies);
router.post("/", protect, createFamily);
router.get("/:familyId/overview", protect, getOverview);
router.get("/:familyId/activity", protect, getActivity);
router.get("/:familyId/dashboard/command-center", protect, getCommandCenterHandler);
router.get("/:familyId/search", protect, getFamilySearchHandler);
router.get("/:familyId/notifications", protect, getNotificationsHandler);
router.patch("/:familyId/notifications/:notificationId/read", protect, patchNotificationReadHandler);
router.post("/:familyId/notifications/read-all", protect, postNotificationsReadAllHandler);
router.get("/:familyId/recipients/:recipientUserId/saheli/chat/sessions", protect, listSaheliChatSessionsHandler);
router.post("/:familyId/recipients/:recipientUserId/saheli/chat/sessions", protect, createSaheliChatSessionHandler);
router.get("/:familyId/recipients/:recipientUserId/saheli/chat", protect, getSaheliChat);
router.post("/:familyId/recipients/:recipientUserId/saheli/chat", protect, postSaheliChat);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/caregiver/chat/sessions",
    protect,
    listCaregiverSaheliChatSessionsHandler,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/caregiver/chat/sessions",
    protect,
    createCaregiverSaheliChatSessionHandler,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/caregiver/chat",
    protect,
    getCaregiverSaheliChat,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/caregiver/chat",
    protect,
    postCaregiverSaheliChat,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/check-in",
    protect,
    postSaheliCheckIn,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/companion",
    protect,
    getCompanionSettings,
);
router.patch(
    "/:familyId/recipients/:recipientUserId/saheli/companion",
    protect,
    patchCompanionSettings,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/companion/activity",
    protect,
    getCompanionActivity,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/outreach",
    protect,
    triggerOutreach,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/memories",
    protect,
    getFamilyMemories,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/memory/refresh",
    protect,
    postSaheliMemoryRefreshHandler,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/memories/:factId/forget",
    protect,
    forgetFamilyMemory,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/memories/:factId/correct",
    protect,
    correctFamilyMemory,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/memory/profile",
    protect,
    getSaheliMemoryProfile,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/memory/entity/:slug",
    protect,
    getSaheliMemoryEntity,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/memory/entity/:slug/history",
    protect,
    getSaheliMemoryEntityHistory,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/insights",
    protect,
    getSaheliInsightsHandler,
);
router.post(
    "/:familyId/recipients/:recipientUserId/saheli/order-sessions",
    protect,
    postStartOrderSessionHandler,
);
router.get(
    "/:familyId/recipients/:recipientUserId/saheli/order-sessions/active",
    protect,
    getActiveOrderSessionHandler,
);
router.get("/:familyId/recipients/:recipientUserId/saheli/usuals", protect, getUsualsHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/usuals/items", protect, deleteUsualItemHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/usuals/declines", protect, deleteUsualDeclineHandler);
router.get("/:familyId/recipients/:recipientUserId/saheli/profile", protect, getProfileHandler);
router.post("/:familyId/recipients/:recipientUserId/saheli/profile/facts/:factId/confirm", protect, confirmFactHandler);
router.patch("/:familyId/recipients/:recipientUserId/saheli/profile/facts/:factId", protect, editFactHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/profile/facts/:factId", protect, rejectFactHandler);
router.patch("/:familyId/recipients/:recipientUserId/saheli/profile/care-actions/:actionId", protect, careActionHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/profile/deviations/:id", protect, dismissDeviationHandler);
router.delete("/:familyId/recipients/:recipientUserId/saheli/profile/alerts/:id", protect, dismissAlertHandler);
router.patch("/:familyId/recipients/:recipientUserId/saheli/profile/retention", protect, retentionHandler);
router.get("/:familyId/saheli/order-sessions/:sessionId", protect, getOrderSessionHandler);
router.patch(
    "/:familyId/saheli/order-sessions/:sessionId/address",
    protect,
    patchOrderSessionAddressHandler,
);
router.get(
    "/:familyId/saheli/order-sessions/:sessionId/catalog",
    protect,
    getOrderSessionCatalogHandler,
);
router.get(
    "/:familyId/saheli/order-sessions/:sessionId/menu/:restaurantId",
    protect,
    getOrderSessionMenuHandler,
);
router.post(
    "/:familyId/saheli/order-sessions/:sessionId/cart/items",
    protect,
    postOrderSessionCartItemHandler,
);
router.patch(
    "/:familyId/saheli/order-sessions/:sessionId/cart/items",
    protect,
    patchOrderSessionCartItemHandler,
);
router.post(
    "/:familyId/saheli/order-sessions/:sessionId/submit",
    protect,
    postOrderSessionSubmitHandler,
);
router.post("/:familyId/saheli/orders/place-cod", protect, postPlaceCodOrderHandler);
router.get("/:familyId/recipients/:recipientUserId/briefing", protect, getBriefing);
router.get("/:familyId/recipients/:recipientUserId/labs", protect, getRecipientLabs);
router.get("/:familyId/recipients/:recipientUserId/labs/trends", protect, getRecipientLabTrends);
router.post("/:familyId/recipients/:recipientUserId/labs", protect, postRecipientLab);
router.post(
    "/:familyId/recipients/:recipientUserId/labs/upload",
    protect,
    familyDocumentUpload.fields([
        { name: "files", maxCount: 25 },
        { name: "file", maxCount: 1 },
    ]),
    postRecipientLabUpload,
);
router.get(
    "/:familyId/recipients/:recipientUserId/labs/:documentId",
    protect,
    getRecipientLabDetail,
);
router.get(
    "/:familyId/recipients/:recipientUserId/labs/:documentId/download",
    protect,
    downloadRecipientLab,
);
router.delete(
    "/:familyId/recipients/:recipientUserId/labs/:documentId",
    protect,
    deleteRecipientLab,
);
router.get("/:familyId/members", protect, listFamilyMembers);
router.get("/:familyId/recipients/:recipientUserId/care-schedule", protect, getRecipientCareSchedule);
router.post("/:familyId/recipients/:recipientUserId/care-schedule", protect, postRecipientCareSchedule);
router.patch(
    "/:familyId/recipients/:recipientUserId/care-schedule/:scheduleId",
    protect,
    patchRecipientCareSchedule,
);
router.put(
    "/:familyId/recipients/:recipientUserId/care-schedule/:scheduleId/completion",
    protect,
    putScheduleCompletion,
);
router.delete(
    "/:familyId/recipients/:recipientUserId/care-schedule/:scheduleId",
    protect,
    removeRecipientCareSchedule,
);
router.post("/:familyId/members/invite", protect, inviteMember);
router.patch("/:familyId/members/:memberUserId", protect, patchMemberDetails);
router.patch("/:familyId/members/:memberUserId/status", protect, patchMemberStatus);
router.delete("/:familyId/members/:memberUserId", protect, deleteMember);
router.patch("/:familyId/invitations/:inviteId", protect, patchInvitationDetails);
router.delete("/:familyId/invitations/:inviteId", protect, deleteInvitation);
router.get("/:familyId", protect, getFamily);
router.patch("/:familyId", protect, updateFamily);

export default router;
