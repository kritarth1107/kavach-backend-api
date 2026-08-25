import multer from "multer";
import { MAX_UPLOAD_BYTES } from "../services/r2Storage.service";

export const familyDocumentUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
});
