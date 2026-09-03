import { appendCareRecordEvent } from "./careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import LabDocument from "../models/labDocument.model";

const WATCH_MARKERS = [
    { key: "creatinine", pattern: /creatinine[\s:]*([\d.]+)/i, label: "Creatinine" },
    { key: "tsh", pattern: /tsh[\s:]*([\d.]+)/i, label: "TSH" },
    { key: "dosage", pattern: /(?:tab|syp|inj)\s+[\w\s]+(?:\d+\s*mg|\d+\s*ml)/gi, label: "Dosage" },
];

function extractMarkerValues(rawText: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const marker of WATCH_MARKERS) {
        const match = rawText.match(marker.pattern);
        if (match) {
            out[marker.key] = match[0].slice(0, 80);
        }
    }
    return out;
}

export async function evaluateContextSignalsForDocument(opts: {
    familyId: string;
    subjectUserId: string;
    documentId: string;
    rawText: string;
}) {
    const current = extractMarkerValues(opts.rawText);
    if (!Object.keys(current).length) return null;

    const priorDocs = await LabDocument.find({
        familyId: opts.familyId,
        recipientUserId: opts.subjectUserId,
        documentId: { $ne: opts.documentId },
    })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

    const signals: string[] = [];
    for (const [key, value] of Object.entries(current)) {
        for (const doc of priorDocs) {
            const prior = extractMarkerValues(doc.rawText);
            if (prior[key] && prior[key] !== value) {
                signals.push(
                    `${key} changed from “${prior[key]}” (in ${doc.title}) to “${value}” in the new upload.`,
                );
            }
        }
    }

    if (!signals.length) return null;

    const detail = signals.join(" ");
    await appendCareRecordEvent({
        familyId: opts.familyId,
        subjectUserId: opts.subjectUserId,
        type: CareRecordEventType.CONTEXT_SIGNAL,
        source: CareRecordSource.SYSTEM,
        channel: ChannelType.DASHBOARD,
        title: "Quiet context from new record",
        detail,
        payload: { documentId: opts.documentId, signals },
        status: "context",
        skipSignalCheck: true,
    });

    return detail;
}

export async function getRecentContextSignals(familyId: string, subjectUserId: string, limit = 5) {
    const { listCareRecordEvents } = await import("./careRecord.service");
    const events = await listCareRecordEvents({
        familyId,
        subjectUserId,
        types: [CareRecordEventType.CONTEXT_SIGNAL],
        limit,
    });
    return events;
}
