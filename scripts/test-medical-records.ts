/**
 * Sample prescription + lab PDF, the dashboard lines for that record,
 * a failed photo that still keeps the file, and retry staying on an open order.
 */
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { extractTextFromUpload } from "../src/services/r2Storage.service";
import {
    applyExtraction,
    contentHash,
    extractMedicalRecord,
    isSameSavedFile,
    medicalUploadProblem,
} from "../src/services/medicalRecordExtract.service";
import { findMedicineLines, findPrintedHits } from "../src/services/labCite.service";
import { bindLatestQuestion } from "../src/services/commerceAutomation/orderChat/flowBind";
import { medicalUploadError } from "../../kavach-dashboard/lib/medical-record-file";
import { medicalRecordLines } from "../../kavach-dashboard/lib/medical-record-view";

let n = 0;
const t = (name: string, fn: () => void | Promise<void>) => {
    const run = fn();
    if (run && typeof (run as Promise<void>).then === "function") {
        throw new Error(`${name} returned a promise — use top-level await`);
    }
    n++;
    console.log(`  ✓ ${name}`);
};

function pdfWith(lines: string[]): Buffer {
    const body = lines
        .map((line, i) => `${i === 0 ? "BT /F1 12 Tf 40 260 Td" : "0 -18 Td"} (${line.replace(/[()\\]/g, "")}) Tj`)
        .join(" ");
    const stream = `${body} ET`;
    const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 500 400]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${stream.length}>>stream
${stream}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`;
    return Buffer.from(pdf);
}

const dir = mkdtempSync(path.join(tmpdir(), "kavach-records-"));
const rxPath = path.join(dir, "prescription.pdf");
const labPath = path.join(dir, "lab.pdf");
writeFileSync(
    rxPath,
    pdfWith([
        "Patient: Meera Rao",
        "Date: 12 Aug 2026",
        "Dr. Anil Shah",
        "Telma 40 mg once daily",
    ]),
);
writeFileSync(
    labPath,
    pdfWith([
        "Laboratory: Thyrocare",
        "Patient: Meera Rao",
        "Date: 12 Aug 2026",
        "Haemoglobin 11.4 g/dL",
        "TSH 4.2 mIU/L",
    ]),
);

async function main() {
    const rxText = await extractTextFromUpload(readFileSync(rxPath), "application/pdf", "prescription.pdf");
    const rx = extractMedicalRecord(rxText);
    t("prescription PDF: patient, date, doctor, dose — nothing invented", () => {
        assert.equal(rx.patientName, "Meera Rao");
        assert.equal(rx.recordDate, "12 Aug 2026");
        assert.equal(rx.provider, "Dr. Anil Shah");
        assert.deepEqual(rx.medicines, [{ name: "Telma", dose: "40 mg" }]);
        assert.equal(rx.labs.length, 0);
        assert.doesNotMatch(rx.summary, /500|Yoga|aspirin|10 mg/i);
        assert.equal(rx.unread.includes("medicines"), false);
    });

    const labText = await extractTextFromUpload(readFileSync(labPath), "application/pdf", "lab.pdf");
    const lab = extractMedicalRecord(labText);
    t("lab PDF: lab name and values with units", () => {
        assert.equal(lab.patientName, "Meera Rao");
        assert.equal(lab.recordDate, "12 Aug 2026");
        assert.equal(lab.provider, "Thyrocare");
        assert.equal(lab.kind, "lab");
        const names = lab.labs.map((l) => `${l.name} ${l.value} ${l.unit}`);
        assert.ok(names.some((l) => /Haemoglobin 11\.4 g\/dL/i.test(l)), names.join(" | "));
        assert.ok(names.some((l) => /TSH 4\.2 mIU\/L/i.test(l)), names.join(" | "));
        assert.equal(lab.medicines.length, 0);
        assert.doesNotMatch(lab.summary, /Telma|40 mg/);
    });

    t("dashboard record shows the file and the extracted fields", () => {
        const lines = medicalRecordLines({
            patient_name: lab.patientName,
            provider: lab.provider,
            record_date: lab.recordDate,
            medicines: lab.medicines,
            lab_values: lab.labs,
            unread: lab.unread,
            extraction_status: lab.unread.length ? "partial" : "ready",
            file_name: "lab.pdf",
            ai_summary: lab.summary,
        });
        const text = lines.join("\n");
        assert.match(text, /Meera Rao/);
        assert.match(text, /Thyrocare/);
        assert.match(text, /TSH 4\.2 mIU\/L/);
        assert.match(text, /Haemoglobin 11\.4 g\/dL/);
        assert.match(text, /File: lab\.pdf/);
    });

    t("a photo that cannot be read keeps the upload and does not invent values", () => {
        const saved = applyExtraction({ text: "", vision: null, pageWasImage: true });
        assert.equal(saved.status, "failed");
        assert.match(saved.extract.summary, /Extraction failed/);
        assert.match(saved.extract.summary, /original file is saved/i);
        assert.equal(saved.extract.labs.length, 0);
        assert.equal(saved.extract.medicines.length, 0);
        assert.equal(saved.extract.patientName, null);
        const lines = medicalRecordLines({
            extraction_status: "failed",
            file_name: "photo.heic",
            unread: saved.extract.unread,
            ai_summary: saved.extract.summary,
        });
        assert.match(lines.join("\n"), /Extraction failed/);
        assert.match(lines.join("\n"), /photo\.heic/);
    });

    t("the same file is one record, and junk or empty files are refused", () => {
        const bytes = readFileSync(rxPath);
        const hash = contentHash(bytes);
        assert.equal(isSameSavedFile(hash, hash), true);
        assert.equal(isSameSavedFile(contentHash(Buffer.from("other")), hash), false);
        assert.match(medicalUploadProblem({ size: 0, name: "a.pdf" }) || "", /empty/i);
        assert.match(medicalUploadProblem({ size: 16 * 1024 * 1024, name: "a.pdf" }) || "", /too large/i);
        assert.match(medicalUploadProblem({ size: 20, name: "notes.zip", mimeType: "application/zip" }) || "", /not a document/i);
        assert.equal(medicalUploadProblem({ size: 20, name: "IMG.HEIC", mimeType: "image/heic" }), null);
        assert.equal(medicalUploadError({ name: "photo.jpg", size: 0 }), "This file is empty.");
        assert.match(medicalUploadError({ name: "song.mp3", size: 20, type: "audio/mpeg" }) || "", /not a document/i);
    });

    t("Saheli can cite the saved lab value and the saved medicine", () => {
        const labSaved = applyExtraction({ text: labText, vision: null, pageWasImage: false });
        const hits = findPrintedHits(
            [{ title: "Lab — Thyrocare", rawText: labSaved.rawText, recordDate: lab.recordDate ?? undefined }],
            "what was the TSH",
        );
        assert.equal(hits[0]?.value, "4.2");
        assert.equal(hits[0]?.unit, "mIU/L");
        const rxSaved = applyExtraction({ text: rxText, vision: null, pageWasImage: false });
        const meds = findMedicineLines(
            [{ title: "Prescription", rawText: rxSaved.rawText, recordDate: rx.recordDate ?? undefined }],
            "what medicine is on the prescription",
        );
        assert.match(meds.join("\n"), /Telma 40 mg/);
        const failed = applyExtraction({ text: "", vision: null, pageWasImage: true });
        assert.equal(
            findPrintedHits([{ title: "photo", rawText: failed.rawText }], "what was the TSH").length,
            0,
        );
    });

    t("retry on an open order is not a medical-record lookup", () => {
        const bound = bindLatestQuestion("Retry", { browserPhase: "running", browserAt: 5 });
        assert.equal(bound?.owner, "browser");
        assert.equal(bound?.control, "retry");
        const yes = bindLatestQuestion("yes", { browserPhase: "awaiting_confirm", browserAt: 9 });
        assert.equal(yes?.owner, "browser");
        assert.equal(yes?.control, "confirm");
    });

    console.log(`all ${n} passed`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
