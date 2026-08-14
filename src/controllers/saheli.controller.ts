import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import {
    getCaregiverSaheliHistory,
    getFamilyActivityLog,
    getFamilyOverview,
    getRecipientBriefing,
    getSaheliHistory,
    sendCaregiverSaheliMessage,
    sendSaheliMessage,
    triggerSaheliCheckIn,
} from "../services/saheli.service";

export const getOverview = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        const data = await getFamilyOverview(familyId, req.user.userId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const getActivity = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        const data = await getFamilyActivityLog(familyId, req.user.userId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const getSaheliChat = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const data = await getSaheliHistory(familyId, recipientUserId, req.user.userId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const postSaheliChat = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const message = String(req.body?.message ?? "").trim();
        if (!message) throw new AppError("Message is required", 400);

        const data = await sendSaheliMessage(
            familyId,
            recipientUserId,
            req.user.userId,
            message,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const postSaheliCheckIn = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const data = await triggerSaheliCheckIn(
            familyId,
            recipientUserId,
            req.user.userId,
        );
        res.json({ success: true, message: "Check-in sent to Saheli", data });
    } catch (error) {
        next(error);
    }
};

export const getCaregiverSaheliChat = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const data = await getCaregiverSaheliHistory(
            familyId,
            recipientUserId,
            req.user.userId,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const postCaregiverSaheliChat = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const message = String(req.body?.message ?? "").trim();
        if (!message) throw new AppError("Message is required", 400);

        const data = await sendCaregiverSaheliMessage(
            familyId,
            recipientUserId,
            req.user.userId,
            message,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const getBriefing = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const data = await getRecipientBriefing(
            familyId,
            recipientUserId,
            req.user.userId,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};
