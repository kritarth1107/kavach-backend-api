import { randomUUID } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "../src/models/users.model";
import Family from "../src/models/family.model";
import LabDocument from "../src/models/labDocument.model";
import { FamilyMemberStatus, FamilyRole } from "../src/types/family.types";

dotenv.config();

const LABS_DIR = "/home/noooblien/kawach-private/moms-records/Mom_s Reports Markdowns";
const CLINICAL_DIR =
    "/home/noooblien/kawach-private/moms-records/Mom_s clinical records/Vasundara_Devi_Clinical_Records_Markdown";

const CLINICAL_FILES = [
    { file: "01_TumorMarkers_Baseline_Jun2023.md", kind: "lab", title: "Tumor markers · CEA & CA 125", date: "2023-06-05" },
    { file: "02_Karkinos_NGS_Jun2023.md", kind: "ngs", title: "Tissue NGS · Karkinos K-50", date: "2023-06-26" },
    { file: "03_Guardant360_Sep2023.md", kind: "ngs", title: "Liquid biopsy · Guardant360", date: "2023-09-07" },
    { file: "04_PETCT_Sep2025.md", kind: "scan", title: "PET-CT whole body", date: "2025-09-11" },
    { file: "06_DischargeSummary_Jan2026.md", kind: "discharge", title: "Discharge summary · Cycle 30", date: "2026-01-29" },
    { file: "08_DischargeSummary_Mar2026.md", kind: "discharge", title: "Discharge summary · Cycle 31", date: "2026-03-10" },
    { file: "10_PETCT_Apr2026.md", kind: "scan", title: "PET-CT whole body", date: "2026-04-24" },
];

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
    if (!raw.startsWith("---")) return { meta: {}, body: raw };
    const end = raw.indexOf("\n---", 3);
    if (end < 0) return { meta: {}, body: raw };
    const yaml = raw.slice(4, end);
    const body = raw.slice(end + 4).replace(/^\s+/, "");
    const meta: Record<string, string> = {};
    for (const line of yaml.split("\n")) {
        const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        meta[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
    return { meta, body };
}

function formatRecordDate(iso: string): string {
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return iso;
    const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function dateFromIso(iso: string): Date {
    const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return new Date();
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
}

function clip(text: string, max = 49000): string {
    const trimmed = text.trim();
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, max)}\n\n[Truncated — printed values continued in source file.]`;
}

function panelLabel(meta: Record<string, string>, body: string): string {
    const headings = [...body.matchAll(/^###\s+(.+)$/gm)].map((m) => m[1].replace(/^Biochemistry — |^Haematology — /, ""));
    if (headings.length) return headings.slice(0, 4).join(", ");
    return meta.panels || "Lab report";
}

async function main() {
    if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
    await mongoose.connect(process.env.MONGODB_URI);

    const caregiver = await User.findOne({
        $or: [{ email: /kritarth@kavach\.care/i }, { email: /kritarth@kawach\.care/i }],
    });
    if (!caregiver) throw new Error("Kritarth user not found");

    const family = await Family.findOne({
        "members.userId": caregiver.userId,
        status: "ACTIVE",
    });
    if (!family) throw new Error("Kritarth family not found");

    const recipient = family.members.find(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
    );
    if (!recipient?.userId) throw new Error("No care recipient");

    const familyId = family.familyId;
    const recipientUserId = recipient.userId;

    await LabDocument.deleteMany({ familyId, recipientUserId });

    const created: Array<{ title: string; date: string; kind: string }> = [];

    const labFiles = readdirSync(LABS_DIR)
        .filter((f) => f.endsWith(".md") && f !== "README.md")
        .sort();

    for (const file of labFiles) {
        const raw = readFileSync(join(LABS_DIR, file), "utf8");
        const { meta, body } = parseFrontmatter(raw);
        const iso = meta.report_date || file.slice(0, 10);
        const stamped = dateFromIso(iso);
        const title = `Lab · ${formatRecordDate(iso)} · ${panelLabel(meta, body)}`.slice(0, 200);
        await LabDocument.create({
            documentId: randomUUID(),
            familyId,
            recipientUserId,
            title,
            rawText: clip(body || raw),
            kind: "lab",
            recordDate: formatRecordDate(iso),
            createdBy: caregiver.userId,
            createdAt: stamped,
            updatedAt: stamped,
        });
        created.push({ title, date: formatRecordDate(iso), kind: "lab" });
    }

    for (const item of CLINICAL_FILES) {
        const raw = readFileSync(join(CLINICAL_DIR, item.file), "utf8");
        const stamped = dateFromIso(item.date);
        const title = `${item.title} · ${formatRecordDate(item.date)}`.slice(0, 200);
        await LabDocument.create({
            documentId: randomUUID(),
            familyId,
            recipientUserId,
            title,
            rawText: clip(raw),
            kind: item.kind,
            recordDate: formatRecordDate(item.date),
            createdBy: caregiver.userId,
            createdAt: stamped,
            updatedAt: stamped,
        });
        created.push({ title, date: formatRecordDate(item.date), kind: item.kind });
    }

    console.log(
        JSON.stringify(
            {
                ok: true,
                familyId,
                recipientUserId,
                count: created.length,
                labs: labFiles.length,
                clinical: CLINICAL_FILES.length,
                latest: created.slice(-3),
            },
            null,
            2,
        ),
    );

    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
