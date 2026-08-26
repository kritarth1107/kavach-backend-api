import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import {
    deleteRecipientDocument,
    downloadRecipientDocument,
    getRecipientDocument,
    ingestRecipientDocument,
    ingestRecipientFile,
    ingestRecipientFiles,
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
                title: req.body?.title ? String(req.body.title) : undefined,
                rawText: String(req.body?.rawText ?? req.body?.raw_text ?? ""),
                kind: req.body?.kind ? String(req.body.kind) : undefined,
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

export const postRecipientLabUpload = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        const grouped = req.files as
            | { files?: Express.Multer.File[]; file?: Express.Multer.File[] }
            | undefined;
        const batch = [
            ...(grouped?.files ?? []),
            ...(grouped?.file ?? []),
        ];
        const single = req.file;
        const files = batch.length ? batch : single ? [single] : [];

        if (!files.length) throw new AppError("At least one file is required", 400);

        if (files.length === 1) {
            const data = await ingestRecipientFile(
                familyId,
                recipientUserId,
                req.user.userId,
                files[0],
                {
                    title: req.body?.title ? String(req.body.title) : undefined,
                    kind: req.body?.kind ? String(req.body.kind) : "lab",
                    recordDate: req.body?.recordDate
                        ? String(req.body.recordDate)
                        : undefined,
                },
            );
            res.json({ success: true, data });
            return;
        }

        const data = await ingestRecipientFiles(
            familyId,
            recipientUserId,
            req.user.userId,
            files,
            {
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

export const downloadRecipientLab = async (
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId, documentId } = req.params;
        const file = await downloadRecipientDocument(
            familyId,
            recipientUserId,
            documentId,
            req.user.userId,
        );
        res.setHeader("Content-Type", file.contentType);
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(file.fileName).replace(/%22/g, "")}"`,
        );
        res.send(file.buffer);
    } catch (error) {
        next(error);
    }
};
