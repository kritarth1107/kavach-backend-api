import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
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
    getActivity,
    getBriefing,
    getOverview,
    getSaheliInsightsHandler,
} from "../controllers/saheli.controller";
import {
    deleteRecipientLab,
    downloadRecipientLab,
    getRecipientLabDetail,
    getRecipientLabs,
    getRecipientLabTrends,
    getRecipientLabHighlights,
    postRecipientLabDecision,
    postRecipientLabPerson,
    postRecipientLabReread,
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
import { familyDocumentUpload, rejectOversizedUpload } from "../middleware/upload.middleware";
import { postMemberAvatar } from "../controllers/memberAvatar.controller";
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
// The dashboard has no chat (founder 2026-10-03); its v1 chat, check-in and memory endpoints are gone (trust plan A1).
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
// Usuals and the learned profile are read from Saheli's care record (care-memory routes), not the retired Mongo stores.
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
router.get("/:familyId/recipients/:recipientUserId/labs/highlights", protect, getRecipientLabHighlights);
router.post("/:familyId/recipients/:recipientUserId/labs/:documentId/decision", protect, postRecipientLabDecision);
router.post("/:familyId/recipients/:recipientUserId/labs/:documentId/person", protect, postRecipientLabPerson);
router.post("/:familyId/recipients/:recipientUserId/labs/:documentId/reread", protect, postRecipientLabReread);
router.post("/:familyId/recipients/:recipientUserId/labs", protect, postRecipientLab);
router.post(
    "/:familyId/recipients/:recipientUserId/labs/upload",
    protect,
    familyDocumentUpload.fields([
        { name: "files", maxCount: 25 },
        { name: "file", maxCount: 1 },
    ]),
    rejectOversizedUpload,
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
router.post(
    "/:familyId/members/:memberUserId/avatar",
    protect,
    familyDocumentUpload.single("photo"),
    rejectOversizedUpload,
    (req: Request, res: Response, next: NextFunction) => postMemberAvatar(req, res).catch(next),
);
router.patch("/:familyId/members/:memberUserId/status", protect, patchMemberStatus);
router.delete("/:familyId/members/:memberUserId", protect, deleteMember);
router.patch("/:familyId/invitations/:inviteId", protect, patchInvitationDetails);
router.delete("/:familyId/invitations/:inviteId", protect, deleteInvitation);
router.get("/:familyId", protect, getFamily);
router.patch("/:familyId", protect, updateFamily);

export default router;
