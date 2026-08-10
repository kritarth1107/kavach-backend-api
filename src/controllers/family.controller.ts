import { NextFunction, Request, Response } from "express";
import Family from "../models/family.model";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import {
    assertFamilyMember,
    buildDefaultFamilyName,
    buildFamilySwitcherPayload,
    ensureDefaultFamily,
    ensureValidActiveFamily,
    formatFamilyDetail,
    getFamiliesForUser,
    setActiveFamily,
    setUserPrimaryFamily,
} from "../services/family.service";
import { FamilyRole, FamilyMemberStatus } from "../types/family.types";
import {
    acceptFamilyInvitation,
    getFamilyMembersList,
    getPendingInvitationsForUser,
    inviteFamilyMember,
    removeFamilyMember,
    revokeInvitation,
    acceptInvitationById,
    rejectInvitationById,
    updateMemberStatus,
    updateFamilyMemberDetails,
    updateInvitationDetails,
} from "../services/familyMember.service";

export const listFamilies = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        await ensureDefaultFamily(user);

        const refreshedUser =
            (await User.findOne({ userId: user.userId })) ?? user;
        const families = await getFamiliesForUser(refreshedUser.userId);
        const switcher = buildFamilySwitcherPayload(refreshedUser, families);

        res.json({
            success: true,
            data: switcher,
        });
    } catch (error) {
        next(error);
    }
};

export const getFamilySwitcher = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        await ensureDefaultFamily(user);

        const refreshedUser =
            (await User.findOne({ userId: user.userId })) ?? user;
        await ensureValidActiveFamily(refreshedUser);
        const families = await getFamiliesForUser(refreshedUser.userId);
        const switcher = buildFamilySwitcherPayload(refreshedUser, families);

        res.json({
            success: true,
            data: switcher,
        });
    } catch (error) {
        next(error);
    }
};

export const setPrimaryFamilyHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const familyId = String(req.body?.familyId ?? "").trim();
        if (!familyId) {
            throw new AppError("familyId is required", 400);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        await setUserPrimaryFamily(user, familyId);

        const refreshedUser =
            (await User.findOne({ userId: user.userId })) ?? user;
        const families = await getFamiliesForUser(refreshedUser.userId);
        const switcher = buildFamilySwitcherPayload(refreshedUser, families);

        res.json({
            success: true,
            message: "Primary family updated",
            data: switcher,
        });
    } catch (error) {
        if (error instanceof Error && error.message.includes("access denied")) {
            next(new AppError("Family not found or access denied", 404));
            return;
        }
        next(error);
    }
};

export const switchActiveFamily = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const familyId = String(req.body?.familyId ?? "").trim();
        if (!familyId) {
            throw new AppError("familyId is required", 400);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        await setActiveFamily(user, familyId);

        const refreshedUser =
            (await User.findOne({ userId: user.userId })) ?? user;
        const families = await getFamiliesForUser(refreshedUser.userId);
        const switcher = buildFamilySwitcherPayload(refreshedUser, families);

        res.json({
            success: true,
            message: "Active family updated",
            data: switcher,
        });
    } catch (error) {
        if (error instanceof Error && error.message.includes("access denied")) {
            next(new AppError("Family not found or access denied", 404));
            return;
        }
        next(error);
    }
};

export const getFamily = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId } = req.params;
        const family = await assertFamilyMember(familyId, req.user.userId);

        res.json({
            success: true,
            data: await formatFamilyDetail(family, req.user.userId),
        });
    } catch (error) {
        if (error instanceof Error && error.message.includes("access denied")) {
            next(new AppError("Family not found or access denied", 404));
            return;
        }
        next(error);
    }
};

export const createFamily = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        const name =
            String(req.body?.name ?? "").trim() ||
            buildDefaultFamilyName(user.firstName, user.email);
        const description = String(req.body?.description ?? "").trim() || undefined;
        const role = (req.body?.role as FamilyRole) || FamilyRole.PRIMARY_CAREGIVER;

        if (!Object.values(FamilyRole).includes(role)) {
            throw new AppError("Invalid family role", 400);
        }

        const family = await Family.create({
            name,
            description,
            createdBy: user.userId,
            members: [
                {
                    userId: user.userId,
                    role,
                    status: FamilyMemberStatus.JOINED,
                    joinedAt: new Date(),
                },
            ],
        });

        user.activeFamilyId = family.familyId;
        await User.updateOne(
            { userId: user.userId },
            { activeFamilyId: family.familyId },
        );

        const families = await getFamiliesForUser(user.userId);
        const switcher = buildFamilySwitcherPayload(user, families);

        res.status(201).json({
            success: true,
            message: "Family created successfully",
            data: {
                ...(await formatFamilyDetail(family, user.userId)),
                isActive: true,
            },
            switcher,
        });
    } catch (error) {
        next(error);
    }
};

export const updateFamily = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId } = req.params;
        const family = await assertFamilyMember(familyId, req.user.userId);

        const role = family.getMemberRole(req.user.userId);
        const canEdit = role === FamilyRole.PRIMARY_CAREGIVER || role === FamilyRole.CO_CAREGIVER;

        if (!canEdit) {
            throw new AppError("You do not have permission to update this family", 403);
        }

        if (req.body?.name !== undefined) {
            const name = String(req.body.name).trim();
            if (!name) {
                throw new AppError("Family name cannot be empty", 400);
            }
            family.name = name;
        }

        if (req.body?.description !== undefined) {
            family.description = String(req.body.description).trim() || undefined;
        }

        await family.save();

        res.json({
            success: true,
            message: "Family updated successfully",
            data: await formatFamilyDetail(family, req.user.userId),
        });
    } catch (error) {
        if (error instanceof Error && error.message.includes("access denied")) {
            next(new AppError("Family not found or access denied", 404));
            return;
        }
        next(error);
    }
};

export const acceptInvitationByIdHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const inviteId = String(req.body?.inviteId ?? req.params?.inviteId ?? "").trim();
        if (!inviteId) {
            throw new AppError("inviteId is required", 400);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        const data = await acceptInvitationById(user, inviteId);

        res.json({
            success: true,
            message: "Invitation accepted",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const rejectInvitationByIdHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const inviteId = String(req.body?.inviteId ?? req.params?.inviteId ?? "").trim();
        if (!inviteId) {
            throw new AppError("inviteId is required", 400);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        await rejectInvitationById(user, inviteId);

        res.json({
            success: true,
            message: "Invitation declined",
        });
    } catch (error) {
        next(error);
    }
};

export const listFamilyMembers = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId } = req.params;
        const data = await getFamilyMembersList(familyId, req.user.userId);

        res.json({ success: true, data });
    } catch (error) {
        if (error instanceof AppError) {
            next(error);
            return;
        }
        next(new AppError("Family not found or access denied", 404));
    }
};

export const inviteMember = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        const { familyId } = req.params;
        const data = await inviteFamilyMember(familyId, user, req.body);

        res.status(201).json({
            success: true,
            message: "Invitation sent",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const acceptInvitation = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const token = String(req.body?.token ?? "").trim();
        if (!token) {
            throw new AppError("Invitation token is required", 400);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        const data = await acceptFamilyInvitation(user, token);

        res.json({
            success: true,
            message: "Invitation accepted",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const getPendingInvitations = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const user = await User.findOne({ userId: req.user.userId });
        if (!user) {
            throw new AppError("User not found", 404);
        }

        const data = await getPendingInvitationsForUser(user);

        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const patchMemberDetails = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, memberUserId } = req.params;
        const data = await updateFamilyMemberDetails(
            familyId,
            req.user.userId,
            memberUserId,
            {
                role: req.body?.role,
                name: req.body?.name,
                namePrefix: req.body?.namePrefix,
                relationship: req.body?.relationship,
                phone: req.body?.phone,
                phoneCountryCode: req.body?.phoneCountryCode,
                location: req.body?.location,
            },
        );

        res.json({
            success: true,
            message: "Member updated",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const patchInvitationDetails = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, inviteId } = req.params;
        const data = await updateInvitationDetails(
            familyId,
            req.user.userId,
            inviteId,
            {
                role: req.body?.role,
                name: req.body?.name,
                namePrefix: req.body?.namePrefix,
                relationship: req.body?.relationship,
                phone: req.body?.phone,
                phoneCountryCode: req.body?.phoneCountryCode,
                location: req.body?.location,
            },
        );

        res.json({
            success: true,
            message: "Invitation updated",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const patchMemberStatus = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, memberUserId } = req.params;
        const status = String(req.body?.status ?? "").toUpperCase() as FamilyMemberStatus;

        if (!Object.values(FamilyMemberStatus).includes(status)) {
            throw new AppError("Invalid status. Use PENDING, JOINED, or BLOCKED", 400);
        }

        const data = await updateMemberStatus(
            familyId,
            req.user.userId,
            memberUserId,
            status,
        );

        res.json({
            success: true,
            message: "Member status updated",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const deleteMember = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, memberUserId } = req.params;
        const data = await removeFamilyMember(familyId, req.user.userId, memberUserId);

        res.json({
            success: true,
            message: "Member removed",
            data,
        });
    } catch (error) {
        next(error);
    }
};

export const deleteInvitation = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, inviteId } = req.params;
        const data = await revokeInvitation(familyId, req.user.userId, inviteId);

        res.json({
            success: true,
            message: "Invitation revoked",
            data,
        });
    } catch (error) {
        next(error);
    }
};
