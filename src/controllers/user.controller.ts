import { NextFunction, Request, Response } from "express";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import {
    buildUserProfile,
    listUserSessions,
    revokeOtherUserSessions,
    revokeUserSession,
    updateUserProfile,
} from "../services/user.service";

export const getMyProfile = async (
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

        res.json({
            success: true,
            data: buildUserProfile(user),
        });
    } catch (error) {
        next(error);
    }
};

export const patchMyProfile = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const profile = await updateUserProfile(req.user.userId, req.body ?? {});

        res.json({
            success: true,
            message: "Profile updated",
            data: profile,
        });
    } catch (error) {
        next(error);
    }
};

export const getMySessions = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const sessions = await listUserSessions(req.user.userId, req.sessionId);

        res.json({
            success: true,
            data: { sessions },
        });
    } catch (error) {
        next(error);
    }
};

export const deleteMySession = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const { sessionId } = req.params;
        await revokeUserSession(req.user.userId, sessionId, req.sessionId);

        res.json({
            success: true,
            message: "Session revoked",
        });
    } catch (error) {
        next(error);
    }
};

export const revokeOtherSessions = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) {
            throw new AppError("Not authenticated", 401);
        }

        const result = await revokeOtherUserSessions(req.user.userId, req.sessionId);

        res.json({
            success: true,
            message: "Other sessions revoked",
            data: result,
        });
    } catch (error) {
        next(error);
    }
};
