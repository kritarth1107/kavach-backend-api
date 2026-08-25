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
    removeRecipientCareSchedule,
} from "../controllers/careSchedule.controller";
import {
    getActivity,
    getBriefing,
    getCaregiverSaheliChat,
    getOverview,
    getSaheliChat,
    postCaregiverSaheliChat,
    postSaheliChat,
    postSaheliCheckIn,
} from "../controllers/saheli.controller";
import {
    deleteRecipientLab,
    getRecipientLabDetail,
    getRecipientLabs,
    postRecipientLab,
    postRecipientLabUpload,
} from "../controllers/memoryDocument.controller";
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
router.get("/:familyId/recipients/:recipientUserId/saheli/chat", protect, getSaheliChat);
router.post("/:familyId/recipients/:recipientUserId/saheli/chat", protect, postSaheliChat);
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
router.get("/:familyId/recipients/:recipientUserId/briefing", protect, getBriefing);
router.get("/:familyId/recipients/:recipientUserId/labs", protect, getRecipientLabs);
router.post("/:familyId/recipients/:recipientUserId/labs", protect, postRecipientLab);
router.post(
    "/:familyId/recipients/:recipientUserId/labs/upload",
    protect,
    familyDocumentUpload.single("file"),
    postRecipientLabUpload,
);
router.get(
    "/:familyId/recipients/:recipientUserId/labs/:documentId",
    protect,
    getRecipientLabDetail,
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
