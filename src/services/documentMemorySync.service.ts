import { aiAnalyzeDocument, aiIngestDocument } from "../clients/aiEngine.client";
import LabDocument from "../models/labDocument.model";
import Family from "../models/family.model";
import User from "../models/users.model";
import { ensureAiContext } from "./aiTenant.service";

type AnalysisResult = {
    title: string;
    kind: string;
    tags: string[];
    summary: string;
    recordDate?: string | null;
    highlights: string[];
};

function mapKindForAiEngine(kind: string): string {
    if (["lab", "scan", "prescription", "note", "chat_export", "vitals", "symptom", "pharmacy"].includes(kind)) {
        return kind;
    }
    return "lab";
}

async function recipientDisplayName(recipientUserId: string) {
    const user = await User.findOne({ userId: recipientUserId }).lean();
    return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "Care recipient";
}

export async function analyzeUploadedDocument(payload: {
    title: string;
    rawText: string;
    fileName?: string;
}): Promise<AnalysisResult> {
    try {
        const result = await aiAnalyzeDocument({
            title: payload.title,
            rawText: payload.rawText,
            fileName: payload.fileName,
        });
        return {
            title: result.title || payload.title,
            kind: result.kind || "lab",
            tags: result.tags ?? [],
            summary: result.summary || payload.title,
            recordDate: result.record_date ?? null,
            highlights: result.highlights ?? [],
        };
    } catch {
        const text = payload.rawText.trim();
        const fallbackTitle =
            payload.title ||
            text.split("\n").find((line) => line.trim())?.slice(0, 80) ||
            payload.fileName?.replace(/\.[^.]+$/, "") ||
            "Health record";
        return {
            title: fallbackTitle,
            kind: "lab",
            tags: ["health-record"],
            summary: text.slice(0, 240) || `Uploaded: ${fallbackTitle}`,
            recordDate: null,
            highlights: [],
        };
    }
}

export async function syncDocumentToFamilyMemory(payload: {
    familyId: string;
    recipientUserId: string;
    documentId: string;
    title: string;
    rawText: string;
    fileName?: string;
    kind?: string;
    recordDate?: string;
}): Promise<{
    analysis: AnalysisResult;
    aiMemoryDocumentId?: string;
}> {
    const family = await Family.findOne({ familyId: payload.familyId, status: "ACTIVE" }).lean();
    if (!family) {
        throw new Error("Family not found");
    }

    const displayName = await recipientDisplayName(payload.recipientUserId);

    const analysis = await analyzeUploadedDocument({
        title: payload.title,
        rawText: payload.rawText,
        fileName: payload.fileName,
    });

    const resolvedKind = payload.kind || analysis.kind;
    const resolvedDate = payload.recordDate || analysis.recordDate || undefined;
    const resolvedTitle = payload.title?.trim() || analysis.title || payload.title;

    let aiMemoryDocumentId: string | undefined;
    try {
        const aiCtx = await ensureAiContext(
            payload.familyId,
            payload.recipientUserId,
            displayName,
        );
        const ingested = await aiIngestDocument({
            aiFamilyId: aiCtx.aiFamilyId,
            aiElderId: aiCtx.aiElderId,
            title: resolvedTitle,
            rawText: payload.rawText,
            kind: mapKindForAiEngine(resolvedKind),
            recordDate: resolvedDate,
            summary: analysis.summary,
            highlights: {
                tags: analysis.tags,
                items: analysis.highlights,
            },
        });
        aiMemoryDocumentId = ingested.document_id;
    } catch {
        /* Mongo record remains; RAG sync is best-effort */
    }

    await LabDocument.updateOne(
        { documentId: payload.documentId },
        {
            $set: {
                title: resolvedTitle.slice(0, 200),
                kind: resolvedKind,
                ...(resolvedDate ? { recordDate: resolvedDate } : {}),
                aiSummary: analysis.summary,
                tags: analysis.tags,
                highlights: analysis.highlights,
                aiMemoryDocumentId,
                analysisStatus: aiMemoryDocumentId ? "ready" : "failed",
            },
        },
    );

    return { analysis, aiMemoryDocumentId };
}
