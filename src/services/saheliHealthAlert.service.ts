import LabDocument from "../models/labDocument.model";
import { getFamilyForActor } from "./careRecordAuth.service";
import { notifyCaregivers } from "./saheliCaregiverAlert.service";

type ThresholdRule = { pattern: RegExp; max?: number; min?: number; unit?: string };

const THRESHOLDS: ThresholdRule[] = [
    { pattern: /creatinine/i, max: 1.5 },
    { pattern: /tsh/i, min: 0.4, max: 4.5 },
    { pattern: /hba1c/i, max: 7 },
    { pattern: /glucose|fbs|fasting blood sugar/i, max: 126 },
    { pattern: /hemoglobin|\bhb\b/i, min: 10 },
];

function valueIsAbnormal(name: string, rawValue: string): boolean {
    const num = Number.parseFloat(rawValue.replace(/[^\d.]/g, ""));
    if (Number.isNaN(num)) return false;
    for (const rule of THRESHOLDS) {
        if (!rule.pattern.test(name)) continue;
        if (rule.max != null && num > rule.max) return true;
        if (rule.min != null && num < rule.min) return true;
    }
    return false;
}

export async function getAbnormalLabFlags(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
): Promise<{ flags: Array<{ name: string; value: string; source: string; date?: string }> }> {
    await getFamilyForActor(familyId, actorUserId);
    const docs = await LabDocument.find({ familyId, recipientUserId })
        .sort({ createdAt: -1 })
        .limit(15)
        .lean();

    const flags: Array<{ name: string; value: string; source: string; date?: string }> = [];
    for (const doc of docs) {
        const structured = doc.structuredValues ?? [];
        for (const row of structured) {
            if (valueIsAbnormal(row.name, row.value)) {
                flags.push({
                    name: row.name,
                    value: row.value,
                    source: doc.title,
                    date: row.date ?? doc.recordDate,
                });
            }
        }
    }
    return { flags: flags.slice(0, 10) };
}

export async function maybeAlertCaregiversOnLabUpload(input: {
    familyId: string;
    recipientUserId: string;
    documentTitle: string;
    structuredValues?: Array<{ name: string; value: string; unit?: string; date?: string }>;
}): Promise<void> {
    const abnormal = (input.structuredValues ?? []).filter((row) =>
        valueIsAbnormal(row.name, row.value),
    );
    if (!abnormal.length) return;

    const summary = abnormal
        .slice(0, 3)
        .map((r) => `${r.name}: ${r.value}${r.unit ? ` ${r.unit}` : ""}`)
        .join("; ");

    await notifyCaregivers({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.recipientUserId,
        message: `New lab uploaded (${input.documentTitle}). Flagged values: ${summary}. Please review in Kavach.`,
        urgency: "medium",
        kind: "lab_alert",
    });
}
