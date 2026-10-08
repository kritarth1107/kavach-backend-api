/**
 * Health records are read, shown, and only then acted on. A new record waits as "needs_review": nothing from it
 * reaches Saheli's memory, the medicine schedule, the trends or the family until a person chooses what to do
 * (on the dashboard or on WhatsApp). A record whose name belongs to someone else is held until they say whose it is.
 */
import { AppError } from "../middleware/error.middleware";
import LabDocument from "../models/labDocument.model";
import { readingFromModel, type Flag, type Reading, type ReadResult, type ReadValue } from "./healthRecordReader.service";

/** Records Saheli, search, alerts and trends may use: saved ones (and records from before the review step). */
export const APPROVED_RECORDS = { reviewStatus: { $nin: ["needs_review", "file_only"] } } as const;

/* ── whose record is it ─────────────────────────────────────────────────── */

const TITLE_WORDS = new Set(["mr", "mrs", "ms", "miss", "smt", "shri", "sri", "shrimati", "kumari", "kum", "master", "baby", "dr", "late", "md", "w", "o", "s", "d", "c"]);

/** Name words worth comparing: lower case, titles and initials dropped ("MRS. B.N.VASUNDARA DEVI" → vasundara, devi). */
export function nameTokens(name: string | null | undefined): string[] {
    return String(name || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length >= 3 && !TITLE_WORDS.has(w));
}

function editDistance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    return d[a.length][b.length];
}

const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 5 && editDistance(a, b) <= 1);

/** Does the name on the report belong to this person (any real name word in common, allowing one typo)? */
export function namesMatch(onReport: string, personNames: string[]): boolean {
    const report = nameTokens(onReport);
    const mine = personNames.flatMap(nameTokens);
    return report.some((r) => mine.some((m) => sameWord(r, m)));
}

export type PersonCheck = { status: "match" | "mismatch" | "unknown"; nameOnReport?: string; suggestedUserId?: string; suggestedName?: string; confirmedBy?: string };

async function memberNames(familyId: string): Promise<Array<{ userId: string; name: string; names: string[] }>> {
    const { default: Family } = await import("../models/family.model");
    const { default: User } = await import("../models/users.model");
    const fam = await Family.findOne({ familyId, status: "ACTIVE" }).lean<{ members?: Array<{ userId?: string; status?: string; nickname?: string; relation?: string }> }>();
    const ids = (fam?.members ?? []).filter((m) => m.userId && m.status === "JOINED").map((m) => m.userId!);
    const users = await User.find({ userId: { $in: ids } }, { userId: 1, firstName: 1, lastName: 1, displayName: 1 }).lean<Array<{ userId: string; firstName?: string; lastName?: string; displayName?: string }>>();
    return users.map((u) => {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.displayName || "";
        const nick = (fam?.members ?? []).find((m) => m.userId === u.userId)?.nickname;
        return { userId: u.userId, name, names: [name, u.displayName || "", nick || ""].filter(Boolean) };
    });
}

export async function checkPerson(familyId: string, subjectUserId: string, nameOnReport: string | null): Promise<PersonCheck> {
    if (!nameOnReport || !nameTokens(nameOnReport).length) return { status: "unknown" };
    const members = await memberNames(familyId);
    const me = members.find((m) => m.userId === subjectUserId);
    if (me && namesMatch(nameOnReport, me.names)) return { status: "match", nameOnReport };
    if (!me) return { status: "unknown", nameOnReport }; // no name on file to compare with
    const other = members.find((m) => m.userId !== subjectUserId && namesMatch(nameOnReport, m.names));
    return { status: "mismatch", nameOnReport, ...(other ? { suggestedUserId: other.userId, suggestedName: other.name } : {}) };
}

/* ── values: names, flags, dates ────────────────────────────────────────── */

const ALIASES: Array<[RegExp, string, string]> = [
    [/^(haemoglobin|hemoglobin|hb|hgb)$/, "haemoglobin", "Haemoglobin"],
    [/^(wbc|tlc|total (leucocyte|leukocyte|wbc) count|wbc count|white blood cells?( count)?|total leucocytes?)$/, "wbc", "WBC count"],
    [/^(platelets?|platelet count|plt)$/, "platelets", "Platelets"],
    [/^(rbc|rbc count|red blood cells?( count)?)$/, "rbc", "RBC count"],
    [/^creatinine$/, "creatinine", "Creatinine"],
    [/^(urea|bun|blood urea nitrogen)$/, "urea", "Urea"],
    [/^(hba1c|glycated (haemoglobin|hemoglobin)|glycosylated (haemoglobin|hemoglobin))$/, "hba1c", "HbA1c"],
    [/^(fbs|fasting (blood )?(sugar|glucose)|glucose fasting|fasting plasma glucose|fpg)$/, "glucose_fasting", "Fasting glucose"],
    [/^(ppbs|post ?prandial (blood )?(sugar|glucose)|glucose (pp|post ?prandial))$/, "glucose_pp", "After-meal glucose"],
    [/^(rbs|random (blood )?(sugar|glucose)|glucose random)$/, "glucose_random", "Random glucose"],
    [/^(tsh|thyroid stimulating hormone)$/, "tsh", "TSH"],
    [/^(bp|blood pressure)$/, "bp", "Blood pressure"],
    [/^(sgpt|alt|alanine (amino)?transaminase)( alt| sgpt)?$/, "alt", "SGPT (ALT)"],
    [/^(sgot|ast|aspartate (amino)?transaminase)( ast| sgot)?$/, "ast", "SGOT (AST)"],
    [/^(ldl|ldl cholesterol)$/, "ldl", "LDL cholesterol"],
    [/^(hdl|hdl cholesterol)$/, "hdl", "HDL cholesterol"],
    [/^(cholesterol|total cholesterol)$/, "cholesterol", "Total cholesterol"],
    [/^(vitamin d|25 oh vitamin d|vit d|vitamin d3)$/, "vitamin_d", "Vitamin D"],
    [/^(vitamin b12|vit b12|b12)$/, "vitamin_b12", "Vitamin B12"],
];

/** One key per test, so "S. Creatinine" and "Creatinine (serum)" trend together. */
export function testKey(name: string): { key: string; label: string } {
    const plain = name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/(^|\s)s\.\s*/g, " ").replace(/\b(serum|plasma)\b/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    for (const [re, key, label] of ALIASES) if (re.test(plain)) return { key, label };
    return { key: plain.replace(/ /g, "_") || name.toLowerCase(), label: name.trim() };
}

const num = (s: string | null | undefined): number | null => {
    const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
};

/** low / high / normal from the printed range ("12-15", "< 5.7", "> 40", "upto 35", "130/80"); else the reader's flag. */
export function computeFlag(value: string, range: string | null | undefined, given: Flag | null | undefined): Flag | null {
    const r = String(range || "").toLowerCase().replace(/,/g, "").replace(/[–—]/g, "-").trim();
    if (/\//.test(value) && /\//.test(r)) {
        const [s, d] = value.split("/").map((x) => num(x));
        const [rs, rd] = r.replace(/[<≤>≥]|upto|up to|below/g, "").split("/").map((x) => num(x));
        if (s != null && d != null && rs != null && rd != null && /[<≤]|upto|up to|below/.test(r)) return s >= rs || d >= rd ? "high" : "normal";
        return given ?? null;
    }
    const v = num(value);
    if (v == null || !r) return given ?? null;
    const between = r.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)/);
    if (between) {
        const lo = Number(between[1]), hi = Number(between[2]);
        return v < lo ? "low" : v > hi ? "high" : "normal";
    }
    const upper = r.match(/(?:<|≤|upto|up to|below|less than)\s*=?\s*(-?\d+(?:\.\d+)?)/);
    if (upper) return v > Number(upper[1]) ? "high" : "normal";
    const lower = r.match(/(?:>|≥|above|more than)\s*=?\s*(-?\d+(?:\.\d+)?)/);
    if (lower) return v < Number(lower[1]) ? "low" : "normal";
    return given ?? null;
}

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };

/** "2026-04-22", "22 Apr 2026", "11 Sept 2025", "22/04/2026" (Indian order) → YYYY-MM-DD. */
export function isoOf(text: string | null | undefined): string | null {
    const t = String(text || "").trim().toLowerCase();
    let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = t.match(/(\d{1,2})[\s-]+([a-z]{3,9})[a-z]*[\s,-]+(\d{4})/);
    if (m && MONTHS[m[2].slice(0, m[2].startsWith("sept") ? 4 : 3)] !== undefined) {
        const mon = MONTHS[m[2].startsWith("sept") ? "sept" : m[2].slice(0, 3)];
        return `${m[3]}-${String(mon + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    m = t.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})/);
    if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return null;
}

export function dateLabel(iso: string | null | undefined): string {
    if (!iso) return "undated";
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/* ── what Saheli would remember ─────────────────────────────────────────── */

type Prior = { value: number; date: string };

/** Short lines Saheli keeps from a record (shown before saving; each can be removed). */
export function memoryPoints(reading: Reading, prior: Map<string, Prior> = new Map()): string[] {
    const when = dateLabel(reading.recordDate) === "undated" ? reading.recordDateText || "undated" : dateLabel(reading.recordDate);
    if (reading.kind === "prescription" && reading.medicines.length) {
        const who = reading.doctor || reading.provider || "Prescription";
        const meds = reading.medicines.map((m) => [m.name, m.strength].filter(Boolean).join(" ")).join(", ");
        const next = reading.followUps.length ? `; before the next visit: ${reading.followUps.join(", ")}` : "";
        return [`${who}, ${when}: ${meds}${next}`.slice(0, 220)];
    }
    if (reading.values.length) {
        const odd = reading.values.map((v) => ({ v, flag: computeFlag(v.value, v.range, v.flag) })).filter((x) => x.flag === "low" || x.flag === "high");
        if (!odd.length) return [`${reading.title} on ${when}: all ${reading.values.length} values in the normal range`];
        return odd.slice(0, 5).map(({ v, flag }) => {
            const { key } = testKey(v.name);
            const p = prior.get(key);
            const now = num(v.value);
            const cmp = p && now != null && p.value !== now ? `, ${now < p.value ? "lower" : "higher"} than on ${dateLabel(p.date)}` : "";
            return `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ""} (${flag}) on ${when}${cmp}`;
        });
    }
    if (reading.summary) return [`${reading.title} on ${when}: ${reading.summary}`.slice(0, 260)];
    return [];
}

/** Latest saved value per test before this record, for "lower than in April". */
async function priorValues(familyId: string, recipientUserId: string, beforeIso: string | null, excludeId?: string): Promise<Map<string, Prior>> {
    const docs = await LabDocument.find({ familyId, recipientUserId, ...APPROVED_RECORDS, ...(excludeId ? { documentId: { $ne: excludeId } } : {}) }, { structuredValues: 1, recordDate: 1, createdAt: 1 }).lean();
    const out = new Map<string, Prior>();
    for (const d of docs) {
        const date = isoOf(d.recordDate) || (d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null);
        if (!date || (beforeIso && date >= beforeIso)) continue;
        for (const v of d.structuredValues ?? []) {
            const n = num(v.value);
            if (n == null) continue;
            const { key } = testKey(v.name);
            const cur = out.get(key);
            if (!cur || cur.date < date) out.set(key, { value: n, date: isoOf(v.date) || date });
        }
    }
    return out;
}

/* ── draft (shared by dashboard upload and WhatsApp) ────────────────────── */

export type DraftMedicine = Reading["medicines"][number] & { alreadyOnSchedule: boolean; add: boolean };
export type DraftReading = Omit<Reading, "medicines"> & { medicines: DraftMedicine[]; memoryPoints: string[] };

async function activeMedicineNames(familyId: string, recipientUserId: string): Promise<string[]> {
    const { default: CareSchedule } = await import("../models/careSchedule.model");
    const rows = await CareSchedule.find({ familyId, recipientUserId, type: "MEDICINE", active: true }, { title: 1 }).lean<Array<{ title: string }>>();
    return rows.map((r) => r.title);
}

/** The medicine's brand word ("Tab Shelcal 500" → shelcal). */
export function medicineWord(name: string): string {
    return nameTokens(name.replace(/\b(tab|tablet|cap|capsule|syp|syrup|inj|injection|drops?|oint|ointment)\b\.?/gi, " "))[0] || name.toLowerCase();
}

export async function buildDraft(familyId: string, recipientUserId: string, read: ReadResult, excludeId?: string): Promise<{ reading: DraftReading; personCheck: PersonCheck }> {
    const r = read.reading;
    const onSchedule = (await activeMedicineNames(familyId, recipientUserId)).map(medicineWord);
    const medicines = r.medicines.map((m) => {
        const already = onSchedule.some((w) => sameWord(w, medicineWord(m.name)));
        return { ...m, alreadyOnSchedule: already, add: !already && m.times.length > 0 };
    });
    const prior = await priorValues(familyId, recipientUserId, r.recordDate, excludeId);
    const values = r.values.map((v) => ({ ...v, flag: computeFlag(v.value, v.range, v.flag) }));
    const reading: DraftReading = { ...r, values, medicines, memoryPoints: [] };
    reading.memoryPoints = memoryPoints(reading, prior);
    return { reading, personCheck: await checkPerson(familyId, recipientUserId, r.patientName) };
}

/** Fields written on the record for a new draft. */
export function draftFields(read: ReadResult, draft: { reading: DraftReading; personCheck: PersonCheck }, fallbackTitle: string) {
    const r = draft.reading;
    return {
        title: (read.status === "failed" ? fallbackTitle : r.title || fallbackTitle).slice(0, 200),
        kind: read.status === "failed" ? "other" : r.kind,
        recordDate: r.recordDate ? dateLabel(r.recordDate) : r.recordDateText || undefined,
        patientName: r.patientName || undefined,
        provider: (r.provider || r.doctor || undefined)?.slice(0, 80),
        medicines: r.medicines.map((m) => ({ name: m.name, dose: [m.strength, m.dose].filter(Boolean).join(" ") || undefined })),
        unreadParts: r.unread,
        extractionStatus: read.status,
        analysisStatus: read.status === "failed" ? ("failed" as const) : ("ready" as const),
        aiSummary: (read.status === "failed" ? "Saheli could not read this record. The original file is saved." : r.summary).slice(0, 500),
        reviewStatus: "needs_review" as const,
        reading: draft.reading as unknown as Record<string, unknown>,
        personCheck: draft.personCheck,
        readError: read.error?.slice(0, 300),
        structuredValues: [],
    };
}

/* ── after the person chooses ───────────────────────────────────────────── */

/** Text Saheli's record search reads (only for saved records). */
export function citeText(r: Reading): string {
    const lines = [
        `${r.title}${r.recordDate ? ` · ${dateLabel(r.recordDate)}` : r.recordDateText ? ` · ${r.recordDateText}` : ""}`,
        r.patientName ? `Patient: ${r.patientName}${r.patientAge ? `, ${r.patientAge}` : ""}${r.patientSex ? ` ${r.patientSex}` : ""}` : "",
        r.provider ? `From: ${r.provider}` : "",
        r.doctor ? `Doctor: ${r.doctor}` : "",
        ...r.values.map((v) => `${v.name}: ${v.value}${v.unit ? ` ${v.unit}` : ""}${v.range ? ` (normal ${v.range})` : ""}${v.flag && v.flag !== "normal" ? ` ${v.flag.toUpperCase()}` : ""}`),
        ...r.medicines.map((m) => `Medicine: ${[m.name, m.strength, m.dose, m.frequency].filter(Boolean).join(" ")}${m.durationDays ? ` for ${m.durationDays} days` : ""}`),
        r.nextVisit ? `Next visit: ${r.nextVisit.text}` : "",
        r.followUps.length ? `Before the next visit: ${r.followUps.join(", ")}` : "",
        r.summary ? `Summary: ${r.summary}` : "",
    ];
    return lines.filter(Boolean).join("\n").slice(0, 48_000);
}

/** The person's edits, cleaned the same way as a fresh read (so a typo cannot inject a malformed value). */
export function cleanEdited(edited: unknown, original: DraftReading): DraftReading {
    const base = readingFromModel({ ...original, ...(edited && typeof edited === "object" ? edited : {}) }) ?? original;
    const e = (edited && typeof edited === "object" ? edited : {}) as Partial<DraftReading>;
    const medsIn = Array.isArray(e.medicines) ? e.medicines : original.medicines;
    const medicines: DraftMedicine[] = base.medicines.map((m, i) => {
        // Match the person's row by name (a row whose name was blanked is dropped, which shifts positions).
        const src = (medsIn.find((x) => String((x as Partial<DraftMedicine>)?.name ?? "").replace(/\s+/g, " ").trim() === m.name) ?? medsIn[i] ?? {}) as Partial<DraftMedicine>;
        const times = (Array.isArray(src.times) ? src.times : m.times).map((t) => String(t).trim()).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
        return { ...m, times: [...new Set(times)].sort(), alreadyOnSchedule: Boolean(src.alreadyOnSchedule ?? original.medicines[i]?.alreadyOnSchedule), add: Boolean(src.add) };
    });
    const values: ReadValue[] = base.values.map((v) => ({ ...v, flag: computeFlag(v.value, v.range, v.flag) }));
    const points = (Array.isArray(e.memoryPoints) ? e.memoryPoints : original.memoryPoints).map((p) => String(p).replace(/\s+/g, " ").trim().slice(0, 260)).filter(Boolean).slice(0, 8);
    return { ...base, values, medicines, memoryPoints: points };
}

/** When the next visit is, from "Review after 1 month" + the record date (or a printed date). */
export function nextVisitDate(r: Reading): string | null {
    if (r.nextVisit?.date) return r.nextVisit.date;
    if (!r.nextVisit?.text) return null;
    const m = r.nextVisit.text.toLowerCase().match(/(\d+|one|two|three|four|six)\s*(day|week|month)s?/);
    if (!m) return null;
    const n = Number(m[1]) || { one: 1, two: 2, three: 3, four: 4, six: 6 }[m[1]] || 0;
    const from = r.recordDate ? new Date(`${r.recordDate}T00:00:00Z`) : new Date();
    const days = m[2] === "day" ? n : m[2] === "week" ? n * 7 : n * 30;
    return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function endsOn(startIso: string, days: number | null): string | null {
    if (!days) return null;
    return new Date(new Date(`${startIso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export type Decision = {
    action: "save" | "file_only" | "discard";
    reading?: unknown;
    saveValues?: boolean;
    remember?: boolean;
    addMedicines?: boolean;
    nextVisitReminder?: boolean;
    notifyFamily?: boolean;
};

export type DecisionResult = {
    deleted?: boolean;
    reviewStatus?: string;
    scheduled: string[];
    scheduleProblems: string[];
    remembered: number;
    reminder: boolean;
    notified: boolean;
};

const ACTOR = (id: string, name: string) => ({ id, name: name || "Family" });

export async function applyDecision(familyId: string, recipientUserId: string, documentId: string, actor: { id: string; name: string }, input: Decision): Promise<DecisionResult> {
    const doc = await LabDocument.findOne({ familyId, recipientUserId, documentId });
    if (!doc) throw new AppError("Health record not found", 404);
    const out: DecisionResult = { scheduled: [], scheduleProblems: [], remembered: 0, reminder: false, notified: false };
    if (input.action === "discard") {
        await removeRecord(doc);
        return { ...out, deleted: true };
    }
    if (doc.reviewStatus === "saved") throw new AppError("This record is already saved", 409);
    const pc = doc.personCheck as PersonCheck | undefined;
    if (pc?.status === "mismatch" && !pc.confirmedBy) throw new AppError("First choose whose record this is", 409, { code: "person_mismatch" });
    const original = (doc.reading as unknown as DraftReading | undefined) ?? null;
    if (input.action === "file_only") {
        doc.reviewStatus = "file_only";
        doc.structuredValues = [];
        doc.decision = { action: "file_only", by: actor.id, at: new Date().toISOString() };
        await doc.save();
        return { ...out, reviewStatus: "file_only" };
    }
    if (!original || doc.extractionStatus === "failed") throw new AppError("Nothing could be read from this record yet. Read it again, or keep only the file.", 409, { code: "not_read" });
    const r = cleanEdited(input.reading, original);
    const recordIso = r.recordDate || new Date().toISOString().slice(0, 10);
    doc.title = r.title.slice(0, 200);
    doc.kind = r.kind;
    doc.recordDate = r.recordDate ? dateLabel(r.recordDate) : r.recordDateText || doc.recordDate;
    doc.patientName = r.patientName || undefined;
    doc.provider = (r.provider || r.doctor || undefined)?.slice(0, 80);
    doc.medicines = r.medicines.map((m) => ({ name: m.name, dose: [m.strength, m.dose].filter(Boolean).join(" ") || undefined }));
    doc.rawText = citeText(r);
    doc.aiSummary = r.summary.slice(0, 500) || doc.aiSummary;
    doc.structuredValues = input.saveValues === false ? [] : r.values.map((v) => ({ name: v.name, value: v.value, unit: v.unit || undefined, refRange: v.range || undefined, flag: v.flag || undefined, date: r.recordDate || undefined }));
    doc.reading = r as unknown as Record<string, unknown>;
    if (!doc.contentHash) {
        // The store's unique index counts a missing fingerprint as a duplicate of every other record.
        const { contentHash } = await import("./medicalRecordExtract.service");
        doc.contentHash = contentHash(Buffer.from(`text:${doc.documentId}:${doc.rawText}`));
    }
    doc.reviewStatus = "saved";
    doc.analysisStatus = "ready";
    await doc.save();

    const base = `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(recipientUserId)}`;
    const { aiEngineJson } = await import("../clients/aiEngine.client");
    if (input.remember && r.memoryPoints.length) {
        try {
            await aiEngineJson("POST", `${base}/records/remember`, { actor: ACTOR(actor.id, actor.name), document_id: documentId, title: r.title, date: recordIso, points: r.memoryPoints }, 30_000);
            out.remembered = r.memoryPoints.length;
        } catch (err) {
            console.warn(`record remember failed doc=${documentId}:`, err instanceof Error ? err.message : err);
        }
    }
    if (input.addMedicines !== false) {
        for (const m of r.medicines.filter((x) => x.add && x.times.length && !x.alreadyOnSchedule)) {
            const dose = [m.strength, m.dose].filter(Boolean).join(", ");
            const until = endsOn(new Date().toISOString().slice(0, 10), m.durationDays);
            const food = m.food ? ` ${m.food.replace("_", " ")}` : "";
            try {
                await aiEngineJson("POST", `${base}/facts`, {
                    actor: ACTOR(actor.id, actor.name), domain: "medicine", name: m.name,
                    details: { name: m.name, dose: dose || null, times: m.times, ...(m.food ? { food_timing: m.food } : {}), ...(m.instructions ? { instructions: m.instructions } : {}),
                               ...(until ? { ends_on: until } : {}), from_record: documentId },
                    sentence: `${m.name}${dose ? ` ${dose}` : ""} at ${m.times.join(", ")}${food}${until ? ` until ${dateLabel(until)}` : ""} (from ${r.doctor || r.title})`.slice(0, 480),
                }, 45_000);
                out.scheduled.push(m.name);
            } catch (err) {
                out.scheduleProblems.push(m.name);
                console.warn(`record medicine failed doc=${documentId} ${m.name}:`, err instanceof Error ? err.message : err);
            }
        }
    }
    if (input.nextVisitReminder) {
        const visit = nextVisitDate(r);
        if (visit) {
            const due = new Date(Math.max(Date.now() + 86_400_000, new Date(`${visit}T00:00:00Z`).getTime() - 7 * 86_400_000)).toISOString().slice(0, 10);
            const who = r.doctor ? ` with ${r.doctor}` : "";
            const title = r.followUps.length ? `Before the next visit${who} (${dateLabel(visit)}): ${r.followUps.join(", ")}` : `Next visit${who} around ${dateLabel(visit)}: book it`;
            try {
                await aiEngineJson("POST", `${base}/family-tasks`, { actor: ACTOR(actor.id, actor.name), title: title.slice(0, 290), assignee: actor.id, due }, 20_000);
                out.reminder = true;
            } catch (err) {
                console.warn(`record visit reminder failed doc=${documentId}:`, err instanceof Error ? err.message : err);
            }
        }
    }
    if (input.notifyFamily) {
        const odd = r.values.filter((v) => v.flag === "low" || v.flag === "high");
        const msg = odd.length
            ? `New ${r.title} (${dateLabel(r.recordDate)}): ${odd.slice(0, 4).map((v) => `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ""} ${v.flag}`).join(", ")}.`
            : `New ${r.title} saved (${dateLabel(r.recordDate)}).`;
        try {
            const { notifyCaregivers } = await import("./saheliCaregiverAlert.service");
            const sent = await notifyCaregivers({ familyId, recipientUserId, actorUserId: actor.id, message: msg, urgency: "medium", kind: "lab_alert", dedupeKey: `record:${documentId}` });
            out.notified = sent.notifiedCount > 0;
        } catch {
            /* the record is saved either way */
        }
    }
    const { appendCareRecordEvent } = await import("./careRecord.service");
    const { CareRecordEventType, CareRecordSource, ChannelType } = await import("../types/careRecord.types");
    await appendCareRecordEvent({
        familyId, subjectUserId: recipientUserId, actorUserId: actor.id, type: CareRecordEventType.DOCUMENT,
        source: doc.via === "whatsapp" ? CareRecordSource.SAHELI : CareRecordSource.DASHBOARD,
        channel: doc.via === "whatsapp" ? ChannelType.WHATSAPP : ChannelType.DASHBOARD,
        title: r.title, detail: (r.memoryPoints.join(" · ") || r.summary).slice(0, 500),
        payload: { documentId, kind: r.kind, rawText: doc.rawText }, status: "logged",
    }).catch(() => null);
    doc.decision = { action: "save", by: actor.id, at: new Date().toISOString(), remembered: out.remembered, scheduled: out.scheduled, reminder: out.reminder, notified: out.notified };
    await doc.save();
    return { ...out, reviewStatus: "saved" };
}

/** Delete a record everywhere: the file, the record, its timeline entries and what Saheli remembered from it. */
export async function removeRecord(doc: { familyId: string; recipientUserId: string; documentId: string; storageKey?: string; aiMemoryDocumentId?: string }): Promise<void> {
    if (doc.storageKey) {
        const { deleteFamilyFile } = await import("./r2Storage.service");
        await deleteFamilyFile(doc.storageKey).catch(() => null);
    }
    try {
        const { aiEngineJson } = await import("../clients/aiEngine.client");
        await aiEngineJson("POST", `/v2/dash/${encodeURIComponent(doc.familyId)}/${encodeURIComponent(doc.recipientUserId)}/records/forget`, {
            actor: { id: "system", name: "Kavach" }, document_id: doc.documentId, memory_document_id: doc.aiMemoryDocumentId || null,
        }, 20_000);
    } catch (err) {
        console.warn(`record forget failed doc=${doc.documentId}:`, err instanceof Error ? err.message : err);
    }
    const { default: CareRecordEvent } = await import("../models/careRecordEvent.model");
    await CareRecordEvent.deleteMany({ familyId: doc.familyId, "payload.documentId": doc.documentId }).catch(() => null);
    await LabDocument.deleteOne({ familyId: doc.familyId, documentId: doc.documentId });
}

/** "It is hers" or "it's for someone else in the family". */
export async function resolvePerson(familyId: string, recipientUserId: string, documentId: string, actorId: string, input: { action: "theirs" | "move"; toUserId?: string }) {
    const doc = await LabDocument.findOne({ familyId, recipientUserId, documentId });
    if (!doc) throw new AppError("Health record not found", 404);
    if (doc.reviewStatus === "saved") throw new AppError("This record is already saved", 409);
    const pc = (doc.personCheck as PersonCheck | undefined) ?? { status: "unknown" };
    if (input.action === "theirs") {
        doc.personCheck = { ...pc, status: "match", confirmedBy: actorId };
        await doc.save();
        return { recipientUserId };
    }
    const to = String(input.toUserId || "");
    if (!to || to === recipientUserId) throw new AppError("Choose who this record is for", 400);
    const { getFamilyForActor, requireCareSubject, requirePermission } = await import("./careRecordAuth.service");
    const family = await getFamilyForActor(familyId, actorId);
    requireCareSubject(family, to, actorId);
    requirePermission(family, actorId, "upload_document");
    doc.recipientUserId = to;
    doc.personCheck = { ...pc, status: "match", confirmedBy: actorId };
    // The schedule check and the comparisons were for the old person: read them again for the new one.
    const reading = doc.reading as unknown as DraftReading | undefined;
    if (reading) {
        const fresh = await buildDraft(familyId, to, { status: (doc.extractionStatus as ReadResult["status"]) || "ready", reading, model: "", ms: 0 });
        doc.reading = fresh.reading as unknown as Record<string, unknown>;
    }
    try {
        await doc.save();
    } catch (err) {
        if ((err as { code?: number }).code === 11000) throw new AppError("This file is already in their records", 409);
        throw err;
    }
    return { recipientUserId: to };
}

/* ── stat cards: the important numbers from the reports this person has ─── */

export type StatCard = {
    key: string; name: string; value: string; unit: string | null; range: string | null; flag: Flag | null;
    date: string | null; count: number; trend: Array<{ date: string | null; value: number }>; delta: number | null; prevDate: string | null;
};

/** Markers families usually watch; a small tie-break only, and only when their own reports include them. */
const KEY_MARKERS = new Set(["haemoglobin", "creatinine", "hba1c", "glucose_fasting", "bp", "tsh", "wbc", "platelets", "egfr", "potassium", "sodium", "ldl"]);

/** How far outside its range a value is, as a fraction of the nearest limit (0 when unknown). */
export function deviation(value: string, range: string | null, flag: Flag | null): number {
    const v = num(value);
    const r = String(range || "").replace(/,/g, "").replace(/[–—]/g, "-");
    if (v == null || !r) return 0;
    const between = r.match(/(-?\d+(?:\.\d+)?)\s*(?:-|to)\s*(-?\d+(?:\.\d+)?)/);
    let limit: number | null = null;
    if (between) limit = flag === "low" ? Number(between[1]) : Number(between[2]);
    else limit = num(r);
    if (!limit) return 0;
    return Math.abs(v - limit) / Math.abs(limit);
}

export async function recordHighlights(familyId: string, recipientUserId: string) {
    const docs = await LabDocument.find({ familyId, recipientUserId, ...APPROVED_RECORDS }, { structuredValues: 1, recordDate: 1, createdAt: 1, documentId: 1, title: 1 }).lean();
    const groups = new Map<string, { label: string; points: Array<{ date: string | null; value: string; unit: string | null; range: string | null; flag: Flag | null; n: number | null }> }>();
    let reports = 0;
    for (const d of docs) {
        const vals = d.structuredValues ?? [];
        if (!vals.length) continue;
        reports++;
        const docDate = isoOf(d.recordDate) || (d.createdAt ? new Date(d.createdAt).toISOString().slice(0, 10) : null);
        for (const v of vals) {
            const { key, label } = testKey(v.name);
            const g = groups.get(key) ?? { label, points: [] };
            g.points.push({ date: isoOf(v.date) || docDate, value: v.value, unit: v.unit || null, range: v.refRange || null, flag: computeFlag(v.value, v.refRange, (v.flag as Flag) || null), n: num(v.value) });
            groups.set(key, g);
        }
    }
    const cards: StatCard[] = [];
    for (const [key, g] of groups) {
        const pts = g.points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const last = pts[pts.length - 1];
        const numeric = pts.filter((p) => p.n != null);
        const prev = numeric.length >= 2 ? numeric[numeric.length - 2] : null;
        cards.push({
            key, name: g.label, value: last.value, unit: last.unit, range: last.range, flag: last.flag, date: last.date, count: pts.length,
            trend: numeric.slice(-6).map((p) => ({ date: p.date, value: p.n! })),
            delta: prev && last.n != null ? Math.round((last.n - prev.n!) * 100) / 100 : null, prevDate: prev?.date ?? null,
        });
    }
    const today = Date.now();
    const score = (c: StatCard) => {
        // Outside normal first, the further outside the higher (Hb 9.8 vs 12–15 before RDW 14.5 vs 11.5–14);
        // then the common key markers when the reports have them; then how often measured; then how recent.
        const off = c.flag === "low" || c.flag === "high" ? 1000 + Math.min(deviation(c.value, c.range, c.flag), 1) * 600 : 0;
        const key = KEY_MARKERS.has(c.key) ? 150 : 0;
        const ageDays = c.date ? Math.max(0, (today - new Date(`${c.date}T00:00:00Z`).getTime()) / 86_400_000) : 3650;
        return off + key + Math.min(c.count, 6) * 20 - Math.min(ageDays, 3650) / 10;
    };
    const ranked = [...cards].sort((a, b) => score(b) - score(a));
    const latestDate = cards.reduce<string | null>((m, c) => (c.date && (!m || c.date > m) ? c.date : m), null);
    // A value last measured more than a year before the newest report (a one-off test in 2023) stays in "all values"
    // but does not take a card, unless there is not enough recent to fill them.
    const yearBefore = latestDate ? new Date(new Date(`${latestDate}T00:00:00Z`).getTime() - 365 * 86_400_000).toISOString().slice(0, 10) : null;
    const recent = ranked.filter((c) => !yearBefore || (c.date != null && c.date >= yearBefore));
    const top = [...recent, ...ranked.filter((c) => !recent.includes(c))].slice(0, 4);
    return { cards: top, all: ranked, reports, latestDate, noticed: noticedFor(top, groups) };
}

/** One plain observation for the most important card, only when the reports clearly show it. */
function noticedFor(top: StatCard[], groups: Map<string, { label: string; points: Array<{ flag: Flag | null; n: number | null }> }>): { key: string; text: string } | null {
    for (const c of top) {
        if (c.flag !== "low" && c.flag !== "high") continue;
        const pts = groups.get(c.key)!.points;
        let run = 0;
        for (let i = pts.length - 1; i >= 0 && pts[i].flag === c.flag; i--) run++;
        if (run < 3) continue;
        const nums = pts.map((p) => p.n).filter((n): n is number => n != null);
        const last = nums[nums.length - 1];
        const extreme = c.flag === "low" ? last <= Math.min(...nums) : last >= Math.max(...nums);
        const word = c.flag === "low" ? "below" : "above";
        return { key: c.key, text: `${c.name} has been ${word} normal in the last ${run} reports${extreme ? ` and is the ${c.flag === "low" ? "lowest" : "highest"} so far` : ""}. Worth asking the doctor at the next visit.` };
    }
    return null;
}

/* ── corrections said in chat ("Shelcal is 500", "Hb is 9.8") ─────────────── */

export type Correction = { name: string; value?: string; times?: string[]; remove?: boolean };

/** Apply corrections to a draft (by medicine brand word or test name); returns the names that matched. */
export function applyCorrections(r: DraftReading, corrections: Correction[]): { reading: DraftReading; matched: string[]; unmatched: string[] } {
    const out: DraftReading = { ...r, values: [...r.values], medicines: [...r.medicines] };
    const matched: string[] = [];
    const unmatched: string[] = [];
    for (const c of corrections.slice(0, 10)) {
        const name = String(c.name || "").trim();
        if (!name) continue;
        const mi = out.medicines.findIndex((m) => sameWord(medicineWord(m.name), medicineWord(name)));
        if (mi >= 0) {
            if (c.remove) out.medicines.splice(mi, 1);
            else {
                const m = { ...out.medicines[mi] };
                if (c.value) m.strength = String(c.value).trim().slice(0, 40);
                if (Array.isArray(c.times)) m.times = [...new Set(c.times.map((t) => String(t).trim()).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort();
                out.medicines[mi] = m;
            }
            matched.push(name);
            continue;
        }
        const key = testKey(name).key;
        const vi = out.values.findIndex((v) => testKey(v.name).key === key);
        if (vi >= 0) {
            if (c.remove) out.values.splice(vi, 1);
            else if (c.value && /\d/.test(c.value)) {
                const v = { ...out.values[vi], value: String(c.value).trim().slice(0, 30) };
                v.flag = computeFlag(v.value, v.range, null);
                out.values[vi] = v;
            }
            matched.push(name);
            continue;
        }
        unmatched.push(name);
    }
    return { reading: out, matched, unmatched };
}

/** Saheli's health_record tool (WhatsApp, typed answers): decide, confirm the name, or correct what was read. */
export async function recordReviewTool(familyId: string, actorUserId: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const documentId = String(args.document_id || "");
    const doc = await LabDocument.findOne({ familyId, documentId });
    if (!doc) return { ok: false, error: "No such health record in this family (it may have been deleted)." };
    if (doc.reviewStatus !== "needs_review") return { ok: false, error: `Already decided (${doc.reviewStatus}).` };
    const { default: User } = await import("../models/users.model");
    const u = await User.findOne({ userId: actorUserId }, { firstName: 1, lastName: 1 }).lean<{ firstName?: string; lastName?: string }>();
    const actor = { id: actorUserId, name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "Family" };
    const subj = doc.recipientUserId;
    const choice = String(args.choice || "");
    try {
        if (choice === "add_medicines" || choice === "keep_record") {
            const res = await applyDecision(familyId, subj, documentId, actor, { action: "save", remember: true, addMedicines: choice === "add_medicines" });
            return { ok: true, saved: true, reminders_added: res.scheduled, reminders_failed: res.scheduleProblems, remembered: res.remembered };
        }
        if (choice === "file_only") {
            await applyDecision(familyId, subj, documentId, actor, { action: "file_only" });
            return { ok: true, kept: "file only; nothing remembered" };
        }
        if (choice === "delete") {
            await applyDecision(familyId, subj, documentId, actor, { action: "discard" });
            return { ok: true, deleted: true };
        }
        if (choice === "mine") {
            await resolvePerson(familyId, subj, documentId, actorUserId, { action: "theirs" });
            return { ok: true, confirmed: "the record is theirs; now ask what to do with it" };
        }
        if (choice === "fix") {
            const reading = doc.reading as unknown as DraftReading | undefined;
            if (!reading) return { ok: false, error: "Nothing was read from this record; offer to read it again or keep only the file." };
            const fixed = applyCorrections(reading, Array.isArray(args.corrections) ? (args.corrections as Correction[]) : []);
            const draft = await buildDraft(familyId, subj, { status: "ready", reading: fixed.reading, model: "", ms: 0 }, documentId);
            // keep the person's own choices on the medicines they did not correct
            draft.reading.medicines = draft.reading.medicines.map((m, i) => ({ ...m, add: fixed.reading.medicines[i]?.add ?? m.add }));
            doc.reading = draft.reading as unknown as Record<string, unknown>;
            await doc.save();
            const r = draft.reading;
            return {
                ok: true, corrected: fixed.matched, not_found: fixed.unmatched,
                now_reads: [...r.medicines.map((m) => `${[m.name, m.strength].filter(Boolean).join(" ")} at ${m.times.join(", ") || "no time"}`),
                            ...r.values.filter((v) => v.flag === "low" || v.flag === "high").map((v) => `${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ""} (${v.flag})`)],
                next: "Read the corrected lines back and ask what to do (add to reminders / just keep the record / keep only the file).",
            };
        }
    } catch (err) {
        if ((err as { code?: string }).code === "person_mismatch") return { ok: false, error: "The name on the record is someone else's: ask whose it is first (choice mine if it is theirs, or delete)." };
        return { ok: false, error: err instanceof Error ? err.message : "failed" };
    }
    return { ok: false, error: "Unknown choice." };
}
