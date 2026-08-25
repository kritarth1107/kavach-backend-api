import { randomUUID } from "crypto";
import path from "path";
import {
    DeleteObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";

let client: S3Client | null = null;

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

export async function extractTextFromUpload(
    buffer: Buffer,
    mimeType: string,
    originalName: string,
): Promise<string> {
    const lower = originalName.toLowerCase();

    if (mimeType.startsWith("text/") || lower.endsWith(".txt")) {
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

    return "";
}

export const ALLOWED_UPLOAD_MIME_TYPES = new Set([
    "application/pdf",
    "text/plain",
    "image/jpeg",
    "image/png",
    "image/webp",
]);

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
