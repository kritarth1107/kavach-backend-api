import LabDocument from "../models/labDocument.model";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor } from "./careRecordAuth.service";

const MARKER_ALIASES: Record<string, RegExp[]> = {
    TSH: [/tsh/i, /thyroid stimulating/i],
    HBA1C: [/hba1c/i, /glycated hemoglobin/i],
    GLUCOSE: [/glucose/i, /fasting blood sugar/i, /fbs/i],
    CREATININE: [/creatinine/i],
    HEMOGLOBIN: [/hemoglobin/i, /\bhb\b/i],
    CHOLESTEROL: [/total cholesterol/i, /\bcholesterol\b/i],
};

function extractMarkersFromText(rawText: string): Array<{ name: string; value: string; unit?: string; date?: string }> {
    const values: Array<{ name: string; value: string; unit?: string; date?: string }> = [];
    const patterns = [
        /([A-Za-z][A-Za-z0-9 /\-]{1,30}?)\s*[:\-]\s*([\d.]+)\s*([a-z%/]+)?/gi,
    ];
    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(rawText)) !== null) {
            const name = match[1]?.trim();
            const value = match[2]?.trim();
            if (!name || !value || name.length > 40) continue;
            values.push({ name, value, unit: match[3]?.trim() });
        }
    }
    return values;
}

function markerMatches(name: string, marker: string): boolean {
    const aliases = MARKER_ALIASES[marker.toUpperCase()];
    if (!aliases) return name.toLowerCase().includes(marker.toLowerCase());
    return aliases.some((re) => re.test(name));
}

export async function getLabTrends(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    marker: string,
    limit = 12,
) {
    await getFamilyForActor(familyId, actorUserId);
    const docs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: 1 })
        .lean();

    const points: Array<{ value: string; unit?: string; date: string; documentId: string; title: string }> = [];

    for (const doc of docs) {
        const structured = doc.structuredValues ?? [];
        const candidates =
            structured.length > 0
                ? structured.map((row) => ({
                      name: row.name,
                      value: row.value,
                      unit: row.unit,
                      date: row.date ?? doc.recordDate ?? doc.createdAt?.toISOString?.()?.slice(0, 10) ?? "",
                  }))
                : extractMarkersFromText(doc.rawText).map((row) => ({
                      ...row,
                      date: doc.recordDate ?? doc.createdAt?.toISOString?.()?.slice(0, 10) ?? "",
                  }));

        for (const row of candidates) {
            if (!markerMatches(row.name, marker)) continue;
            points.push({
                value: row.value,
                unit: row.unit,
                date: row.date,
                documentId: doc.documentId,
                title: doc.title,
            });
        }
    }

    return {
        marker: marker.toUpperCase(),
        points: points.slice(-limit),
    };
}

export async function enrichLabStructuredValues(documentId: string): Promise<void> {
    const doc = await LabDocument.findOne({ documentId }).lean();
    if (!doc || (doc.structuredValues?.length ?? 0) > 0) return;

    const extracted = extractMarkersFromText(doc.rawText).slice(0, 40);
    if (!extracted.length) {
        await LabDocument.updateOne({ documentId }, { $set: { analysisStatus: "ready" } });
        return;
    }

    await LabDocument.updateOne(
        { documentId },
        {
            $set: {
                structuredValues: extracted.map((row) => ({
                    name: row.name,
                    value: row.value,
                    unit: row.unit,
                    date: doc.recordDate,
                })),
                analysisStatus: "ready",
            },
        },
    );

    const { maybeAlertCaregiversOnLabUpload } = await import("./saheliHealthAlert.service");
    await maybeAlertCaregiversOnLabUpload({
        familyId: doc.familyId,
        recipientUserId: doc.recipientUserId,
        documentTitle: doc.title,
        structuredValues: extracted.map((row) => ({
            name: row.name,
            value: row.value,
            unit: row.unit,
            date: doc.recordDate,
        })),
    });
}
