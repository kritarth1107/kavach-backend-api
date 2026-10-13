import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import {
    getFamilyActivityLog,
    getFamilyOverview,
    getRecipientBriefing,
} from "../services/saheli.service";
import { getSaheliInsights } from "../services/saheliInsights.service";

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

export const getBriefing = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const dateKey =
            typeof req.query.date === "string" && req.query.date.trim()
                ? req.query.date.trim()
                : undefined;
        const data = await getRecipientBriefing(
            familyId,
            recipientUserId,
            req.user.userId,
            dateKey,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const getSaheliInsightsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const insights = await getSaheliInsights(familyId, recipientUserId, req.user.userId);
        res.json({ success: true, data: { insights } });
    } catch (error) {
        next(error);
    }
};
