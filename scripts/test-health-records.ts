/** Health records: reading → review → decision helpers (whose record, flags, dates, what Saheli remembers, cards). */
import { readingFromModel, timesFor, type Reading } from "../src/services/healthRecordReader.service";
import { buttonsFor, factLines } from "../src/services/whatsappHealthRecord.service";
import { applyCorrections, cleanEdited, computeFlag, deviation, effectiveRange, dateLabel, isoOf, medicineWord, memoryPoints, nameTokens, namesMatch, nextVisitDate, testKey, endsOn, type DraftReading } from "../src/services/healthRecordReview.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

// Whose record is it
ok("titles and initials dropped", nameTokens("MRS. B.N.VASUNDARA DEVI").join() === "vasundara,devi", nameTokens("MRS. B.N.VASUNDARA DEVI"));
ok("report name matches the person", namesMatch("MRS. B.N.VASUNDARA DEVI", ["Vasundara Devi"]));
ok("one typo still matches (Vasundhara)", namesMatch("Smt. Vasundhara Devi", ["Vasundara"]));
ok("someone else does not match", !namesMatch("Mr. Ramesh K. Gupta", ["Vasundara Devi", "Maa"]));
ok("short shared words do not match (Dr / Md)", !namesMatch("Dr. M.D. Rao", ["Md Ali"]));

// Flags from printed ranges
ok("below range → low", computeFlag("9.6", "12-15", null) === "low");
ok("above range with en dash → high", computeFlag("1.41", "0.5–1.1", null) === "high");
ok("< limit → high when above", computeFlag("7.1", "< 5.7", null) === "high" && computeFlag("31", "<35", null) === "normal");
ok("> limit → low when below", computeFlag("39", ">40", null) === "low");
ok("upto", computeFlag("40", "upto 35", null) === "high");
ok("BP against 130/80", computeFlag("142/88", "<130/80", null) === "high" && computeFlag("120/76", "<130/80", null) === "normal");
ok("no range keeps the reader's flag", computeFlag("142/88", null, "high") === "high" && computeFlag("5", "", null) === null);

// Ranges printed in bands (live 2026-10-09: calcium 9.2 flagged low because "18–60" was read as the range)
const calcium = "18–60 years: 8.6–10; 60–90 years: 8.8–10";
ok("age picks the band", effectiveRange(calcium, 63) === "8.8–10" && effectiveRange(calcium, 40) === "8.6–10");
ok("no age → first band", effectiveRange(calcium, null) === "8.6–10");
ok("calcium 9.2 is normal for 63", computeFlag("9.2", calcium, null, 63) === "normal" && computeFlag("8.7", calcium, null, 63) === "low");
ok("category bands → the normal one", effectiveRange("Non-Diabetic: < 100; Prediabetes: 100-125; Diabetic: >= 126", null) === "< 100" && computeFlag("102", "Non-Diabetic: < 100; Prediabetes: 100-125", null) === "high");
ok("label without bands", effectiveRange("Adults: 0.27-4.2", null) === "0.27-4.2" && computeFlag("6.12", "Adults: 0.27-4.2", null) === "high");
ok("plain range untouched", effectiveRange("12-15", 63) === "12-15");

// How far outside normal (ranks the cards)
ok("Hb 9.8 vs 12–15 is further out than RDW 14.5 vs 11.5–14", deviation("9.8", "12-15", "low") > deviation("14.5", "11.5-14", "high"));
ok("upper limit form", Math.abs(deviation("7.1", "<5.7", "high") - 1.4 / 5.7) < 1e-9 && deviation("5", null, "high") === 0);

// Dates
ok("ISO stays", isoOf("2026-04-22") === "2026-04-22");
ok("'22 Apr 2026'", isoOf("22 Apr 2026") === "2026-04-22");
ok("'11 Sept 2025'", isoOf("Lab · 11 Sept 2025 · Kidney") === "2025-09-11", isoOf("Lab · 11 Sept 2025 · Kidney"));
ok("Indian numeric order 08/10/2026 → 8 Oct", isoOf("08/10/2026") === "2026-10-08");
ok("label", dateLabel("2026-10-05") === "5 Oct 2026", dateLabel("2026-10-05"));

// Test names trend together
ok("S. Creatinine = Creatinine (serum)", testKey("S. Creatinine").key === testKey("Creatinine (Serum)").key);
ok("Hb = Haemoglobin = Hemoglobin", testKey("Hb").key === "haemoglobin" && testKey("Hemoglobin").key === "haemoglobin");
ok("TLC = WBC count", testKey("TLC").key === "wbc" && testKey("Total Leucocyte Count").key === "wbc");
ok("unknown test keeps its own name", testKey("Ferritin").key === "ferritin" && testKey("Ferritin").label === "Ferritin");

// Medicines
ok("brand word", medicineWord("Tab Shelcal 500") === "shelcal" && medicineWord("Cap. Becosules") === "becosules");
ok("before breakfast is earlier", timesFor(["morning"], "before_food").join() === "07:30" && timesFor(["morning", "night"], null).join() === "08:00,21:00");
ok("course end", endsOn("2026-10-08", 30) === "2026-11-07" && endsOn("2026-10-08", null) === null);

// Reader output is cleaned (values need a digit; unknown words dropped)
const r = readingFromModel({ kind: "lab", title: "Blood count", values: [{ name: "Hb", value: "9.6", unit: "g/dL", range: "12-15" }, { name: "Remarks", value: "see doctor" }],
    medicines: [], summary: "", unread: ["date", "made up"], patientName: "N/A" })!;
ok("value without a digit dropped", r.values.length === 1 && r.values[0].name === "Hb");
ok("N/A name is empty; unknown unread words dropped", r.patientName === null && r.unread.join() === "date", r);

// What Saheli would remember
const lab: Reading = { ...r, recordDate: "2026-10-05", title: "Blood count", values: [
    { name: "Haemoglobin", value: "9.6", unit: "g/dL", range: "12-15", flag: null },
    { name: "Platelets", value: "1.72", unit: "lakh/µL", range: "1.5-4.1", flag: null }] };
const pts = memoryPoints(lab, new Map([["haemoglobin", { value: 9.8, date: "2026-04-22" }]]));
ok("only values outside normal, with a comparison", pts.length === 1 && pts[0] === "Haemoglobin 9.6 g/dL (low) on 5 Oct 2026, lower than on 22 Apr 2026", pts);
const allNormal = memoryPoints({ ...lab, values: [lab.values[1]] });
ok("all normal → one line", allNormal.length === 1 && /all 1 values in the normal range/.test(allNormal[0]), allNormal);
const rx: Reading = { ...lab, kind: "prescription", values: [], doctor: "Dr. R. Mehta", recordDate: "2026-10-08", followUps: ["CBC", "KFT"],
    medicines: [{ name: "Pantocid", strength: "40 mg", dose: null, frequency: "1-0-0", slots: ["morning"], times: ["07:30"], food: "before_food", durationDays: 30, instructions: null }] };
ok("prescription → one line with the doctor and follow-ups", memoryPoints(rx)[0] === "Dr. R. Mehta, 8 Oct 2026: Pantocid 40 mg; before the next visit: CBC, KFT", memoryPoints(rx));

// Next visit
ok("'Review after 1 month' from the record date", nextVisitDate({ ...rx, nextVisit: { text: "Review after 1 month", date: null } }) === "2026-11-07");
ok("printed date wins", nextVisitDate({ ...rx, nextVisit: { text: "Review on 1 Dec", date: "2026-12-01" } }) === "2026-12-01");
ok("no visit → none", nextVisitDate({ ...rx, nextVisit: null }) === null);

// Edits before saving are cleaned like a fresh read
const draft: DraftReading = { ...rx, memoryPoints: ["a"], medicines: rx.medicines.map((m) => ({ ...m, alreadyOnSchedule: false, add: true })) };
const edited = cleanEdited({ medicines: [{ ...draft.medicines[0], times: ["7:30", "21:00", "25:99"], add: false }], memoryPoints: ["  keep   this ", ""], values: [{ name: "X", value: "no digit" }] }, draft);
ok("bad times dropped, add flag kept from the person", edited.medicines[0].times.join() === "21:00" && edited.medicines[0].add === false, edited.medicines[0]);
ok("memory points trimmed, blanks dropped", edited.memoryPoints.join("|") === "keep this", edited.memoryPoints);
ok("an edited value without a digit is dropped", edited.values.length === 0);

// Corrections said in chat
const withLab: DraftReading = { ...draft, values: [{ name: "Haemoglobin", value: "9.6", unit: "g/dL", range: "12-15", flag: "low" }] };
const fx = applyCorrections(withLab, [{ name: "Pantocid", value: "20 mg", times: ["08:00"] }, { name: "Hb", value: "12.4" }, { name: "Dolo", value: "650" }]);
ok("medicine corrected by brand word", fx.reading.medicines[0].strength === "20 mg" && fx.reading.medicines[0].times.join() === "08:00", fx.reading.medicines[0]);
ok("value corrected by test name; flag recomputed", fx.reading.values[0].value === "12.4" && fx.reading.values[0].flag === "normal", fx.reading.values[0]);
ok("unknown name reported, not invented", fx.unmatched.join() === "Dolo" && fx.matched.length === 2, fx);
ok("remove drops the line", applyCorrections(withLab, [{ name: "Haemoglobin", remove: true }]).reading.values.length === 0);

// WhatsApp: what Saheli says and which buttons she offers
const rxDraft: DraftReading = { ...draft, medicines: [
    { ...draft.medicines[0] },
    { name: "Shelcal", strength: "500", dose: null, frequency: "0-1-0", slots: ["afternoon"], times: ["13:00"], food: "after_food", durationDays: 60, instructions: null, alreadyOnSchedule: true, add: false }] };
const hiLines = factLines(rxDraft, "hi");
ok("Hindi lines: doctor/date, timing words, days, already on schedule", hiLines[0] === "*Dr. R. Mehta, 2026-10-08*" && /पैंटो|Pantocid 40 mg, सुबह, खाने से पहले, 30 दिन/.test(hiLines[1]) && /पहले से चल रही है/.test(hiLines[2]), hiLines);
const labLines = factLines({ ...withLab, medicines: [], values: [...withLab.values, { name: "Urea", value: "30", unit: "mg/dL", range: "15-40", flag: "normal" }] }, "en");
ok("lab lines: only values outside normal, then 'everything else is normal'", labLines.includes("• Haemoglobin 9.6 g/dL (low)") && labLines.at(-1) === "Everything else is normal.", labLines);
const ids = (b: Array<{ id: string }>) => b.map((x) => x.id.split(":")[1]).join();
ok("prescription with new medicines → add to reminders / just keep / wrong", ids(buttonsFor(rxDraft, { status: "match" }, false, "d1", "hi", true)) === "meds,keep,wrong");
ok("all medicines already on schedule → save / file / wrong", ids(buttonsFor({ ...rxDraft, medicines: [rxDraft.medicines[1]] }, { status: "match" }, false, "d1", "en", true)) === "save,file,wrong");
ok("someone else's name → other / mine / delete", ids(buttonsFor(rxDraft, { status: "mismatch", nameOnReport: "Ramesh" }, false, "d1", "hi", true)) === "other,mine,del");
ok("confirmed mismatch asks the normal question", ids(buttonsFor(rxDraft, { status: "mismatch", confirmedBy: "u1" }, false, "d1", "hi", true)) === "meds,keep,wrong");
ok("unreadable → read again / file / delete", ids(buttonsFor(null, undefined, true, "d1", "en", true)) === "again,file,del");
ok("button titles fit WhatsApp's 20 characters", [...buttonsFor(rxDraft, { status: "match" }, false, "d1", "hi", true), ...buttonsFor(rxDraft, { status: "mismatch" }, false, "d1", "en", false), ...buttonsFor(null, undefined, true, "d1", "hi", true)].every((b) => b.title.length <= 20));

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
