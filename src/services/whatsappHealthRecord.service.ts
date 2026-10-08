/**
 * Health records sent to Saheli on WhatsApp (a photo or a PDF of a prescription, lab report, discharge summary):
 * she reads it, says what she read in the person's language and script, and asks before anything is saved. The
 * record waits as "needs review" (also on the dashboard, where it can be finished or corrected). Buttons:
 * prescription → add to reminders / just keep the record / something's wrong; lab → save / keep file only / wrong;
 * someone else's name → someone else's / it's mine / delete; unreadable → read again / keep file / delete.
 */
import { contentHash } from "./medicalRecordExtract.service";
import type { DraftReading, PersonCheck } from "./healthRecordReview.service";

export type RecordReply = { text: string; buttons?: Array<{ id: string; title: string }> };
type Sender = { familyId: string; userId: string; role: string };
type Lang = "hi" | "en";

const B: Record<Lang, Record<string, string>> = {
    hi: { meds: "रिमाइंडर में जोड़ो", keep: "सिर्फ़ रिकॉर्ड रखो", wrong: "कुछ गलत है", save: "रिकॉर्ड में रखो", file: "सिर्फ़ फ़ाइल रखो",
          other: "किसी और की है", mine: "मेरी ही है", theirs: "इन्हीं की है", del: "हटा दो", again: "फिर से पढ़ो" },
    en: { meds: "Add to reminders", keep: "Just keep record", wrong: "Something's wrong", save: "Save to record", file: "Keep file only",
          other: "Someone else's", mine: "It's mine", theirs: "It is theirs", del: "Delete it", again: "Read again" },
};

const T: Record<Lang, Record<string, string>> = {
    hi: {
        reading: "मिल गया 🙏 पढ़ रही हूँ, एक मिनट।", notSaved: "अभी कुछ भी सेव नहीं किया है। क्या करूँ?", already: "यह रिपोर्ट पहले से रिकॉर्ड में है 🙏",
        cantRead: "माफ़ कीजिए, मैं यह पढ़ नहीं पाई। फ़ाइल रख ली है, कुछ सेव नहीं किया। साफ़ रोशनी में दोबारा फ़ोटो भेज सकते हैं।",
        otherName: "इस रिपोर्ट पर नाम *{name}* लिखा है, {whose} नहीं। मैंने इसे सेव नहीं किया है। यह किसकी है?",
        savedMeds: "ठीक है ✅ कल से याद दिलाऊँगी:\n{lines}\nरिपोर्ट भी रिकॉर्ड में रख दी।", saved: "ठीक है ✅ रिकॉर्ड में रख दी।",
        fileOnly: "ठीक है, सिर्फ़ फ़ाइल रख ली है। इससे कुछ याद नहीं रखा।", deleted: "हटा दी। उस रिपोर्ट से कुछ भी याद नहीं रखा है 🙏",
        fix: "बताइए क्या ठीक करूँ (जैसे \"शेलकैल 500 है\")। या ऐप में देखकर बदल सकते हैं: {link}",
        pickPerson: "यह किसकी रिपोर्ट है?", moved: "ठीक है, यह {name} के रिकॉर्ड में डाल दी है (अभी सेव नहीं की)। ऐप में देखकर सेव कर सकते हैं: {link}",
        noOther: "परिवार में और किसी का रिकॉर्ड नहीं है। इसे हटा दूँ?", gone: "यह रिपोर्ट अब नहीं मिली।", done: "इस पर पहले ही फ़ैसला हो चुका है 🙏",
        low: "कम", high: "ज़्यादा", normal: "बाकी सब सामान्य हैं।", days: "दिन", morning: "सुबह", afternoon: "दोपहर", evening: "शाम", night: "रात",
        before_food: "खाने से पहले", after_food: "खाने के बाद", with_food: "खाने के साथ", empty_stomach: "खाली पेट", onSchedule: "पहले से चल रही है",
        rx: "मैंने पर्चा पढ़ लिया 🙏", lab: "मैंने रिपोर्ट पढ़ ली 🙏", doc: "मैंने कागज़ पढ़ लिया 🙏", her: "आपका",
    },
    en: {
        reading: "Got it 🙏 Reading it now, one minute.", notSaved: "Nothing is saved yet. What should I do?", already: "This report is already in the records 🙏",
        cantRead: "Sorry, I couldn't read this one. I kept the file but saved nothing from it. A clearer photo in good light would help.",
        otherName: "The name on this report is *{name}*, not {whose}. I haven't saved it. Whose is it?",
        savedMeds: "Done ✅ I'll remind from tomorrow:\n{lines}\nThe report is in the records too.", saved: "Done ✅ Saved to the records.",
        fileOnly: "Okay, I kept only the file. Nothing from it is remembered.", deleted: "Deleted. I haven't kept anything from that report 🙏",
        fix: "Tell me what to fix (for example \"Shelcal is 500\"), or change it in the app: {link}",
        pickPerson: "Whose report is this?", moved: "Okay, I've put it in {name}'s records (not saved yet). You can check and save it in the app: {link}",
        noOther: "There's no one else's record in the family. Shall I delete it?", gone: "I can't find that report any more.", done: "That one is already decided 🙏",
        low: "low", high: "high", normal: "Everything else is normal.", days: "days", morning: "morning", afternoon: "afternoon", evening: "evening", night: "night",
        before_food: "before food", after_food: "after food", with_food: "with food", empty_stomach: "empty stomach", onSchedule: "already on the schedule",
        rx: "I've read the prescription 🙏", lab: "I've read the report 🙏", doc: "I've read it 🙏", her: "yours",
    },
};

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

async function langOf(userId: string): Promise<{ lang: Lang; label: string; script: string }> {
    const { getSpeechProfile } = await import("./voicePreference.service");
    const { replyScript, speechLabel } = await import("./language.service");
    const p = await getSpeechProfile(userId).catch(() => ({}));
    const script = replyScript(p);
    return { lang: script === "devanagari" ? "hi" : "en", label: speechLabel(p), script };
}

async function nameOf(userId: string): Promise<string> {
    const { default: User } = await import("../models/users.model");
    const u = await User.findOne({ userId }, { firstName: 1, lastName: 1 }).lean<{ firstName?: string; lastName?: string }>();
    return [u?.firstName, u?.lastName].filter(Boolean).join(" ") || "them";
}

function reviewLink(familyId: string, recipientUserId: string, documentId: string): string {
    const base = (process.env.DASHBOARD_URL || "https://app.kavach.care").replace(/\/+$/, "");
    return `${base}/dashboard/record/review/${encodeURIComponent(documentId)}?recipient=${encodeURIComponent(recipientUserId)}`;
}

/** Plain lines of what was read (also the facts the friendly message may use). */
export function factLines(r: DraftReading, lang: Lang): string[] {
    const t = T[lang];
    const when = r.recordDateText || r.recordDate || "";
    const head = [r.doctor || r.provider, when].filter(Boolean).join(", ");
    const lines: string[] = [];
    if (head) lines.push(`*${head}*`);
    if (r.medicines.length) {
        for (const m of r.medicines.slice(0, 8)) {
            const when = m.slots.map((s) => t[s]).join(" + ");
            const bits = [[m.name, m.strength].filter(Boolean).join(" "), when, m.food ? t[m.food] : "", m.durationDays ? `${m.durationDays} ${t.days}` : ""].filter(Boolean);
            lines.push(`• ${bits.join(", ")}${m.alreadyOnSchedule ? ` (${t.onSchedule})` : ""}`);
        }
    } else if (r.values.length) {
        const odd = r.values.filter((v) => v.flag === "low" || v.flag === "high");
        for (const v of odd.slice(0, 6)) lines.push(`• ${v.name} ${v.value}${v.unit ? ` ${v.unit}` : ""} (${t[v.flag as "low" | "high"]})`);
        if (odd.length < r.values.length) lines.push(t.normal);
    } else if (r.summary) {
        lines.push(r.summary);
    }
    return lines;
}

export function buttonsFor(r: DraftReading | null, pc: PersonCheck | undefined, failed: boolean, docId: string, lang: Lang, isSelf: boolean) {
    const b = B[lang];
    const id = (a: string) => `rec:${a}:${docId}`;
    if (failed) return [{ id: id("again"), title: b.again }, { id: id("file"), title: b.file }, { id: id("del"), title: b.del }];
    if (pc?.status === "mismatch" && !pc.confirmedBy) return [{ id: id("other"), title: b.other }, { id: id("mine"), title: isSelf ? b.mine : b.theirs }, { id: id("del"), title: b.del }];
    const toAdd = (r?.medicines ?? []).filter((m) => m.add && m.times.length && !m.alreadyOnSchedule);
    if (toAdd.length) return [{ id: id("meds"), title: b.meds }, { id: id("keep"), title: b.keep }, { id: id("wrong"), title: b.wrong }];
    return [{ id: id("save"), title: b.save }, { id: id("file"), title: b.file }, { id: id("wrong"), title: b.wrong }];
}

/** A short message in the person's own language and script, using only the facts read (falls back to a template). */
async function friendlyText(facts: string[], intro: string, ask: string, who: { label: string; lang: Lang }): Promise<string> {
    const template = [intro, ...facts, "", ask].join("\n");
    if (who.lang === "en" && /English/.test(who.label)) return template;
    try {
        const { vertexGenerateText, GEMINI_PRO_MODEL } = await import("../clients/vertexGemini.client");
        const raw = await vertexGenerateText({
            model: GEMINI_PRO_MODEL,
            system: "You are Saheli, a warm WhatsApp companion for an Indian family. Rewrite the given message in the person's language and dialect, in that language's own script (never Roman letters unless asked). Keep every medicine name, number, unit and date exactly as given (Latin digits). Keep it short, keep the bullet lines, add nothing that is not in the facts, no advice. Return only the message.",
            prompt: `Person writes in: ${who.label}.\n\nMessage:\n${template}`,
            temperature: 0.2, maxOutputTokens: 2048, thinkingLevel: "low", timeoutMs: 15_000,
        });
        const out = (raw || "").trim();
        const nums = (s: string) => new Set(s.match(/\d+(?:\.\d+)?/g) ?? []);
        const allowed = nums(template);
        if (out && out.length < 1500 && [...nums(out)].every((n) => allowed.has(n))) return out;
    } catch {
        /* fall back to the template */
    }
    return template;
}

/** Who the record is for: the sender if they are cared for; for a caregiver, the person whose name is on it (or the only one). */
async function subjectFor(sender: Sender, nameOnReport: string | null): Promise<string | { ask: Array<{ userId: string; name: string }> }> {
    const { FamilyRole } = await import("../types/family.types");
    if (sender.role === FamilyRole.CARE_RECIPIENT) return sender.userId;
    const { getFamilyMembersList } = await import("./familyMember.service");
    const payload = await getFamilyMembersList(sender.familyId, sender.userId);
    const people = payload.members
        .filter((m) => m.userId && m.status === "JOINED" && (m.role === FamilyRole.CARE_RECIPIENT || m.userId === sender.userId))
        .map((m) => ({ userId: m.userId as string, name: m.name?.trim() || "Family member", role: m.role }));
    const { namesMatch } = await import("./healthRecordReview.service");
    if (nameOnReport) {
        const hit = people.filter((p) => namesMatch(nameOnReport, [p.name]));
        if (hit.length === 1) return hit[0].userId;
    }
    const recipients = people.filter((p) => p.role === FamilyRole.CARE_RECIPIENT);
    if (recipients.length === 1) return recipients[0].userId;
    if (!recipients.length) return sender.userId; // their own record (self-care)
    return { ask: people.slice(0, 3) };
}

/** Is this photo a health record (not a meal, a selfie, a medicine strip on its own)? */
async function looksLikeRecord(buffer: Buffer, mimeType: string, caption: string): Promise<boolean> {
    if (/\b(report|prescription|parcha|पर्चा|रिपोर्ट|discharge|lab|test|scan|x-?ray|mri|ct)\b/i.test(caption)) return true;
    if (buffer.length > 18 * 1024 * 1024) return false; // too large to look at; the usual media flow handles it
    const { vertexGenerateText, GEMINI_PRO_MODEL, parseJsonLoose } = await import("../clients/vertexGemini.client");
    const raw = await vertexGenerateText({
        model: GEMINI_PRO_MODEL,
        prompt: 'Is this a medical document with printed or handwritten text: a prescription, a lab or test report, a discharge summary, a scan report, a doctor\'s note? A meal, a person, a medicine strip or bottle alone, a bill, a ticket or any other paper is NOT. Answer JSON {"record": true|false}.',
        json: true, temperature: 0, maxOutputTokens: 1024, thinkingLevel: "low", timeoutMs: 12_000,
        inlineData: { mimeType: mimeType.replace("image/jpg", "image/jpeg"), data: buffer.toString("base64") },
    });
    return Boolean(parseJsonLoose<{ record?: boolean }>(raw)?.record);
}

/** A photo or PDF arrived. Returns the reply, or null when it is not a health record (the usual media flow continues). */
export async function handleRecordMedia(input: { sender: Sender; mediaId: string; mediaType: string; caption?: string }): Promise<RecordReply | null> {
    const { downloadMedia } = await import("../clients/metaWhatsApp.client");
    const media = await downloadMedia(input.mediaId);
    const mime = (media.mimeType || "").split(";")[0].trim().toLowerCase();
    const isImage = mime.startsWith("image/");
    const isPdf = mime === "application/pdf";
    if (!isImage && !isPdf) return null;
    // A meal photo, a selfie, a train ticket PDF: not a health record → the usual media flow.
    if (!(await looksLikeRecord(media.buffer, mime, input.caption || ""))) return null;

    const who = await langOf(input.sender.userId);
    // Reading takes up to ~40 s, longer than the WhatsApp reply limit: answer now, send what was read when it is ready.
    void finishRecord(input.sender, media.buffer, mime, isPdf).catch((err) =>
        console.warn("[records] reading a WhatsApp record failed:", err instanceof Error ? err.message : err),
    );
    return { text: T[who.lang].reading };
}

async function send(sender: Sender, recipientUserId: string, reply: RecordReply) {
    const { sendSaheliWhatsApp } = await import("./careMemorySync.service");
    await sendSaheliWhatsApp({ familyId: sender.familyId, recipientUserId, toUserId: sender.userId, text: reply.text, buttons: reply.buttons });
}

async function finishRecord(sender: Sender, buffer: Buffer, mime: string, isPdf: boolean): Promise<void> {
    const who = await langOf(sender.userId);
    const t = T[who.lang];
    const { readHealthRecord } = await import("./healthRecordReader.service");
    const read = await readHealthRecord({ buffer, mimeType: mime, fileName: isPdf ? "report.pdf" : "photo.jpg" });
    const subject = await subjectFor(sender, read.reading.patientName);
    const subjectId = typeof subject === "string" ? subject : sender.userId;

    const { buildFamilyObjectKey, uploadFamilyFile, isR2Configured } = await import("./r2Storage.service");
    if (!isR2Configured()) return send(sender, subjectId, { text: t.cantRead });
    const hash = contentHash(buffer);
    const LabDocument = (await import("../models/labDocument.model")).default;
    const existing = await LabDocument.findOne({ familyId: sender.familyId, recipientUserId: subjectId, contentHash: hash }).lean();
    if (existing) return send(sender, subjectId, { text: t.already });
    const fileName = `whatsapp-${new Date().toISOString().slice(0, 10)}.${isPdf ? "pdf" : mime.split("/")[1] || "jpg"}`;
    const storageKey = buildFamilyObjectKey(sender.familyId, fileName);
    const fileUrl = await uploadFamilyFile(storageKey, buffer, mime);
    const { buildDraft, draftFields } = await import("./healthRecordReview.service");
    const draft = await buildDraft(sender.familyId, subjectId, read);
    const { randomUUID } = await import("crypto");
    const doc = await LabDocument.create({
        documentId: randomUUID(), familyId: sender.familyId, recipientUserId: subjectId, rawText: "", createdBy: sender.userId,
        source: "file", via: "whatsapp", storageKey, fileUrl, fileName, mimeType: mime, fileSize: buffer.length, contentHash: hash,
        ...draftFields(read, draft, isPdf ? "Report (WhatsApp)" : "Photo (WhatsApp)"),
    });
    await send(sender, subjectId, await recordMessage(doc.documentId, sender, subject));
}

/** The message for a record waiting for review (also re-sent after "it's mine" or "read again"). */
export async function recordMessage(documentId: string, sender: Sender, subject?: string | { ask: Array<{ userId: string; name: string }> }): Promise<RecordReply> {
    const LabDocument = (await import("../models/labDocument.model")).default;
    const doc = await LabDocument.findOne({ familyId: sender.familyId, documentId }).lean();
    const who = await langOf(sender.userId);
    const t = T[who.lang];
    if (!doc) return { text: t.gone };
    const isSelf = doc.recipientUserId === sender.userId;
    const failed = doc.extractionStatus === "failed";
    const reading = (doc.reading as unknown as DraftReading | undefined) ?? null;
    const pc = doc.personCheck as PersonCheck | undefined;
    if (subject && typeof subject !== "string") {
        return { text: t.pickPerson, buttons: subject.ask.map((p) => ({ id: `rec:to:${documentId}:${p.userId}`, title: p.name.split(/\s+/)[0].slice(0, 20) })) };
    }
    if (failed) return { text: t.cantRead, buttons: buttonsFor(null, pc, true, documentId, who.lang, isSelf) };
    if (pc?.status === "mismatch" && !pc.confirmedBy) {
        const whose = isSelf ? t.her : await nameOf(doc.recipientUserId);
        return { text: fill(t.otherName, { name: pc.nameOnReport || "?", whose }), buttons: buttonsFor(reading, pc, false, documentId, who.lang, isSelf) };
    }
    const r = reading!;
    const intro = r.kind === "prescription" ? t.rx : r.kind === "lab" ? t.lab : t.doc;
    const facts = factLines(r, who.lang);
    const text = await friendlyText(facts, intro, t.notSaved, who);
    void notifyEngine(doc.familyId, doc.recipientUserId, documentId, r, facts);
    return { text, buttons: buttonsFor(r, pc, false, documentId, who.lang, isSelf) };
}

/** Saheli's brain sees the question in today's events, so a typed answer ("haan, jod do") can be acted on too. */
async function notifyEngine(familyId: string, subjectId: string, documentId: string, r: DraftReading, facts: string[]) {
    const { aiPushCareEvent } = await import("../clients/aiEngine.client");
    await aiPushCareEvent({
        family_id: familyId, subject_id: subjectId, kind: "record_review",
        summary: `Saheli read a ${r.kind} sent on WhatsApp (${facts.join(" ").replace(/\*/g, "").slice(0, 300)}) and asked what to do; nothing is saved yet. health_record id ${documentId}.`,
        payload: { document_id: documentId }, ref: `record_review:${documentId}`,
    }).catch(() => null);
}

/** A tapped button: rec:<action>:<documentId>[:<userId>]. */
export async function handleRecordButton(input: { sender: Sender; interactiveId: string }): Promise<RecordReply> {
    const [, action, documentId, extra] = input.interactiveId.split(":");
    const who = await langOf(input.sender.userId);
    const t = T[who.lang];
    const LabDocument = (await import("../models/labDocument.model")).default;
    const doc = await LabDocument.findOne({ familyId: input.sender.familyId, documentId }).lean();
    if (!doc) return { text: t.gone };
    if (doc.reviewStatus !== "needs_review" && action !== "del") return { text: t.done };
    const subj = doc.recipientUserId;
    const actor = { id: input.sender.userId, name: await nameOf(input.sender.userId) };
    const R = await import("./healthRecordReview.service");
    switch (action) {
        case "meds":
        case "keep":
        case "save": {
            try {
                const res = await R.applyDecision(doc.familyId, subj, documentId, actor, { action: "save", remember: true, addMedicines: action === "meds" });
                if (action === "meds" && res.scheduled.length) {
                    const reading = (doc.reading as unknown as DraftReading | undefined);
                    const lines = (reading?.medicines ?? []).filter((m) => res.scheduled.includes(m.name)).map((m) => `• ${m.name} — ${m.times.join(", ")}`).join("\n");
                    return { text: fill(t.savedMeds, { lines }) };
                }
                return { text: t.saved };
            } catch (err) {
                if ((err as { code?: string }).code === "person_mismatch") return recordMessage(documentId, input.sender);
                throw err;
            }
        }
        case "file":
            await R.applyDecision(doc.familyId, subj, documentId, actor, { action: "file_only" });
            return { text: t.fileOnly };
        case "del":
            await R.applyDecision(doc.familyId, subj, documentId, actor, { action: "discard" });
            return { text: t.deleted };
        case "wrong":
            return { text: fill(t.fix, { link: reviewLink(doc.familyId, subj, documentId) }) };
        case "mine":
            await R.resolvePerson(doc.familyId, subj, documentId, input.sender.userId, { action: "theirs" });
            return recordMessage(documentId, input.sender);
        case "other": {
            const pc = doc.personCheck as PersonCheck | undefined;
            if (pc?.suggestedUserId) {
                const moved = await R.resolvePerson(doc.familyId, subj, documentId, input.sender.userId, { action: "move", toUserId: pc.suggestedUserId }).catch(() => null);
                if (moved) return { text: fill(t.moved, { name: pc.suggestedName || "", link: reviewLink(doc.familyId, pc.suggestedUserId, documentId) }) };
                return { text: t.noOther, buttons: [{ id: `rec:del:${documentId}`, title: B[who.lang].del }] };
            }
            const { getFamilyMembersList } = await import("./familyMember.service");
            const { FamilyRole } = await import("../types/family.types");
            const payload = await getFamilyMembersList(doc.familyId, input.sender.userId);
            const others = payload.members.filter((m) => m.userId && m.userId !== subj && m.status === "JOINED" && (m.role === FamilyRole.CARE_RECIPIENT || m.userId === input.sender.userId));
            if (!others.length) return { text: t.noOther, buttons: [{ id: `rec:del:${documentId}`, title: B[who.lang].del }] };
            return { text: t.pickPerson, buttons: others.slice(0, 3).map((m) => ({ id: `rec:to:${documentId}:${m.userId}`, title: (m.name || "Family").split(/\s+/)[0].slice(0, 20) })) };
        }
        case "to": {
            if (!extra) return { text: t.gone };
            const ok = extra !== subj
                ? await R.resolvePerson(doc.familyId, subj, documentId, input.sender.userId, { action: "move", toUserId: extra }).catch(() => null)
                : await R.resolvePerson(doc.familyId, subj, documentId, input.sender.userId, { action: "theirs" });
            if (!ok) return { text: t.noOther, buttons: [{ id: `rec:del:${documentId}`, title: B[who.lang].del }] };
            return recordMessage(documentId, input.sender);
        }
        case "again": {
            void (async () => {
                const { rereadDocument } = await import("./memoryDocument.service");
                await rereadDocument(doc.familyId, subj, documentId);
                await send(input.sender, subj, await recordMessage(documentId, input.sender));
            })().catch((err) => console.warn("[records] read again failed:", err instanceof Error ? err.message : err));
            return { text: t.reading };
        }
        default:
            return { text: t.gone };
    }
}
