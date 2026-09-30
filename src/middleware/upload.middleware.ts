import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError } from "./error.middleware";
import { MAX_UPLOAD_BYTES } from "../services/r2Storage.service";

export const familyDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
});

/** Multer's size error is otherwise a generic 500, so the dashboard looks like the upload never finished. */
export function rejectOversizedUpload(err: unknown, _req: Request, _res: Response, next: NextFunction): void {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "LIMIT_FILE_SIZE") {
        next(new AppError("This file is too large. The maximum is 15 MB.", 400));
        return;
    }
    next(err);
}
