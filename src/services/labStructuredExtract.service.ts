const LAB_PATTERNS: Array<{ name: string; regex: RegExp; unit?: string }> = [
    { name: "TSH", regex: /\bTSH\b[^0-9\n]{0,20}([\d.]+)\s*(mIU\/L|miu\/l)?/i, unit: "mIU/L" },
    { name: "HbA1c", regex: /\bHbA?1c\b[^0-9\n]{0,20}([\d.]+)\s*(%|mmol\/mol)?/i, unit: "%" },
    { name: "Creatinine", regex: /\bCreatinine\b[^0-9\n]{0,20}([\d.]+)\s*(mg\/dL|mg\/dl)?/i, unit: "mg/dL" },
    { name: "Hemoglobin", regex: /\b(Hemoglobin|Haemoglobin|Hb)\b[^0-9\n]{0,20}([\d.]+)\s*(g\/dL|g\/dl)?/i, unit: "g/dL" },
    { name: "Vitamin D", regex: /\bVitamin\s*D\b[^0-9\n]{0,20}([\d.]+)\s*(ng\/mL|ng\/ml)?/i, unit: "ng/mL" },
    { name: "Fasting glucose", regex: /\b(Fasting\s*(?:blood\s*)?sugar|FBS|FBG)\b[^0-9\n]{0,20}([\d.]+)\s*(mg\/dL|mg\/dl)?/i, unit: "mg/dL" },
];

export function extractStructuredLabValues(rawText: string, recordDate?: string) {
    const values: Array<{ name: string; value: string; unit?: string; date?: string }> = [];
    for (const pattern of LAB_PATTERNS) {
        const match = rawText.match(pattern.regex);
        if (!match) continue;
        const value = match[2] ?? match[1];
        if (!value) continue;
        values.push({
            name: pattern.name,
            value: String(value),
            unit: match[3] ? String(match[3]) : pattern.unit,
            date: recordDate,
        });
    }
    return values;
}
