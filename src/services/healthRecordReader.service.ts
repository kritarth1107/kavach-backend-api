/**
 * Reads a health record (photo, PDF or pasted text) into what is printed on it: who it is for, the date, the values
 * with their normal ranges, the medicines with when to take them, the next visit. Nothing is guessed: a field that is
 * not on the page stays empty and is named in `unread`.
 *
 * Live 2026-10-08: the old photo reader allowed 1,024 output tokens; Gemini 3.1 Pro spent ~980 of them thinking, the
 * JSON was cut after 31 tokens and every photo became "could not be read", silently. This reader gives the model room,
 * keeps thinking low, waits long enough, and logs why a read failed.
 */
import { vertexGenerateText, lastVertexError, resetVertexError, parseJsonLoose, GEMINI_PRO_MODEL } from "../clients/vertexGemini.client";

export type Flag = "low" | "high" | "normal";
export type ReadValue = { name: string; value: string; unit: string | null; range: string | null; flag: Flag | null };
export type Food = "before_food" | "after_food" | "with_food" | "empty_stomach";
export type Slot = "morning" | "afternoon" | "evening" | "night";
export type ReadMedicine = {
    name: string;
    strength: string | null;
    dose: string | null;
    frequency: string | null;
    slots: Slot[];
    times: string[];
    food: Food | null;
    durationDays: number | null;
    instructions: string | null;
};
export type RecordKind = "lab" | "prescription" | "discharge" | "scan" | "other";
export type Reading = {
    patientName: string | null;
    patientAge: string | null;
    patientSex: string | null;
    recordDate: string | null; // YYYY-MM-DD when the page shows day, month and year
    recordDateText: string | null; // as printed
    provider: string | null; // lab, hospital or clinic
    doctor: string | null;
    kind: RecordKind;
    title: string;
    tests: string | null; // short label for a lab report: "Blood count, kidney, liver"
    values: ReadValue[];
    medicines: ReadMedicine[];
    nextVisit: { text: string; date: string | null } | null;
    followUps: string[];
    summary: string;
    unread: string[];
};
export type ReadResult = { status: "ready" | "partial" | "failed"; reading: Reading; error?: string; model: string; ms: number };

const KINDS: RecordKind[] = ["lab", "prescription", "discharge", "scan", "other"];
const SLOTS: Slot[] = ["morning", "afternoon", "evening", "night"];
const FOODS: Food[] = ["before_food", "after_food", "with_food", "empty_stomach"];
/** Default clock times for a dose slot; the person can change them before anything is saved. */
export const SLOT_TIME: Record<Slot, string> = { morning: "08:00", afternoon: "13:00", evening: "18:00", night: "21:00" };

const SYSTEM = `You read health records for an Indian family care app: lab reports, prescriptions, discharge summaries, scan reports.
The input may be a tilted or dim phone photo, a PDF, or pasted text. Report ONLY what is printed or handwritten on it.
Never guess a name, date, value, range, medicine, dose or timing. If something is unreadable, leave it null and list it in "unread".
- patientName, patientAge, patientSex exactly as printed.
- recordDate as YYYY-MM-DD only when day, month and year are all visible (Indian order is day/month/year); recordDateText as printed.
- provider: the lab, hospital or clinic; doctor: the doctor's name with "Dr."; kind: lab | prescription | discharge | scan | other.
- title: 2–6 words a family would use, e.g. "Blood count, kidney, liver", "Prescription · Dr. Mehta", "PET-CT whole body", "Discharge summary".
- tests (lab reports): the panels in a few words.
- values: every result with a number: name as printed (expand only obvious short forms like "Hb" → "Haemoglobin"), value exactly,
  unit, range = the printed reference/normal range (when it lists several bands by age, sex or category, give only the band
  that applies to this patient, e.g. "8.8–10" for a 63-year-old from "18–60 years: 8.6–10; 60–90 years: 8.8–10"; the normal /
  non-diabetic band for categories), flag = low | high | normal from the printed H/L mark or that range (null if neither).
  Blood pressure as one value "142/88" with unit "mmHg".
- medicines: name as on the paper (brand), strength ("40 mg"), dose ("1 tablet"), frequency as written ("1-0-1", "BD", "after dinner"),
  slots from the frequency: "1-0-0" → morning, "0-1-0" → afternoon, "0-0-1" → night, "1-0-1"/BD → morning+night, TDS → morning+afternoon+night,
  HS/bedtime → night, OD → morning; food: before_food | after_food | with_food | empty_stomach when written; durationDays when written ("x 30 days", "1 month" = 30).
- nextVisit: the review/follow-up line ("Review after 1 month") with date YYYY-MM-DD only if a date is printed; followUps: tests or actions to do before it.
- summary: 1–2 plain sentences of what the record says (for a scan or discharge: the impression or diagnosis). No advice.
- unread may contain only: "patient name", "date", "doctor or lab", "values", "medicines", "the page".`;

/** The JSON the reader returns (null where not printed). */
const SHAPE = `{"patientName": str|null, "patientAge": str|null, "patientSex": str|null, "recordDate": "YYYY-MM-DD"|null, "recordDateText": str|null,
 "provider": str|null, "doctor": str|null, "kind": "lab"|"prescription"|"discharge"|"scan"|"other", "title": str, "tests": str|null,
 "values": [{"name": str, "value": str, "unit": str|null, "range": str|null, "flag": "low"|"high"|"normal"|null}],
 "medicines": [{"name": str, "strength": str|null, "dose": str|null, "frequency": str|null, "slots": ["morning"|"afternoon"|"evening"|"night"],
   "food": "before_food"|"after_food"|"with_food"|"empty_stomach"|null, "durationDays": number|null, "instructions": str|null}],
 "nextVisit": {"text": str, "date": "YYYY-MM-DD"|null}|null, "followUps": [str], "summary": str,
 "unread": ["patient name"|"date"|"doctor or lab"|"values"|"medicines"|"the page"]}`;

const clip = (v: unknown, max = 120): string | null => {
    const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : typeof v === "number" ? String(v) : "";
    if (!t || /^(unknown|n\/a|na|none|null|unreadable|-)$/i.test(t)) return null;
    return t.slice(0, max);
};
const isoDate = (v: unknown): string | null => {
    const t = clip(v, 20);
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(`${t}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1990 ? null : t;
};

/** Earliest dose time for a slot, adjusted for food: before breakfast is a little earlier. */
export function timesFor(slots: Slot[], food: Food | null): string[] {
    const out = slots.map((s) => (s === "morning" && (food === "before_food" || food === "empty_stomach") ? "07:30" : SLOT_TIME[s]));
    return [...new Set(out)].sort();
}

/** Model JSON → a Reading with only values that look real (a value must contain a digit). */
export function readingFromModel(raw: unknown): Reading | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Record<string, unknown>;
    const values: ReadValue[] = [];
    for (const r of Array.isArray(o.values) ? o.values : []) {
        if (!r || typeof r !== "object") continue;
        const v = r as Record<string, unknown>;
        const name = clip(v.name, 80);
        const value = clip(v.value, 30);
        if (!name || !value || !/\d/.test(value)) continue;
        const flag = v.flag === "low" || v.flag === "high" || v.flag === "normal" ? v.flag : null;
        values.push({ name, value, unit: clip(v.unit, 24), range: clip(v.range, 40), flag });
    }
    const medicines: ReadMedicine[] = [];
    for (const r of Array.isArray(o.medicines) ? o.medicines : []) {
        if (!r || typeof r !== "object") continue;
        const m = r as Record<string, unknown>;
        const name = clip(m.name, 80);
        if (!name) continue;
        const slots = (Array.isArray(m.slots) ? m.slots : []).filter((s): s is Slot => SLOTS.includes(s as Slot));
        const food = FOODS.includes(m.food as Food) ? (m.food as Food) : null;
        const days = typeof m.durationDays === "number" && m.durationDays > 0 && m.durationDays <= 3650 ? Math.round(m.durationDays) : null;
        medicines.push({
            name, strength: clip(m.strength, 40), dose: clip(m.dose, 40), frequency: clip(m.frequency, 60),
            slots: [...new Set(slots)], times: timesFor(slots, food), food, durationDays: days, instructions: clip(m.instructions, 160),
        });
    }
    const kind = KINDS.includes(o.kind as RecordKind) ? (o.kind as RecordKind) : values.length ? "lab" : medicines.length ? "prescription" : "other";
    const nv = o.nextVisit && typeof o.nextVisit === "object" ? (o.nextVisit as Record<string, unknown>) : null;
    const nextText = nv ? clip(nv.text, 120) : null;
    const unreadOk = ["patient name", "date", "doctor or lab", "values", "medicines", "the page"];
    return {
        patientName: clip(o.patientName, 80), patientAge: clip(o.patientAge, 20), patientSex: clip(o.patientSex, 12),
        recordDate: isoDate(o.recordDate), recordDateText: clip(o.recordDateText, 40),
        provider: clip(o.provider, 80), doctor: clip(o.doctor, 80), kind,
        title: clip(o.title, 80) || defaultTitle(kind),
        tests: clip(o.tests, 80),
        values: values.slice(0, 120), medicines: medicines.slice(0, 25),
        nextVisit: nextText ? { text: nextText, date: nv ? isoDate(nv.date) : null } : null,
        followUps: (Array.isArray(o.followUps) ? o.followUps : []).map((f) => clip(f, 120)).filter((f): f is string => Boolean(f)).slice(0, 6),
        summary: clip(o.summary, 400) || "",
        unread: (Array.isArray(o.unread) ? o.unread : []).map((u) => clip(u, 20)).filter((u): u is string => Boolean(u && unreadOk.includes(u))),
    };
}

export function defaultTitle(kind: RecordKind): string {
    return { lab: "Lab report", prescription: "Prescription", discharge: "Discharge summary", scan: "Scan report", other: "Health record" }[kind];
}

export function emptyReading(): Reading {
    return { patientName: null, patientAge: null, patientSex: null, recordDate: null, recordDateText: null, provider: null, doctor: null,
             kind: "other", title: "Health record", tests: null, values: [], medicines: [], nextVisit: null, followUps: [], summary: "", unread: ["the page"] };
}

function statusOf(r: Reading): ReadResult["status"] {
    const useful = r.values.length || r.medicines.length || r.patientName || r.provider || r.doctor || (r.summary && r.recordDate);
    if (!useful) return "failed";
    return r.unread.length ? "partial" : "ready";
}

/** Read a file (photo / PDF) or text. Never throws; a failed read says why in `error` (also logged). */
export async function readHealthRecord(input: { buffer?: Buffer; mimeType?: string; text?: string; fileName?: string }): Promise<ReadResult> {
    const started = Date.now();
    const mime = (input.mimeType || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
    const asFile = Boolean(input.buffer?.length && (mime.startsWith("image/") || mime === "application/pdf"));
    const text = (input.text || "").trim();
    if (!asFile && !text) return { status: "failed", reading: emptyReading(), error: "nothing to read", model: "", ms: 0 };
    if (asFile && input.buffer!.length > 18 * 1024 * 1024) {
        return { status: "failed", reading: emptyReading(), error: "file too large to read (18 MB)", model: "", ms: 0 };
    }
    resetVertexError();
    const prompt = asFile
        ? `Read this ${mime === "application/pdf" ? "PDF" : "photo"}${input.fileName ? ` (${input.fileName})` : ""} and return the JSON.`
        : `Read this health record text and return the JSON.\n\n<<<\n${text.slice(0, 60_000)}\n>>>`;
    // Plain JSON mode with the shape spelled out, not Vertex's responseSchema: with the schema every read hung until the
    // 75 s timeout or came back HTTP 500 (live 2026-10-09: Maa's clear prescription photo got "couldn't read"); without it
    // the same model reads it in ~8 s. One more try if the first answer is missing or not JSON.
    let raw = "";
    let reading: Reading | null = null;
    for (const timeoutMs of [50_000, 50_000]) {
        raw = (await vertexGenerateText({
            model: GEMINI_PRO_MODEL,
            system: `${SYSTEM}\n\nReturn one JSON object with exactly these keys:\n${SHAPE}`,
            prompt,
            json: true,
            temperature: 0,
            maxOutputTokens: 16_384,
            thinkingLevel: "low",
            timeoutMs,
            ...(asFile ? { inlineData: { mimeType: mime, data: input.buffer!.toString("base64") } } : {}),
        })) ?? "";
        reading = readingFromModel(parseJsonLoose(raw));
        if (reading) break;
        console.warn(`health record read attempt failed (${Date.now() - started} ms): ${lastVertexError || "bad JSON"}`);
    }
    const ms = Date.now() - started;
    if (!reading) {
        const error = raw ? `unreadable answer (${lastVertexError || "bad JSON"})` : lastVertexError || "no answer";
        console.warn(`health record read failed (${ms} ms): ${error}`);
        return { status: "failed", reading: emptyReading(), error, model: GEMINI_PRO_MODEL, ms };
    }
    const status = statusOf(reading);
    if (status === "failed") console.warn(`health record read found nothing usable (${ms} ms)`);
    return { status, reading: status === "failed" ? { ...reading, unread: ["the page"] } : reading, model: GEMINI_PRO_MODEL, ms };
}
