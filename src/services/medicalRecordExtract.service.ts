/**
 * Reads a medical document into fields that are actually on the page.
 * A missing field stays blank and is named in `unread`. Nothing is filled in by guesswork.
 */
import { createHash } from "crypto";

export const MAX_MEDICAL_UPLOAD_BYTES = 15 * 1024 * 1024;

const DOC_EXT = new Set([
    ".pdf", ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp",
    ".txt", ".md", ".markdown", ".csv", ".json", ".xlsx", ".xls", ".docx", ".doc",
]);

export type MedicineLine = { name: string; dose: string | null };
export type LabLine = { name: string; value: string; unit: string | null };

export type MedicalRecordExtract = {
    patientName: string | null;
    recordDate: string | null;
    provider: string | null;
    medicines: MedicineLine[];
    labs: LabLine[];
    summary: string;
    unread: string[];
    kind: "prescription" | "lab" | "discharge" | "other";
};

export type SavedExtraction = {
    extract: MedicalRecordExtract;
    status: "ready" | "partial" | "failed";
    /** Text Saheli may cite later. Failed reads do not invent values. */
    rawText: string;
};

const LAB_UNIT =
    /(?:mIU\/L|miu\/l|mg\/dL|mg\/dl|g\/dL|g\/dl|ng\/mL|ng\/ml|mmol\/L|mmol\/l|U\/L|u\/l|%|fL|pg|10\^3\/uL)/i;
const DOSE_UNIT = /\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|ml|iu)\b/i;

export function contentHash(buffer: Buffer): string {
    return createHash("sha256").update(buffer).digest("hex");
}

/** Same bytes already stored for this elder — do not write a second copy. */
export function isSameSavedFile(nextHash: string, savedHash: string | null | undefined): boolean {
    return Boolean(savedHash && nextHash && savedHash === nextHash);
}

export function medicalUploadProblem(file: {
    size: number;
    mimeType?: string;
    name?: string;
}): string | null {
    if (!file || !file.size) return "This file is empty.";
    if (file.size > MAX_MEDICAL_UPLOAD_BYTES) return "This file is too large. The maximum is 15 MB.";
    const name = file.name || "";
    const ext = extensionOf(name);
    const mime = (file.mimeType || "").split(";")[0].trim().toLowerCase();
    const mimeOk =
        mime === "application/pdf" ||
        mime.startsWith("image/") ||
        mime.startsWith("text/") ||
        mime.includes("word") ||
        mime.includes("excel") ||
        mime.includes("spreadsheet") ||
        mime === "application/json" ||
        mime === "application/msword";
    if (DOC_EXT.has(ext) || mimeOk) return null;
    if (!ext && (mime === "" || mime === "application/octet-stream")) {
        return "This is not a document we can read. Use a photo (JPG, PNG, HEIC) or a PDF.";
    }
    return "This is not a document we can read. Use a photo (JPG, PNG, HEIC) or a PDF.";
}

function extensionOf(name: string): string {
    const m = name.toLowerCase().match(/(\.[a-z0-9]+)$/);
    return m ? m[1] : "";
}

function clean(value: string | null | undefined, max = 80): string | null {
    const t = String(value || "").replace(/\s+/g, " ").trim();
    if (!t || t.length < 2) return null;
    return t.slice(0, max);
}

/** Turn a flattened PDF line back into labeled rows without adding facts. */
export function readableLines(text: string): string[] {
    const broken = String(text || "")
        .replace(/\s+--\s*\d+\s+of\s+\d+\s*--/gi, "\n")
        .replace(/\s+(?=(?:patient(?:\s*name)?|date|dated|doctor|dr\.?|laboratory|lab)\s*[:\-])/gi, "\n");
    return broken
        .split(/\n+/)
        .map((s) => s.replace(/[ \t]+/g, " ").trim())
        .filter(Boolean);
}

function takeLabel(line: string, label: RegExp): string | null {
    const m = line.match(label);
    if (!m?.[1]) return null;
    return clean(m[1].replace(/[|].*$/, ""));
}

function parseMedicine(line: string): MedicineLine | null {
    if (LAB_UNIT.test(line)) return null;
    const m = line.match(/^([A-Za-z][A-Za-z0-9][A-Za-z0-9\- ]{1,40}?)\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|g|ml))\b/i);
    if (!m) return null;
    const name = clean(m[1], 60);
    const dose = clean(m[2], 40);
    if (!name || !dose) return null;
    if (/^(patient|date|dated|doctor|laboratory|lab|report)$/i.test(name)) return null;
    return { name, dose };
}

function parseLab(line: string): LabLine | null {
    const pipe = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (pipe.length >= 2 && /^[\d.]+$/.test(pipe[1])) {
        const name = clean(pipe[0], 60);
        const value = pipe[1];
        const unit = pipe[2] && LAB_UNIT.test(pipe[2]) ? clean(pipe[2], 20) : unitIn(pipe.slice(2).join(" "));
        if (name && value) return { name, value, unit };
    }
    const m = line.match(/^([A-Za-z][A-Za-z0-9][A-Za-z0-9\- ]{0,40}?)\s+(\d+(?:\.\d+)?)\s+([A-Za-zµμ/%][A-Za-z0-9µμ/^.\-]{0,16})$/);
    if (!m) return null;
    if (DOSE_UNIT.test(`${m[2]} ${m[3]}`) && !LAB_UNIT.test(m[3])) return null;
    const name = clean(m[1], 60);
    if (!name) return null;
    return { name, value: m[2], unit: clean(m[3], 20) };
}

function unitIn(text: string): string | null {
    const m = text.match(LAB_UNIT);
    return m ? m[0] : null;
}

function clipBeforeNextFact(value: string | null): string | null {
    if (!value) return null;
    const clipped = value.split(/\s+(?=(?:date|dated|patient|dr\.?|doctor|laboratory|lab)\b)/i)[0] || value;
    const beforeDose = clipped.split(/\s+(?=[A-Z][A-Za-z]{2,}\s+\d)/)[0] || clipped;
    return clean(beforeDose, 80);
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const row of rows) {
        const k = key(row);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(row);
    }
    return out;
}

function scanMedicines(text: string): MedicineLine[] {
    const out: MedicineLine[] = [];
    const re = /\b([A-Z][A-Za-z][A-Za-z0-9\-]{1,30})\s+(\d+(?:\.\d+)?\s*(?:mg|mcg|µg|ug|ml))\b/g;
    for (const m of text.matchAll(re)) {
        if (LAB_UNIT.test(m[0])) continue;
        const name = clean(m[1], 60);
        const dose = clean(m[2], 40);
        if (!name || !dose) continue;
        out.push({ name, dose });
    }
    return out;
}

function scanLabs(text: string): LabLine[] {
    const out: LabLine[] = [];
    const re =
        /\b([A-Z][A-Za-z][A-Za-z0-9]{1,30})\s+(\d+(?:\.\d+)?)\s+(mIU\/L|mg\/dL|g\/dL|ng\/mL|mmol\/L|U\/L|%)/gi;
    for (const m of text.matchAll(re)) {
        const name = clean(m[1], 60);
        if (!name || /^(date|patient|doctor)$/i.test(name)) continue;
        out.push({ name, value: m[2], unit: m[3] });
    }
    return out;
}

function findDate(text: string): string | null {
    const named = text.match(
        /\b(\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4})\b/i,
    );
    if (named) return clean(named[1], 40);
    const numeric = text.match(/\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/);
    return numeric ? clean(numeric[1], 20) : null;
}

export function extractMedicalRecord(text: string): MedicalRecordExtract {
    const lines = readableLines(text);
    const blob = lines.join("\n");
    let patientName: string | null = null;
    let doctorName: string | null = null;
    let labName: string | null = null;

    for (const line of lines) {
        patientName =
            patientName ||
            clipBeforeNextFact(takeLabel(line, /patient(?:\s*name)?\s*[:\-]\s*(.+)$/i));
        const doctor = takeLabel(line, /(?:doctor|dr\.?)\s*[:\-]?\s*(.+)$/i);
        if (doctor && !/^date\b/i.test(doctor)) {
            doctorName = doctorName || clipBeforeNextFact(doctor.replace(/^dr\.?\s*/i, ""));
        }
        const foundLab = takeLabel(line, /(?:laboratory|lab)\s*[:\-]\s*(.+)$/i);
        if (foundLab && !/values|report|test/i.test(foundLab)) labName = labName || clipBeforeNextFact(foundLab);
    }

    const medicines = uniqueBy(
        [...scanMedicines(blob), ...lines.map(parseMedicine).filter((m): m is MedicineLine => Boolean(m))],
        (m) => m.name.toLowerCase(),
    );
    const labs = uniqueBy(
        [...scanLabs(blob), ...lines.map(parseLab).filter((l): l is LabLine => Boolean(l))],
        (l) => l.name.toLowerCase(),
    );
    const provider = doctorName ? `Dr. ${doctorName}` : labName;

    const recordDate = findDate(blob);
    const lower = blob.toLowerCase();
    const kind: MedicalRecordExtract["kind"] = /discharge/.test(lower)
        ? "discharge"
        : labs.length && !medicines.length
          ? "lab"
          : medicines.length
            ? "prescription"
            : /laboratory|\blab\b|report/.test(lower)
              ? "lab"
              : "other";

    const unread: string[] = [];
    if (!patientName) unread.push("patient name");
    if (!recordDate) unread.push("date");
    if (!provider) unread.push("doctor or lab");
    const looksRx = medicines.length > 0 || /\brx\b|tablet|capsule|once daily|twice daily/.test(lower);
    const looksLab = labs.length > 0 || /laboratory|\blab report\b|reference range/.test(lower);
    if (looksRx && !medicines.length) unread.push("medicines");
    if (looksLab && !labs.length) unread.push("lab values");
    if (!blob.trim()) unread.splice(0, unread.length, "the page");

    return {
        patientName,
        recordDate,
        provider,
        medicines: medicines.slice(0, 20),
        labs: labs.slice(0, 40),
        summary: summaryOf({ patientName, recordDate, provider, medicines, labs, kind }),
        unread,
        kind,
    };
}

function summaryOf(ex: Omit<MedicalRecordExtract, "summary" | "unread">): string {
    const bits: string[] = [];
    if (ex.patientName) bits.push(`Patient: ${ex.patientName}.`);
    if (ex.recordDate) bits.push(`Date: ${ex.recordDate}.`);
    if (ex.provider) bits.push(`From: ${ex.provider}.`);
    if (ex.medicines.length) {
        bits.push(
            `Medicines: ${ex.medicines.map((m) => (m.dose ? `${m.name} ${m.dose}` : m.name)).join(", ")}.`,
        );
    }
    if (ex.labs.length) {
        bits.push(
            `Labs: ${ex.labs.map((l) => `${l.name} ${l.value}${l.unit ? ` ${l.unit}` : ""}`).join(", ")}.`,
        );
    }
    if (!bits.length) return "The page could not be read into fields.";
    return bits.join(" ").slice(0, 480);
}

/**
 * Printed text wins. A photo with no text uses the vision read.
 * A failed vision read keeps no invented values.
 */
export function applyExtraction(input: {
    text: string;
    vision: MedicalRecordExtract | null;
    pageWasImage: boolean;
}): SavedExtraction {
    const printed = extractMedicalRecord(input.text || "");
    const printedUseful = Boolean(
        printed.patientName || printed.recordDate || printed.provider || printed.medicines.length || printed.labs.length,
    );
    if (printedUseful) {
        const status = printed.unread.length ? "partial" : "ready";
        return { extract: printed, status, rawText: citeText(printed, input.text) };
    }
    if (input.vision && (input.vision.medicines.length || input.vision.labs.length || input.vision.patientName || input.vision.provider)) {
        const extract = { ...input.vision, summary: summaryOf(input.vision) };
        const status = extract.unread.length ? "partial" : "ready";
        return { extract, status, rawText: citeText(extract, "") };
    }
    const extract = extractMedicalRecord("");
    extract.unread = ["the page"];
    extract.summary = input.pageWasImage
        ? "Extraction failed. The photo could not be read. The original file is saved."
        : "Extraction failed. The document could not be read. The original file is saved.";
    return { extract, status: "failed", rawText: extract.summary };
}

function citeText(ex: MedicalRecordExtract, original: string): string {
    const lines = [
        ex.patientName ? `Patient: ${ex.patientName}` : "",
        ex.recordDate ? `Date: ${ex.recordDate}` : "",
        ex.provider ? `From: ${ex.provider}` : "",
        ...ex.medicines.map((m) => `Medicine: ${m.name}${m.dose ? ` ${m.dose}` : ""}`),
        ...ex.labs.map((l) => `${l.name} ${l.value}${l.unit ? ` ${l.unit}` : ""}`),
        ex.unread.length ? `Could not read: ${ex.unread.join(", ")}.` : "",
        original.trim() ? original.trim() : "",
    ].filter(Boolean);
    return lines.join("\n").slice(0, 48_000);
}

/** Model JSON is accepted only when each value is a non-empty string the model claims was printed. */
export function medicalRecordFromModelJson(raw: unknown): MedicalRecordExtract | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const str = (v: unknown, max = 80) => {
        const t = typeof v === "string" ? v.trim() : "";
        if (!t || /^(unknown|n\/a|none|null|unreadable)$/i.test(t)) return null;
        return t.slice(0, max);
    };
    const medicines: MedicineLine[] = [];
    if (Array.isArray(o.medicines)) {
        for (const row of o.medicines) {
            if (!row || typeof row !== "object") continue;
            const r = row as Record<string, unknown>;
            const name = str(r.name, 60);
            if (!name) continue;
            medicines.push({ name, dose: str(r.dose, 40) });
        }
    }
    const labs: LabLine[] = [];
    if (Array.isArray(o.labs)) {
        for (const row of o.labs) {
            if (!row || typeof row !== "object") continue;
            const r = row as Record<string, unknown>;
            const name = str(r.name, 60);
            const value = str(r.value, 20);
            if (!name || !value || !/\d/.test(value)) continue;
            labs.push({ name, value, unit: str(r.unit, 20) });
        }
    }
    const unread = Array.isArray(o.unread)
        ? o.unread.map((x) => str(x, 40)).filter((x): x is string => Boolean(x)).slice(0, 8)
        : [];
    const patientName = str(o.patientName);
    const recordDate = str(o.recordDate, 40);
    const provider = str(o.provider);
    if (!patientName && !recordDate && !provider && !medicines.length && !labs.length) return null;
    const kind: MedicalRecordExtract["kind"] =
        o.kind === "lab" || o.kind === "prescription" || o.kind === "discharge" ? o.kind : labs.length ? "lab" : medicines.length ? "prescription" : "other";
    const extract: MedicalRecordExtract = {
        patientName,
        recordDate,
        provider,
        medicines,
        labs,
        unread,
        kind,
        summary: "",
    };
    extract.summary = summaryOf(extract);
    return extract;
}
