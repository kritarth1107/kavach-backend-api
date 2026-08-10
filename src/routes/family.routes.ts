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
