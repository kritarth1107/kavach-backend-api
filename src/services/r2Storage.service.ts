import { randomUUID } from "crypto";
import path from "path";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

let client: S3Client | null = null;

const EXTENSION_MIME: Record<string, string> = {
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
};

function getR2Client(): S3Client {
    if (client) return client;

    const { endpoint, accessKeyId, secretAccessKey } = config.r2;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
        throw new AppError("Cloudflare R2 is not configured", 503);
    }

    client = new S3Client({
        region: "auto",
        endpoint,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });

    return client;
}

export function isR2Configured(): boolean {
    const { endpoint, accessKeyId, secretAccessKey, bucketName } = config.r2;
    return Boolean(endpoint && accessKeyId && secretAccessKey && bucketName);
}

export function buildFamilyObjectKey(familyId: string, fileName: string): string {
    const ext = path.extname(fileName).toLowerCase() || "";
    const base = path.basename(fileName, ext).replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
    const safeName = `${base || "document"}${ext}`;
    return `${familyId}/${randomUUID()}-${safeName}`;
}

export function buildPublicFileUrl(storageKey: string): string {
    const base = config.r2.publicUrl.replace(/\/$/, "");
    return `${base}/${storageKey}`;
}

export async function uploadFamilyFile(
    storageKey: string,
    body: Buffer,
    contentType: string,
): Promise<string> {
    const bucket = config.r2.bucketName;
    if (!bucket) throw new AppError("R2 bucket is not configured", 503);

    await getR2Client().send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: storageKey,
            Body: body,
            ContentType: contentType,
        }),
    );

    return buildPublicFileUrl(storageKey);
}

export async function deleteFamilyFile(storageKey: string): Promise<void> {
    const bucket = config.r2.bucketName;
    if (!bucket || !storageKey) return;

    await getR2Client().send(
        new DeleteObjectCommand({
            Bucket: bucket,
            Key: storageKey,
        }),
    );
}

export async function getFamilyFileBuffer(storageKey: string): Promise<{
    buffer: Buffer;
    contentType: string;
}> {
    const bucket = config.r2.bucketName;
    if (!bucket || !storageKey) {
        throw new AppError("File not found", 404);
    }

    const result = await getR2Client().send(
        new GetObjectCommand({
            Bucket: bucket,
            Key: storageKey,
        }),
    );

    const body = result.Body;
    if (!body) throw new AppError("File not found", 404);

    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
    }

    return {
        buffer: Buffer.concat(chunks),
        contentType: result.ContentType || "application/octet-stream",
    };
}

export async function extractTextFromUpload(
    buffer: Buffer,
    mimeType: string,
    originalName: string,
): Promise<string> {
    const lower = originalName.toLowerCase();
    const ext = path.extname(lower);

    if (
        mimeType.startsWith("text/") ||
        [".txt", ".md", ".markdown", ".csv", ".json"].includes(ext)
    ) {
        return buffer.toString("utf8").trim();
    }

    if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
        try {
            const { PDFParse } = await import("pdf-parse");
            const parser = new PDFParse({ data: buffer });
            const textResult = await parser.getText();
            await parser.destroy();
            return (textResult.text ?? "").replace(/\s+/g, " ").trim();
        } catch {
            return "";
        }
    }

    if (
        mimeType.includes("spreadsheet") ||
        mimeType.includes("excel") ||
        [".xlsx", ".xls"].includes(ext)
    ) {
        try {
            const XLSX = await import("xlsx");
            const workbook = XLSX.read(buffer, { type: "buffer" });
            const chunks: string[] = [];
            for (const sheetName of workbook.SheetNames.slice(0, 5)) {
                const sheet = workbook.Sheets[sheetName];
                if (!sheet) continue;
                chunks.push(`Sheet: ${sheetName}`);
                chunks.push(XLSX.utils.sheet_to_csv(sheet));
            }
            return chunks.join("\n").trim();
        } catch {
            return "";
        }
    }

    if (
        mimeType.includes("wordprocessingml") ||
        mimeType === "application/msword" ||
        [".docx", ".doc"].includes(ext)
    ) {
        try {
            const mammoth = await import("mammoth");
            const result = await mammoth.extractRawText({ buffer });
            return (result.value ?? "").replace(/\s+/g, " ").trim();
        } catch {
            return "";
        }
    }

    return "";
}

export const ALLOWED_UPLOAD_MIME_TYPES = new Set([
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "image/jpeg",
    "image/png",
    "image/webp",
]);

export const ALLOWED_UPLOAD_EXTENSIONS = new Set(Object.keys(EXTENSION_MIME));

export function resolveUploadMimeType(mimeType: string, originalName: string): string {
    if (mimeType && mimeType !== "application/octet-stream") return mimeType;
    const ext = path.extname(originalName).toLowerCase();
    return EXTENSION_MIME[ext] || mimeType;
}

export function isAllowedUpload(mimeType: string, originalName: string): boolean {
    const resolved = resolveUploadMimeType(mimeType, originalName);
    const ext = path.extname(originalName).toLowerCase();
    if (ALLOWED_UPLOAD_MIME_TYPES.has(resolved)) return true;
    if (ALLOWED_UPLOAD_EXTENSIONS.has(ext)) return true;
    return false;
}

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
