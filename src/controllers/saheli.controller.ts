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
    streamCaregiverSaheliMessage,
    triggerSaheliCheckIn,
} from "../services/saheli.service";
import {
    createSaheliChatSession,
    listSaheliChatSessions,
} from "../services/saheliSession.service";
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

export const getSaheliChat = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const sessionId = String(req.query.sessionId ?? "").trim() || undefined;
        const data = await getSaheliHistory(
            familyId,
            recipientUserId,
            req.user.userId,
            50,
            sessionId,
        );
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

        const sessionId = String(req.body?.sessionId ?? "").trim() || undefined;
        const data = await sendSaheliMessage(
            familyId,
            recipientUserId,
            req.user.userId,
            message,
            { sessionId },
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const listSaheliChatSessionsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const sessions = await listSaheliChatSessions({
            familyId,
            recipientUserId,
            actorUserId: req.user.userId,
            thread: "elder",
        });
        res.json({ success: true, data: { sessions } });
    } catch (error) {
        next(error);
    }
};

export const createSaheliChatSessionHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const session = await createSaheliChatSession({
            familyId,
            recipientUserId,
            actorUserId: req.user.userId,
            thread: "elder",
        });
        res.json({ success: true, data: session });
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
        const sessionId = String(req.query.sessionId ?? "").trim() || undefined;
        const data = await getCaregiverSaheliHistory(
            familyId,
            recipientUserId,
            req.user.userId,
            50,
            sessionId,
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

        const sessionId = String(req.body?.sessionId ?? "").trim() || undefined;

        if (req.query.stream === "1") {
            res.setHeader("Content-Type", "text/event-stream");
            res.setHeader("Cache-Control", "no-cache");
            res.setHeader("Connection", "keep-alive");
            res.flushHeaders?.();

            for await (const event of streamCaregiverSaheliMessage(
                familyId,
                recipientUserId,
                req.user.userId,
                message,
                { sessionId },
            )) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            res.end();
            return;
        }

        const data = await sendCaregiverSaheliMessage(
            familyId,
            recipientUserId,
            req.user.userId,
            message,
            { sessionId },
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const listCaregiverSaheliChatSessionsHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const sessions = await listSaheliChatSessions({
            familyId,
            recipientUserId,
            actorUserId: req.user.userId,
            thread: "caregiver",
        });
        res.json({ success: true, data: { sessions } });
    } catch (error) {
        next(error);
    }
};

export const createCaregiverSaheliChatSessionHandler = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const session = await createSaheliChatSession({
            familyId,
            recipientUserId,
            actorUserId: req.user.userId,
            thread: "caregiver",
        });
        res.json({ success: true, data: session });
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
