import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import config from "../config/app.config";
import Session from "../models/session.model";
import User from "../models/users.model";
import TokenBlacklist from "../utils/tokenBlacklist.util";
import { IJwtPayload } from "../types/session.types";
import { IUser, UserStatus } from "../types/user.types";

declare global {
    namespace Express {
        interface Request {
            user?: IUser;
            sessionId?: string;
            activeFamilyId?: string;
        }
    }
}

/**
 * Validates JWT + active session + user account status.
 * Cross-references Session and User collections before allowing access.
 */
export const userAuth = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        const authHeader = req.headers.authorization;
        const cookieToken = req.cookies?.kavach_session as string | undefined;

        const bearerToken = authHeader?.startsWith("Bearer ")
            ? authHeader.split(" ")[1]
            : undefined;

        const token = bearerToken || cookieToken;

        if (!token) {
            res.status(401).json({
                success: false,
                message: "Authentication required. Please sign in.",
            });
            return;
        }

        const isBlacklisted = await TokenBlacklist.isBlacklisted(token);
        if (isBlacklisted) {
            res.status(401).json({
                success: false,
                message: "Session revoked. Please log in again.",
            });
            return;
        }

        const decoded = jwt.verify(token, config.jwt.secret) as IJwtPayload;

        if (!decoded?.userId || !decoded?.sessionId) {
            res.status(401).json({
                success: false,
                message: "Invalid token payload structure.",
            });
            return;
        }

        const fingerprint = (req.headers["x-fingerprint"] as string) || "N/A";

        const [activeSession, activeUser] = await Promise.all([
            Session.findActive(decoded.userId, token, fingerprint),
            User.findOne({ userId: decoded.userId }).lean(),
        ]);

        if (!activeSession || activeSession.sessionId !== decoded.sessionId) {
            res.status(401).json({
                success: false,
                message: "Session expired or invalid. Please log in again.",
            });
            return;
        }

        if (!activeUser) {
            res.status(401).json({
                success: false,
                message: "The user account associated with this token no longer exists.",
            });
            return;
        }

        const blockedStatuses: UserStatus[] = [
            UserStatus.BANNED,
            UserStatus.SUSPENDED,
            UserStatus.DELETED,
        ];

        if (blockedStatuses.includes(activeUser.status)) {
            res.status(403).json({
                success: false,
                code: activeUser.status,
                message: `Account is ${activeUser.status.toLowerCase()}. Access denied.`,
            });
            return;
        }

        req.user = activeUser;
        req.sessionId = activeSession.sessionId;
        req.activeFamilyId = activeUser.activeFamilyId;

        Session.updateOne(
            { sessionId: activeSession.sessionId },
            { lastActiveAt: new Date() },
        ).exec();

        next();
    } catch (error: unknown) {
        if (error instanceof jwt.TokenExpiredError) {
            res.status(401).json({
                success: false,
                message: "Token has expired. Please refresh your session.",
            });
            return;
        }

        res.status(401).json({
            success: false,
            message: "Invalid or forged authentication token.",
        });
    }
};

export const protect = userAuth;

export default userAuth;
