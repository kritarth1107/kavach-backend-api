export type LabSource = {
    title: string;
    recordDate?: string;
    rawText: string;
    kind?: string;
};

export type LabHit = {
    test: string;
    value: string;
    unit: string;
    title: string;
    recordDate?: string;
};

const TEST_ALIASES: Array<{ intent: RegExp; aliases: string[] }> = [
    { intent: /\b(tsh|thyroid stimulating)\b/i, aliases: ["TSH"] },
    { intent: /\b(free t4|ft4|t4)\b/i, aliases: ["Free T4", "T4"] },
    { intent: /\b(creatinine|kft|kidney)\b/i, aliases: ["Creatinine"] },
    { intent: /\b(urea)\b/i, aliases: ["Urea"] },
    { intent: /\b(hba1c|a1c|glycated)\b/i, aliases: ["HbA1c"] },
    { intent: /\b(fasting glucose|glucose fasting|blood sugar|sugar)\b/i, aliases: ["Glucose"] },
    { intent: /\b(haemoglobin|hemoglobin|\bhb\b|anemi)/i, aliases: ["Haemoglobin", "Hemoglobin"] },
    { intent: /\b(platelet)\b/i, aliases: ["Platelet"] },
    { intent: /\b(wbc|white cell|tlc)\b/i, aliases: ["Total WBC", "WBC"] },
    { intent: /\b(sgpt|alt)\b/i, aliases: ["SGPT", "ALT"] },
    { intent: /\b(sgot|ast)\b/i, aliases: ["SGOT", "AST"] },
    { intent: /\b(bilirubin)\b/i, aliases: ["Bilirubin Total", "Bilirubin"] },
    { intent: /\b(albumin)\b/i, aliases: ["Albumin"] },
    { intent: /\b(vitamin d|vit d|25-?oh|25 oh)\b/i, aliases: ["Vitamin D"] },
    { intent: /\b(b12|vitamin b12)\b/i, aliases: ["Vitamin B12", "B12"] },
    { intent: /\b(cea)\b/i, aliases: ["CEA", "Carcinoembryonic"] },
    { intent: /\b(ca\s*125|ca125)\b/i, aliases: ["CA 125", "CA125"] },
    { intent: /\b(ferritin)\b/i, aliases: ["Ferritin"] },
    { intent: /\b(iron)\b/i, aliases: ["Iron"] },
    { intent: /\b(sodium)\b/i, aliases: ["Sodium"] },
    { intent: /\b(potassium)\b/i, aliases: ["Potassium"] },
    { intent: /\b(calcium)\b/i, aliases: ["Calcium"] },
];

function parseTableRows(rawText: string): Array<{ test: string; value: string; unit: string }> {
    const rows: Array<{ test: string; value: string; unit: string }> = [];
    for (const line of rawText.split("\n")) {
        if (!line.includes("|")) continue;
        if (/^\s*\|?\s*-{2,}/.test(line) || /Test\s*\|\s*(Value|Method|Result)/i.test(line)) continue;
        const cells = line
            .split("|")
            .map((c) => c.replace(/\*/g, "").trim())
            .filter(Boolean);
        if (cells.length < 2) continue;

        const test = cells[0];
        let value = cells[1];
        let unit = cells[2] ?? "";
        if (
            cells.length >= 4 &&
            /[a-z]/i.test(cells[1]) &&
            !/^[\d.<≥≤]/.test(cells[1])
        ) {
            value = cells[2];
            unit = cells[3];
        }
        if (test.length > 80 || !value) continue;
        rows.push({ test, value, unit });
    }
    return rows;
}

function rowMatches(test: string, alias: string): boolean {
    const t = test.toLowerCase();
    const a = alias.toLowerCase();
    if (a === "tsh") return /\btsh\b/.test(t) || t.includes("thyroid stimulating");
    if (a === "glucose") return t.includes("glucose") && !t.includes("hba1c");
    return t.includes(a);
}

export function findPrintedHits(labs: LabSource[], question: string): LabHit[] {
    const wanted = TEST_ALIASES.filter((t) => t.intent.test(question));
    if (!wanted.length) return [];

    const newestFirst = [...labs].reverse();
    const hits: LabHit[] = [];

    for (const group of wanted) {
        for (const lab of newestFirst) {
            const rows = parseTableRows(lab.rawText);
            const row = rows.find((r) => group.aliases.some((alias) => rowMatches(r.test, alias)));
            if (!row) continue;
            hits.push({
                test: row.test.replace(/\s+/g, " ").trim(),
                value: row.value,
                unit: row.unit,
                title: lab.title,
                recordDate: lab.recordDate,
            });
            break;
        }
    }
    return hits;
}

export function findNamedReports(labs: LabSource[], question: string): LabSource[] {
    const q = question.toLowerCase();
    return labs.filter((lab) => {
        const blob = `${lab.title} ${lab.kind ?? ""} ${lab.rawText.slice(0, 400)}`.toLowerCase();
        if (/\b(pet|pet-ct|pet ct)\b/.test(q)) return /pet/.test(blob);
        if (/\b(discharge|cycle|hospital|manipal)\b/.test(q)) return /discharge|cycle/.test(blob);
        if (/\b(ngs|guardant|karkinos|liquid biopsy|mutation)\b/.test(q)) {
            return /ngs|guardant|karkinos|liquid biopsy/.test(blob);
        }
        if (/\b(tumor marker|cea|ca 125)\b/.test(q)) return /cea|ca 125|tumor marker/.test(blob);
        return false;
    });
}

export function formatPrintedHit(hit: LabHit): string {
    const unit = hit.unit && hit.unit !== "-" ? ` ${hit.unit}` : "";
    const from = hit.recordDate ? `${hit.title} (${hit.recordDate})` : hit.title;
    return `${hit.test}: ${hit.value}${unit}\nFrom: “${from}”`;
}

export function excerptReport(lab: LabSource, max = 420): string {
    const printed = lab.rawText.replace(/\s+/g, " ").trim();
    const cut = printed.slice(0, max);
    const from = lab.recordDate ? `${lab.title} (${lab.recordDate})` : lab.title;
    return `${cut}${printed.length > max ? "…" : ""}\nFrom: “${from}”`;
}
