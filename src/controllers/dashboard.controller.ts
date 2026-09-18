import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { getCommandCenter } from "../services/commandCenter.service";
import {
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
} from "../services/notification.service";
import { searchFamily } from "../services/search.service";

export async function getCommandCenterHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        const data = await getCommandCenter(familyId, req.user.userId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function getNotificationsHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        const data = await listNotifications(familyId, req.user.userId);
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
}

export async function patchNotificationReadHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, notificationId } = req.params;
        await markNotificationRead(familyId, req.user.userId, notificationId);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

export async function postNotificationsReadAllHandler(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        await markAllNotificationsRead(familyId, req.user.userId);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
}

export async function getFamilySearchHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        const q = String(req.query.q ?? "");
        const limit = Number(req.query.limit ?? 20);
        const results = await searchFamily(familyId, req.user.userId, q, limit);
        res.json({ success: true, data: { results } });
    } catch (error) {
        next(error);
    }
}
