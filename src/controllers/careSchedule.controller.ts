import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import {
    createCareSchedule,
    deleteCareSchedule,
    listCareSchedules,
    updateCareSchedule,
} from "../services/careSchedule.service";

export const getRecipientCareSchedule = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, recipientUserId } = req.params;
        const data = await listCareSchedules(familyId, recipientUserId, req.user.userId);

        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const postRecipientCareSchedule = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, recipientUserId } = req.params;
        const schedule = await createCareSchedule(
            familyId,
            recipientUserId,
            req.user.userId,
            req.body ?? {},
        );

        res.status(201).json({
            success: true,
            message: "Schedule item added",
            data: schedule,
        });
    } catch (error) {
        next(error);
    }
};

export const patchRecipientCareSchedule = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, recipientUserId, scheduleId } = req.params;
        const schedule = await updateCareSchedule(
            familyId,
            recipientUserId,
            scheduleId,
            req.user.userId,
            req.body ?? {},
        );

        res.json({
            success: true,
            message: "Schedule item updated",
            data: schedule,
        });
    } catch (error) {
        next(error);
    }
};

export const removeRecipientCareSchedule = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { familyId, recipientUserId, scheduleId } = req.params;
        await deleteCareSchedule(familyId, recipientUserId, scheduleId, req.user.userId);

        res.json({
            success: true,
            message: "Schedule item removed",
        });
    } catch (error) {
        next(error);
    }
};
