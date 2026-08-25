import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import {
    deleteRecipientDocument,
    getRecipientDocument,
    ingestRecipientDocument,
    listRecipientDocuments,
} from "../services/memoryDocument.service";

export const getRecipientLabs = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const data = await listRecipientDocuments(
            familyId,
            recipientUserId,
            req.user.userId,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const postRecipientLab = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const data = await ingestRecipientDocument(
            familyId,
            recipientUserId,
            req.user.userId,
            {
                title: String(req.body?.title ?? ""),
                rawText: String(req.body?.rawText ?? req.body?.raw_text ?? ""),
                kind: req.body?.kind ? String(req.body.kind) : "lab",
                recordDate: req.body?.recordDate
                    ? String(req.body.recordDate)
                    : undefined,
            },
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const getRecipientLabDetail = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId, documentId } = req.params;
        const data = await getRecipientDocument(
            familyId,
            recipientUserId,
            documentId,
            req.user.userId,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const deleteRecipientLab = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId, documentId } = req.params;
        const data = await deleteRecipientDocument(
            familyId,
            recipientUserId,
            documentId,
            req.user.userId,
        );
        res.json({ success: true, data });
    } catch (error) {
        next(error);
    }
};
