/**
 * New-caregiver onboarding: one question at a time on the dashboard (and the same answers on WhatsApp), then one
 * "set everything up" step that turns the answers into the family: the person cared for (added and, once their
 * WhatsApp is verified, greeted by Saheli in their language), what Saheli calls them, their language and dialect,
 * conditions, allergies, medicines with reminders, their day, doctor, emergency contact, and a note Saheli reads.
 *
 * Everything goes through the same services the dashboard and Saheli use, so the care record, reminders and the
 * engine's memory stay one source of truth.
 */
import { createHash, randomInt } from "crypto";
import { z } from "zod";
import { aiEngineJson } from "../clients/aiEngine.client";
import { parseJsonLoose, vertexFlashModel, vertexGenerateText } from "../clients/vertexGemini.client";
import appConfig from "../config/app.config";
import Family from "../models/family.model";
import { OnboardingDraft, PhoneVerification } from "../models/onboarding.model";
import User from "../models/users.model";
import { FamilyRole } from "../types/family.types";
import { AppError } from "../middleware/error.middleware";
import { dialectInfo, languageInfo, normaliseSpeech, speechLabel, type SpeechProfile } from "./language.service";

/* ── answers ──────────────────────────────────────────────────────────────── */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const phone = z.string().trim().regex(/^\+\d{1,4}\d{6,14}$/, "phone with country code, e.g. +919876543210");
// A cleared time box sends "", and an untouched phone box sends just its country code ("+91"): both mean "not given".
const optTime = z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), hhmm.optional());
const optPhone = z.preprocess((v) => (typeof v === "string" && /^\s*\+?\d{0,4}\s*$/.test(v) ? undefined : v), phone.optional());

/** Country codes the onboarding phone box offers, longest first so +971 is not read as +9 71…. */
const COUNTRY_CODES = ["+971", "+966", "+974", "+977", "+880", "+91", "+94", "+65", "+61", "+60", "+44", "+1"];

/** "+919876543210" → { cc: "+91", number: "9876543210" }; unknown codes fall back to the last 10 digits as the number. */
export function splitPhone(e164: string): { cc: string; number: string } {
    const d = e164.replace(/\D/g, "");
    const cc = COUNTRY_CODES.find((c) => d.startsWith(c.slice(1)) && d.length - (c.length - 1) >= 7);
    if (cc) return { cc, number: d.slice(cc.length - 1) };
    return { cc: `+${d.slice(0, Math.max(1, d.length - 10))}`, number: d.slice(-10) };
}

export const MedicineSchema = z.object({
    name: z.string().trim().min(1).max(80),
    dose: z.string().trim().max(60).optional(),
    times: z.preprocess((v) => (Array.isArray(v) ? v.filter((t) => typeof t === "string" && t.trim()) : v), z.array(hhmm).max(8).default([])),
    food: z.enum(["before_food", "after_food", "with_food", "empty_stomach", "any"]).optional(),
    notes: z.string().trim().max(200).optional(),
});

export const PersonSchema = z.object({
    relation: z.string().trim().max(40),
    name: z.string().trim().min(1).max(80),
    callThem: z.string().trim().max(40).optional(),
    addressAs: z.string().trim().max(60).optional(),
    gender: z.enum(["female", "male", "other"]).optional(),
    age: z.number().int().min(1).max(120).optional(),
    city: z.string().trim().max(80).optional(),
    livesWith: z.enum(["alone", "spouse", "me", "family", "care_home"]).optional(),
    language: z.string().trim().max(40).optional(),
    dialect: z.string().trim().max(40).nullable().optional(),
    reads: z.enum(["text", "voice", "both"]).optional(),
    phone: optPhone,
    conditions:z.array(z.string().trim().max(60)).max(20).default([]),
    conditionsOther: z.string().trim().max(300).optional(),
    sugarCheck: z.enum(["daily", "sometimes", "no"]).optional(),
    bpMachine: z.boolean().optional(),
    problems: z.array(z.string().trim().max(60)).max(20).default([]),
    problemsOther: z.string().trim().max(500).optional(),
    allergies: z.object({ none: z.boolean().optional(), items: z.array(z.string().trim().max(60)).max(20).default([]) }).default({ items: [] }),
    medicines: z.array(MedicineSchema).max(30).default([]),
    noMedicines: z.boolean().optional(),
    day: z.object({
        wake: optTime, breakfast: optTime, lunch: optTime, tea: optTime, dinner: optTime, sleep: optTime,
        activities: z.array(z.string().trim().max(40)).max(20).default([]),
        notes: z.string().trim().max(500).optional(),
    }).default({ activities: [] }),
    doctor: z.object({ name: z.string().trim().max(80).optional(), phone: z.string().trim().max(20).optional(), hospital: z.string().trim().max(120).optional(), nextVisit: z.string().trim().max(30).optional() }).optional(),
    likes: z.array(z.string().trim().max(40)).max(20).default([]),
    likesOther: z.string().trim().max(300).optional(),
    avoidTopics: z.string().trim().max(300).optional(),
});

export const AnswersSchema = z.object({
    you: z.object({ name: z.string().trim().min(1).max(80), callMe: z.string().trim().max(40).optional(), phone: optPhone }),
    careFor: z.enum(["mother", "father", "both_parents", "grandmother", "grandfather", "spouse", "self", "other"]),
    persons: z.array(PersonSchema).min(1).max(2),
    helpWith: z.array(z.string().trim().max(30)).max(10).default([]),
    emergency: z.object({ name: z.string().trim().max(80).optional(), phone: z.string().trim().max(20).optional(), relation: z.string().trim().max(40).optional() }).optional(),
    followups: z.array(z.object({ q: z.string().max(300), a: z.string().max(500) })).max(5).default([]),
    anythingElse: z.string().trim().max(1500).optional(),
});
export type Answers = z.infer<typeof AnswersSchema>;
export type Person = z.infer<typeof PersonSchema>;

/* ── status and drafts ────────────────────────────────────────────────────── */

/** Model calls (prescription photos, follow-up questions) per caregiver per hour, per instance. */
const usage = new Map<string, number[]>();
export function allow(userId: string, kind: string, perHour: number, now = Date.now()): boolean {
    const key = `${kind}:${userId}`;
    const recent = (usage.get(key) || []).filter((t) => now - t < 3_600_000);
    if (recent.length >= perHour) return false;
    recent.push(now);
    usage.set(key, recent);
    if (usage.size > 5000) usage.delete(usage.keys().next().value as string);
    return true;
}

export async function onboardingState(userId: string) {
    const user = await User.findOne({ userId }).lean<{ onboarding?: { status?: string }; activeFamilyId?: string; firstName?: string; lastName?: string; email?: string }>();
    if (!user) throw new AppError("User not found", 404);
    const draft = await OnboardingDraft.findOne({ userId, completedAt: null }).sort({ updatedAt: -1 }).lean<{ answers?: Record<string, unknown>; step?: string }>();
    const verifications = await PhoneVerification.find({ userId, verifiedAt: { $ne: null } }).lean<Array<{ target: string; phone: string; verifiedAt: Date }>>();
    return {
        required: user.onboarding?.status === "pending",
        status: user.onboarding?.status ?? "done",
        name: [user.firstName, user.lastName].filter(Boolean).join(" "),
        draft: draft ? { answers: draft.answers ?? {}, step: draft.step ?? "welcome" } : null,
        verified: Object.fromEntries(verifications.map((v) => [v.target, { phone: v.phone, at: v.verifiedAt }])),
        saheliNumber: appConfig.whatsapp.kavachNumber,
    };
}

async function familyOf(userId: string): Promise<string> {
    const user = await User.findOne({ userId }).lean<{ activeFamilyId?: string; primaryFamilyId?: string }>();
    const familyId = user?.activeFamilyId || user?.primaryFamilyId;
    if (!familyId) throw new AppError("No family yet; sign in again", 409);
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    const me = family?.members.find((m: { userId: string; role: string; status: string }) => m.userId === userId);
    if (!family || !me || me.role !== FamilyRole.PRIMARY_CAREGIVER) throw new AppError("Only the family's primary caregiver can set it up", 403);
    return familyId;
}

/** Saved after every answer; nothing is set up until completeOnboarding. */
export async function saveDraft(userId: string, input: { answers: unknown; step?: unknown }) {
    const familyId = await familyOf(userId);
    const answers = input.answers && typeof input.answers === "object" ? (input.answers as Record<string, unknown>) : {};
    if (JSON.stringify(answers).length > 60_000) throw new AppError("Too much to save at once", 413);
    const step = typeof input.step === "string" ? input.step.slice(0, 60) : "welcome";
    await OnboardingDraft.updateOne({ userId, completedAt: null }, { $set: { familyId, answers, step } }, { upsert: true });
    return { saved: true };
}

export async function skipOnboarding(userId: string) {
    await User.updateOne({ userId, "onboarding.status": "pending" }, { $set: { onboarding: { status: "skipped", at: new Date() } } });
    return { skipped: true };
}

/* ── WhatsApp verification (no template needed) ───────────────────────────── */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);
export const VERIFY_TTL_MS = 60 * 60_000;

export const OTP_TTL_MS = 10 * 60_000; // what the approved template's footer promises
export const OTP_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || "otp";
export const OTP_TRIES = 5;

/**
 * Two ways to prove a WhatsApp number:
 *  - "otp" (default): Saheli sends the code with the approved "otp" authentication template; the caregiver types it in.
 *  - "message": the person sends "KAVACH 123456" from that phone to Saheli (wa.me link / QR). This also opens WhatsApp's
 *    24-hour window, so Saheli can greet them the moment setup finishes.
 */
export async function startVerification(userId: string, input: { target?: unknown; phone?: unknown; method?: unknown }) {
    const familyId = await familyOf(userId);
    const target = typeof input.target === "string" && /^(self|person:[01])$/.test(input.target) ? input.target : null;
    const p = phone.safeParse(input.phone);
    if (!target || !p.success) throw new AppError("Give the number with its country code, e.g. +919876543210", 400);
    const method = input.method === "message" ? "message" : "otp";
    // At most 10 codes an hour per caregiver and 4 WhatsApp codes an hour per number: enough for typos, not for spamming.
    const hourAgo = new Date(Date.now() - 3_600_000);
    if ((await PhoneVerification.countDocuments({ userId, createdAt: { $gte: hourAgo } })) >= 10) throw new AppError("Too many codes in an hour. Try again a little later.", 429);
    if (method === "otp" && (await PhoneVerification.countDocuments({ phoneKey: last10(p.data), method: "otp", createdAt: { $gte: hourAgo } })) >= 4) {
        throw new AppError("We've sent several codes to this number already. Wait a little, or use the other way below.", 429);
    }
    const code = String(randomInt(100000, 1_000_000));
    await PhoneVerification.updateMany({ userId, target, verifiedAt: null }, { $set: { expiresAt: new Date() } }); // older codes stop working
    const ttl = method === "otp" ? OTP_TTL_MS : VERIFY_TTL_MS;
    const row = await PhoneVerification.create({ code: sha(code), userId, familyId, target, phoneKey: last10(p.data), phone: p.data, method, expiresAt: new Date(Date.now() + ttl) });
    if (method === "otp") {
        try {
            const { sendMetaWhatsAppTemplate } = await import("../clients/metaWhatsApp.client");
            await sendMetaWhatsAppTemplate({ to: p.data, templateName: OTP_TEMPLATE, languageCode: "en", bodyParameters: [code], urlButtonParameter: code });
        } catch (err) {
            await PhoneVerification.updateOne({ _id: row._id }, { $set: { expiresAt: new Date() } });
            console.warn("onboarding OTP send failed:", err instanceof Error ? err.message : err);
            throw new AppError("Couldn't send a code to this number on WhatsApp. Check the number, or use the other way below.", 502);
        }
        return { method, sentTo: p.data, expiresInMinutes: ttl / 60_000 };
    }
    const number = appConfig.whatsapp.kavachNumber.replace(/\D/g, "");
    const text = `KAVACH ${code}`;
    return { method, code, text, link: `https://wa.me/${number}?text=${encodeURIComponent(text)}`, saheliNumber: appConfig.whatsapp.kavachNumber, expiresInMinutes: ttl / 60_000 };
}

/** The caregiver types the code that arrived on that WhatsApp. 5 tries per code, each claimed before comparing. */
export async function confirmVerification(userId: string, input: { target?: unknown; code?: unknown }) {
    await familyOf(userId);
    const target = typeof input.target === "string" && /^(self|person:[01])$/.test(input.target) ? input.target : null;
    const code = String(input.code ?? "").replace(/\D/g, "");
    if (!target || code.length !== 6) throw new AppError("Enter the 6-digit code", 400);
    const v = await PhoneVerification.findOne({ userId, target, method: "otp", verifiedAt: null }).sort({ createdAt: -1 });
    if (!v || new Date(v.expiresAt) <= new Date() || v.tries >= OTP_TRIES) throw new AppError("This code has expired. Send a new one.", 410);
    const took = await PhoneVerification.updateOne({ _id: v._id, verifiedAt: null, tries: { $lt: OTP_TRIES } }, { $inc: { tries: 1 } });
    if (took.modifiedCount !== 1) throw new AppError("This code has expired. Send a new one.", 410);
    if (sha(code) !== v.code) throw new AppError(v.tries + 1 >= OTP_TRIES ? "Too many wrong tries. Send a new code." : "That code doesn't match. Check the WhatsApp message and try again.", 400);
    await PhoneVerification.updateOne({ _id: v._id, verifiedAt: null }, { $set: { verifiedAt: new Date() } });
    return { verified: true, phone: v.phone };
}

export async function verificationStatus(userId: string, target: string) {
    const v = await PhoneVerification.findOne({ userId, target }).sort({ createdAt: -1 }).lean<{ verifiedAt?: Date | null; phone: string; expiresAt: Date }>();
    if (!v) return { verified: false };
    return { verified: !!v.verifiedAt, phone: v.phone, at: v.verifiedAt ?? null, expired: !v.verifiedAt && new Date(v.expiresAt) < new Date() };
}

export const VERIFY_RE = /^\s*kavach\s*[-:]?\s*(\d{6})\s*$/i;

/**
 * Called first for every WhatsApp message. Only a message that is exactly "KAVACH 123456", from a number with a code
 * waiting for it, is taken: that verifies the number and gets a short thank-you (in their language when the caregiver
 * already chose it). Everything else, including a code from a number nobody is verifying, goes on to Saheli (null).
 */
export async function verifyFromWhatsApp(fromPhone: string, text: string): Promise<{ reply: string } | null> {
    const m = VERIFY_RE.exec(String(text ?? ""));
    if (!m) return null;
    const phoneKey = last10(fromPhone);
    const v = await PhoneVerification.findOne({ code: sha(m[1]), phoneKey, method: { $ne: "otp" }, verifiedAt: null, expiresAt: { $gt: new Date() } });
    if (!v) {
        const waiting = await PhoneVerification.exists({ phoneKey, method: { $ne: "otp" }, verifiedAt: null, createdAt: { $gte: new Date(Date.now() - 24 * 3_600_000) } });
        if (!waiting) return null;
        return { reply: "This code has expired or was already used. Please ask your family for a new one 🙏\nयह कोड पुराना हो गया है, परिवार से नया कोड माँग लीजिए 🙏" };
    }
    const took = await PhoneVerification.updateOne({ _id: v._id, verifiedAt: null }, { $set: { verifiedAt: new Date() } });
    if (took.modifiedCount !== 1) return null;
    const draft = await OnboardingDraft.findOne({ userId: v.userId, completedAt: null }).lean<{ answers?: { persons?: Array<{ language?: string; dialect?: string; addressAs?: string; name?: string }> } }>();
    const idx = v.target.startsWith("person:") ? Number(v.target.split(":")[1]) : -1;
    const who = idx >= 0 ? draft?.answers?.persons?.[idx] : undefined;
    return { reply: verifiedThanks(normaliseSpeech({ language: who?.language, dialect: who?.dialect }), who?.addressAs || who?.name || "") };
}

const THANKS: Record<string, (name: string) => string> = {
    hi: (n) => `नमस्ते${n ? ` ${n}` : ""} 🙏 आपका नंबर जुड़ गया। मैं सहेली हूँ, जल्दी ही आपसे बात करूँगी।`,
    mr: (n) => `नमस्कार${n ? ` ${n}` : ""} 🙏 तुमचा नंबर जोडला गेला. मी सहेली, लवकरच तुमच्याशी बोलेन.`,
    bn: (n) => `নমস্কার${n ? ` ${n}` : ""} 🙏 আপনার নম্বর যুক্ত হয়েছে। আমি সহেলি, শিগগিরই আপনার সঙ্গে কথা বলব।`,
    ta: (n) => `வணக்கம்${n ? ` ${n}` : ""} 🙏 உங்கள் எண் இணைக்கப்பட்டது. நான் சஹேலி, விரைவில் உங்களிடம் பேசுவேன்.`,
    te: (n) => `నమస్కారం${n ? ` ${n}` : ""} 🙏 మీ నంబర్ జతచేయబడింది. నేను సహేలి, త్వరలో మీతో మాట్లాడతాను.`,
    kn: (n) => `ನಮಸ್ಕಾರ${n ? ` ${n}` : ""} 🙏 ನಿಮ್ಮ ಸಂಖ್ಯೆ ಸೇರಿಸಲಾಗಿದೆ. ನಾನು ಸಹೇಲಿ, ಬೇಗ ನಿಮ್ಮ ಜೊತೆ ಮಾತಾಡುತ್ತೇನೆ.`,
    ml: (n) => `നമസ്കാരം${n ? ` ${n}` : ""} 🙏 നിങ്ങളുടെ നമ്പർ ചേർത്തു. ഞാൻ സഹേലി, ഉടനെ നിങ്ങളോട് സംസാരിക്കാം.`,
    gu: (n) => `નમસ્તે${n ? ` ${n}` : ""} 🙏 તમારો નંબર જોડાઈ ગયો. હું સહેલી છું, જલ્દી જ તમારી સાથે વાત કરીશ.`,
    pa: (n) => `ਸਤ ਸ੍ਰੀ ਅਕਾਲ${n ? ` ${n}` : ""} 🙏 ਤੁਹਾਡਾ ਨੰਬਰ ਜੁੜ ਗਿਆ। ਮੈਂ ਸਹੇਲੀ ਹਾਂ, ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਗੱਲ ਕਰਾਂਗੀ।`,
    or: (n) => `ନମସ୍କାର${n ? ` ${n}` : ""} 🙏 ଆପଣଙ୍କ ନମ୍ବର ଯୋଡ଼ି ହୋଇଗଲା। ମୁଁ ସହେଲି, ଶୀଘ୍ର ଆପଣଙ୍କ ସହ କଥା ହେବି।`,
    en: (n) => `Hello${n ? ` ${n}` : ""} 🙏 Your number is connected. I'm Saheli, and I'll talk to you very soon.`,
};

export function verifiedThanks(speech: SpeechProfile, name: string): string {
    const greet = dialectInfo(speech.dialect)?.greeting;
    const base = (THANKS[speech.language ?? ""] ?? THANKS.hi)(name);
    return greet && speech.language === "hi" ? base.replace(/^नमस्ते/, greet) : base;
}

/* ── prescription photo → medicines to confirm ────────────────────────────── */

const SLOT_TIME = { morning: "08:00", afternoon: "13:00", evening: "18:00", night: "21:00" } as const;

/** "1-0-1", "BD", "twice daily", "at bedtime" → dose times; "after food" / "AC" → food timing. */
export function scheduleFromText(text: string, day?: Person["day"]): { times: string[]; food?: Person["medicines"][number]["food"] } {
    const t = ` ${String(text || "").toLowerCase()} `;
    const at = {
        morning: day?.breakfast || SLOT_TIME.morning,
        afternoon: day?.lunch || SLOT_TIME.afternoon,
        evening: SLOT_TIME.evening,
        night: day?.dinner || SLOT_TIME.night,
    };
    let slots: Array<keyof typeof at> = [];
    const pattern = /\b([01½])\s*[-–x]\s*([01½])\s*[-–x]\s*([01½])\b/.exec(t);
    if (pattern) {
        if (pattern[1] !== "0") slots.push("morning");
        if (pattern[2] !== "0") slots.push("afternoon");
        if (pattern[3] !== "0") slots.push("night");
    } else if (/\b(tds|tid|thrice|three times|3 times)\b/.test(t)) slots = ["morning", "afternoon", "night"];
    else if (/\b(bd|bid|twice|two times|2 times)\b/.test(t)) slots = ["morning", "night"];
    else if (/\b(hs|bedtime|at night|night|raat|sote)\b/.test(t)) slots = ["night"];
    else if (/\b(od|once|daily|morning|subah)\b/.test(t)) slots = ["morning"];
    const food = /\b(ac|before (food|meal|breakfast)|empty stomach|khali pet)\b/.test(t)
        ? (/\bempty stomach|khali pet\b/.test(t) ? "empty_stomach" : "before_food")
        : /\b(pc|after (food|meal|breakfast|lunch|dinner)|khane ke baad)\b/.test(t) ? "after_food" : /\bwith (food|meal)\b/.test(t) ? "with_food" : undefined;
    return { times: [...new Set(slots.map((s) => at[s]))].sort(), food };
}

export async function readPrescription(userId: string, file: { buffer: Buffer; mimetype: string } | undefined) {
    await familyOf(userId);
    if (!allow(userId, "rx", 20)) throw new AppError("That's a lot of photos for one hour. Add the rest by hand, or try again later.", 429);
    if (!file?.buffer?.length) throw new AppError("Add a photo of the prescription", 400);
    if (file.buffer.length > 8 * 1024 * 1024) throw new AppError("The photo is too large (8 MB at most)", 413);
    const { analyzeCareMedia } = await import("./saheliMediaVision.service");
    const out = await analyzeCareMedia({ buffer: file.buffer, mimeType: file.mimetype, caption: "prescription for setting up medicine reminders" });
    if (!out) throw new AppError("Couldn't read the photo. Try a clearer, well-lit picture, or add the medicines by hand.", 422);
    const medicines = (out.medications || []).slice(0, 20).map((m) => {
        const s = scheduleFromText([m.frequency, m.time, m.instructions].filter(Boolean).join(" "));
        return { name: m.name.slice(0, 80), dose: m.dosage?.slice(0, 60), times: s.times, food: s.food, notes: m.instructions?.slice(0, 200) };
    }).filter((m) => m.name);
    return { kind: out.kind, medicines, note: medicines.length ? "Check each one before saving." : "No medicines found on this photo." };
}

/* ── smart follow-up questions ────────────────────────────────────────────── */

/** Up to 3 short questions a thoughtful nurse would still ask, given the answers so far (none when nothing is missing). */
export async function followupQuestions(userId: string, answers: unknown): Promise<{ questions: Array<{ id: string; q: string; placeholder?: string }> }> {
    await familyOf(userId);
    if (!allow(userId, "followups", 10)) return { questions: [] };
    const brief = JSON.stringify(answers ?? {}).slice(0, 8000);
    const raw = await vertexGenerateText({
        model: vertexFlashModel(),
        system: "You help set up Saheli, a WhatsApp care companion for Indian elders. You read a caregiver's onboarding answers and ask at most 3 short, specific follow-up questions that would really help care (for example: a painkiller for the knee pain they mentioned, the target sugar range, who has the house key if she lives alone, which hand she uses if she had a stroke). Never ask again what is already answered. No medical advice. If nothing important is missing, return an empty list. Questions in simple English, under 16 words each, addressed to the caregiver, using the name the family calls the elder.",
        prompt: `Onboarding answers (JSON):\n${brief}\n\nReturn JSON {"questions":[{"id":"q1","q":"…","placeholder":"…"}]}`,
        json: true,
        responseSchema: { type: "OBJECT", properties: { questions: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, q: { type: "STRING" }, placeholder: { type: "STRING" } }, required: ["id", "q"] } } }, required: ["questions"] },
        temperature: 0.3,
        maxOutputTokens: 2000, // the model's thinking counts too: a small limit cut the JSON off mid-way
        timeoutMs: 25_000,
        thinkingLevel: "low",
    }).catch(() => null);
    const parsed = parseJsonLoose<{ questions?: Array<{ id?: string; q?: string; placeholder?: string }> }>(raw);
    const questions = (parsed?.questions || [])
        .filter((x) => x?.q && x.q.length < 220)
        .slice(0, 3)
        .map((x, i) => ({ id: `f${i + 1}`, q: String(x.q).trim(), placeholder: x.placeholder?.slice(0, 80) }));
    return { questions };
}

/* ── set everything up ────────────────────────────────────────────────────── */

const LEGACY_LANG: Record<string, "english" | "hindi" | "tamil" | "kannada"> = { en: "english", hi: "hindi", ta: "tamil", kn: "kannada" };
const FOOD_WORDS: Record<string, string> = { before_food: "before food", after_food: "after food", with_food: "with food", empty_stomach: "on an empty stomach", any: "" };

type Fact = { domain: string; name: string; details: Record<string, unknown>; sentence: string };

/** The care record entries for one person, as the dashboard would save them. */
export function factsFor(p: Person, answers: Answers, caregiverName: string): Fact[] {
    const first = p.name.split(/\s+/)[0];
    const facts: Fact[] = [];
    const call = p.addressAs || p.callThem;
    if (call) facts.push({ domain: "naming", name: "address_as", details: { name: call, family_calls: p.callThem || null, avoid: [] }, sentence: `Call ${first} "${call}"${p.callThem && p.callThem !== call ? ` (the family calls them ${p.callThem})` : ""}` });
    const speech = normaliseSpeech({ language: p.language, dialect: p.dialect });
    if (speech.language) facts.push({ domain: "language", name: "preferred", details: { ...speech }, sentence: `Speaks ${speechLabel(speech)}` });
    for (const c of p.conditions) facts.push({ domain: "condition", name: c, details: { name: c }, sentence: `${first} has ${c}` });
    if (p.conditionsOther) facts.push({ domain: "condition", name: "other", details: { name: p.conditionsOther }, sentence: `Other health conditions: ${p.conditionsOther}` });
    if (!p.allergies.none) for (const a of p.allergies.items) facts.push({ domain: "allergy", name: a, details: { allergen: a }, sentence: `Allergic to ${a}` });
    for (const m of p.medicines) {
        const when = m.times.length ? ` at ${m.times.join(", ")}` : "";
        const food = m.food ? ` ${FOOD_WORDS[m.food]}` : "";
        facts.push({
            domain: "medicine", name: m.name,
            details: { name: m.name, dose: m.dose || null, times: m.times, ...(m.food ? { food_timing: m.food } : {}), ...(m.notes ? { instructions: m.notes } : {}) },
            sentence: `${m.name}${m.dose ? ` ${m.dose}` : ""}${when}${food}`.trim(),
        });
    }
    const d = p.day;
    const routine: Array<[string, string | undefined, string]> = [["wake", d.wake, "Wakes up"], ["breakfast", d.breakfast, "Breakfast"], ["lunch", d.lunch, "Lunch"], ["tea", d.tea, "Evening tea"], ["dinner", d.dinner, "Dinner"], ["sleep", d.sleep, "Sleeps"]];
    for (const [name, time, label] of routine) if (time) facts.push({ domain: "routine", name, details: { time }, sentence: `${label} around ${time}` });
    for (const a of d.activities) facts.push({ domain: "routine", name: a, details: { activity: a }, sentence: `Usually: ${a}` });
    if (p.sugarCheck && p.sugarCheck !== "no") facts.push({ domain: "routine", name: "sugar_check", details: { how_often: p.sugarCheck }, sentence: `Checks sugar at home (${p.sugarCheck})` });
    if (p.bpMachine) facts.push({ domain: "home", name: "bp_machine", details: { has: true }, sentence: "Has a BP machine at home" });
    if (p.livesWith || p.city) facts.push({ domain: "home", name: "lives_with", details: { with: p.livesWith || null, city: p.city || null }, sentence: `Lives ${p.livesWith === "alone" ? "alone" : p.livesWith ? `with ${p.livesWith === "me" ? caregiverName : p.livesWith.replace("_", " ")}` : ""}${p.city ? ` in ${p.city}` : ""}`.trim() });
    if (p.age) facts.push({ domain: "profile", name: "age", details: { age: p.age }, sentence: `${p.age} years old` });
    if (p.doctor?.name) facts.push({ domain: "doctor", name: p.doctor.name, details: { ...p.doctor }, sentence: `Doctor: ${p.doctor.name}${p.doctor.hospital ? `, ${p.doctor.hospital}` : ""}` });
    if (p.likes.length || p.likesOther) facts.push({ domain: "preference", name: "likes", details: { topics: p.likes, more: p.likesOther || null }, sentence: `Enjoys talking about ${[...p.likes, p.likesOther].filter(Boolean).join(", ")}` });
    if (p.avoidTopics) facts.push({ domain: "preference", name: "avoid_topics", details: { topics: p.avoidTopics }, sentence: `Avoid talking about: ${p.avoidTopics}` });
    if (answers.emergency?.name && answers.emergency.phone) facts.push({ domain: "contact", name: answers.emergency.name, details: { ...answers.emergency }, sentence: `Emergency contact: ${answers.emergency.name}${answers.emergency.relation ? ` (${answers.emergency.relation})` : ""}, ${answers.emergency.phone}` });
    facts.push({ domain: "family", name: "call_first", details: { name: caregiverName }, sentence: `Call ${caregiverName} first` });
    return facts;
}

/** The note Saheli reads: everything soft that is not a care record field. */
export function noteFor(p: Person, answers: Answers): string {
    const lines = [`# About ${p.name}`];
    if (p.problems.length || p.problemsOther) lines.push(`\n**Bothering them lately:** ${[...p.problems, p.problemsOther].filter(Boolean).join(", ")}`);
    if (p.day.notes) lines.push(`\n**Their day:** ${p.day.notes}`);
    if (p.reads) lines.push(`\n**Prefers:** ${p.reads === "voice" ? "voice notes" : p.reads === "both" ? "text and voice notes" : "text messages"}`);
    if (answers.helpWith.length) lines.push(`\n**The family wants Saheli to help with:** ${answers.helpWith.join(", ")}`);
    for (const f of answers.followups) if (f.a?.trim()) lines.push(`\n**${f.q}** ${f.a}`);
    if (answers.anythingElse) lines.push(`\n**Anything else:** ${answers.anythingElse}`);
    return lines.join("\n");
}

type Member = { userId: string; role: string; status: string };
const LIVE = (m: Member) => m.status !== "REMOVED" && m.status !== "REJECTED";

/**
 * Add the person cared for, or find them if they are already here (a retry after a half-finished setup).
 *  - Already a care recipient of this family: reused as is, never renamed.
 *  - Their number belongs to someone already on Kavach (another family, or their own account): linked only when the
 *    caregiver verified that number, and keeping the name that account already has; otherwise skipped.
 *  - New: added quietly (no "added you" WhatsApp; Saheli says hello herself, in their language).
 * `shared` is true when the person also belongs to another family, so their own settings are left alone.
 */
async function addPerson(familyId: string, inviter: InstanceType<typeof User>, p: Person, verified: boolean): Promise<{ userId: string; shared: boolean }> {
    if (!p.phone) throw new AppError(`${p.name} needs a WhatsApp number`, 400);
    const { cc, number } = splitPhone(p.phone);
    const { normalizePhoneInput } = await import("../utils/phone.util");
    const key = normalizePhoneInput(cc, number).key;
    const family = await Family.findOne({ familyId }).lean<{ members: Member[] }>();
    const members = (family?.members || []).filter(LIVE);
    const existing = await User.findOne({ phoneKey: key }).lean<{ userId: string; firstName?: string; lastName?: string }>();
    const otherFamilies = async (id: string) => Boolean(await Family.exists({ familyId: { $ne: familyId }, status: "ACTIVE", members: { $elemMatch: { userId: id, status: { $nin: ["REMOVED", "REJECTED"] } } } }));
    if (existing) {
        const here = members.find((m) => m.userId === existing.userId);
        if (here?.role === FamilyRole.CARE_RECIPIENT) return { userId: existing.userId, shared: await otherFamilies(existing.userId) };
        if (here) throw new AppError(`${p.phone} is already in your family in another role`, 409);
        if (existing.userId === inviter.userId) throw new AppError("That's your own number", 409);
        if (!verified) throw new AppError(`${p.phone} is already on Kavach; verify it on WhatsApp to link ${p.name}`, 409);
    }
    const { inviteFamilyMember } = await import("./familyMember.service");
    const name = existing ? [existing.firstName, existing.lastName].filter(Boolean).join(" ") || p.name : p.name;
    await inviteFamilyMember(familyId, inviter, { role: "care_recipient", name, relationship: p.relation, phone: number, phoneCountryCode: cc, location: p.city, notify: false });
    const added = await User.findOne({ phoneKey: key }).lean<{ userId: string }>();
    if (!added) throw new AppError(`Couldn't add ${p.name}`, 500);
    return { userId: added.userId, shared: existing ? await otherFamilies(added.userId) : false };
}

/** Quiet hours from bedtime to waking, shrunk so no medicine time falls inside; none when less than 2 hours remain. */
export function quietHours(sleep?: string, wake?: string, doses: string[] = []): { start?: string; end?: string } {
    if (!sleep || !wake) return { start: sleep, end: wake };
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const hhmmOf = (x: number) => `${String(Math.floor((x % 1440) / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
    const s0 = mins(sleep);
    const len = (mins(wake) - s0 + 1440) % 1440;
    let from = 0, to = len;
    for (const t of doses) {
        const off = (mins(t) - s0 + 1440) % 1440;
        if (off >= len) continue;
        if (off < len / 2) from = Math.max(from, off + 30); // a late-evening dose: quiet starts after it
        else to = Math.min(to, off); // an early-morning dose: quiet ends at it
    }
    if (to - from < 120) return {};
    return { start: hhmmOf(s0 + from), end: hhmmOf(s0 + to) };
}

async function engineFact(familyId: string, subjectId: string, actor: { id: string; name: string }, f: Fact) {
    return aiEngineJson("POST", `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(subjectId)}/facts`, { actor, ...f }, 45_000);
}

/** Saheli's first message to the person, in their language/dialect and script (model-written, with a plain fallback). */
async function welcomeText(p: Person, speech: SpeechProfile, meds: string[]): Promise<string> {
    const call = p.addressAs || p.callThem || p.name.split(/\s+/)[0];
    const lang = speechLabel(speech);
    const script = languageInfo(speech.language)?.script ?? "devanagari";
    const raw = await vertexGenerateText({
        model: vertexFlashModel(),
        system: "You are Saheli, a warm young Indian woman who looks after elders on WhatsApp like a caring granddaughter.",
        prompt: `Write your first WhatsApp message to ${call}. Language: ${lang}${speech.dialect ? " — speak it the way people at home speak this dialect" : ""}. Write ONLY in ${script} script, no English words, no Roman letters (numbers 0-9 are fine). Under 45 words. Say who you are, that their family asked you to be with them, ${meds.length ? `that you will gently remind them of their medicines (${meds.slice(0, 3).join(", ")})` : "that you are here to chat and help"}, and end with one simple, warm question about their day. No emoji except one 🙏 or 🌸. Output only the message.`,
        temperature: 0.6,
        maxOutputTokens: 1500,
        timeoutMs: 25_000,
        thinkingLevel: "low",
    }).catch(() => null);
    const text = (raw || "").trim().replace(/^["“]|["”]$/g, "");
    if (text && text.length <= 500 && !/https?:|www\.|\.(com|in|org|net)\b|@/i.test(text)) return text;
    return speech.language === "en"
        ? `Hello ${call} 🙏 I'm Saheli. Your family asked me to keep you company and remind you of your medicines. How is your day going?`
        : `नमस्ते ${call} 🙏 मैं सहेली हूँ। आपके परिवार ने मुझे आपका साथ देने और दवाई याद दिलाने को कहा है। आज आपका दिन कैसा है?`;
}

/**
 * welcome: "sent" — Saheli said hello; "waiting" — verified by a code we sent, so WhatsApp lets Saheli write only after
 * they message her once (she greets them then); "not_verified" — their number isn't connected yet; "failed".
 */
export type Welcome = "sent" | "waiting" | "not_verified" | "failed";
export type SetupResult = {
    persons: Array<{ userId: string; name: string; addressAs: string; language: string; reminders: Array<{ name: string; times: string[] }>; checkins: string[]; verified: boolean; welcomeSent: boolean; welcome: Welcome; problems: string[] }>;
    caregiver: { name: string; phoneVerified: boolean };
};

/**
 * Turn the answers into the family. Each part is done on its own and reported; one failure (say the engine is busy)
 * never undoes the rest, and the caregiver can fix the remainder from the dashboard or by telling Saheli.
 */
export async function completeOnboarding(userId: string, rawAnswers: unknown): Promise<SetupResult> {
    const familyId = await familyOf(userId);
    const parsed = AnswersSchema.safeParse(rawAnswers);
    if (!parsed.success) throw new AppError(`Please check: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`, 400);
    const answers = parsed.data;
    if (answers.careFor !== "self" && answers.persons.some((p) => !p.phone)) throw new AppError("Add a WhatsApp number for each person", 400);
    const keys = answers.persons.map((p) => p.phone && last10(p.phone)).filter(Boolean);
    if (new Set(keys).size !== keys.length) throw new AppError("The two people need different WhatsApp numbers", 400);
    const user = await User.findOne({ userId });
    if (!user) throw new AppError("User not found", 404);
    const status = user.onboarding?.status;
    if (status !== "pending" && status !== "skipped") throw new AppError("Your family is already set up. Change anything from the dashboard or tell Saheli.", 409);
    // One setup at a time: a double click or a second tab must not add the same person twice.
    if (running.has(userId)) throw new AppError("Already setting up; give it a moment.", 409);
    running.add(userId);
    try {
        return await setUp(userId, familyId, user, answers);
    } finally {
        running.delete(userId);
    }
}

const running = new Set<string>();

async function setUp(userId: string, familyId: string, user: InstanceType<typeof User>, answers: Answers): Promise<SetupResult> {
    const self = answers.careFor === "self";
    // You: name, and your WhatsApp if you verified it (in self-care that is the number on the "your WhatsApp" step).
    const [first, ...rest] = answers.you.name.split(/\s+/);
    user.firstName = first;
    user.lastName = rest.join(" ") || undefined;
    const rows = await PhoneVerification.find({ userId, verifiedAt: { $ne: null } }).sort({ verifiedAt: 1 }).lean<Array<{ target: string; phoneKey: string; method?: string; verifiedAt: Date }>>();
    const verified = new Map(rows.map((v) => [v.target, v])); // the latest per target wins
    const isVerified = (target: string, ph?: string) => !!ph && verified.get(target)?.phoneKey === last10(ph);
    const myPhone = self ? answers.persons[0]?.phone || answers.you.phone : answers.you.phone;
    let phoneVerified = false;
    if (myPhone && isVerified("self", myPhone)) {
        const { normalizePhoneInput, phoneFieldsFromNormalized } = await import("../utils/phone.util");
        try {
            const { cc, number } = splitPhone(myPhone);
            const f = phoneFieldsFromNormalized(normalizePhoneInput(cc, number));
            const taken = await User.findOne({ phoneKey: f.phoneKey, userId: { $ne: userId } }).lean();
            if (!taken) {
                user.set("phone", f.phone);
                user.set("phoneKey", f.phoneKey);
                phoneVerified = true;
            }
        } catch {
            /* keep going without the number */
        }
    }
    await user.save();
    const actor = { id: userId, name: answers.you.name };

    const result: SetupResult = { persons: [], caregiver: { name: answers.you.name, phoneVerified } };
    for (const [i, raw] of answers.persons.entries()) {
        const p = self ? { ...raw, phone: raw.phone || answers.you.phone } : raw;
        const target = self ? "self" : `person:${i}`;
        const verifiedHere = isVerified(target, p.phone);
        const speech = normaliseSpeech({ language: p.language, dialect: p.dialect });
        const addressAs = p.addressAs || p.callThem || p.name.split(/\s+/)[0];
        const problems: string[] = [];
        let subject = userId;
        let shared = false;
        if (!self) {
            try {
                ({ userId: subject, shared } = await addPerson(familyId, user, p, verifiedHere));
            } catch (err) {
                result.persons.push({
                    userId: "", name: p.name, addressAs, language: speechLabel(speech), reminders: [], checkins: [], verified: verifiedHere,
                    welcomeSent: false, welcome: "failed", problems: [err instanceof AppError ? err.message : `Couldn't add ${p.name}`],
                });
                continue;
            }
        }
        // How Saheli speaks to them (voice notes and reminders follow this). Someone who also belongs to another family
        // keeps the settings they already have there.
        if (!shared) {
            try {
                const V = await import("./voicePreference.service");
                if (speech.language) await V.setSpeechProfile({ userId: subject, familyId, by: userId, ...speech });
                await V.setVoiceMode({ userId: subject, familyId, mode: p.reads === "voice" || p.reads === "both" ? "always" : "auto", by: userId });
            } catch {
                problems.push("voice and language settings");
            }
        }
        const checkins = answers.helpWith.includes("checkins") || answers.helpWith.includes("company") ? ["morning", "evening"] : [];
        const quiet = quietHours(p.day.sleep, p.day.wake, p.medicines.flatMap((m) => m.times));
        try {
            const { updateCompanionProfile } = await import("./saheliCompanion.service");
            await updateCompanionProfile(familyId, subject, userId, {
                enabled: true,
                ...(p.callThem || p.relation ? { relationshipLabel: (p.callThem || p.relation).slice(0, 80) } : {}),
                ...(LEGACY_LANG[speech.language ?? ""] ? { preferredLanguage: LEGACY_LANG[speech.language!] } : {}),
                ...(quiet.start ? { quietHoursStart: quiet.start } : {}),
                ...(quiet.end ? { quietHoursEnd: quiet.end } : {}),
                outreachSlots: checkins as Array<"morning" | "evening">,
                personaNotes: [p.problemsOther, p.day.notes].filter(Boolean).join(" · ").slice(0, 500) || undefined,
            });
        } catch {
            problems.push("Saheli's daily check-ins");
        }
        // The care record. Medicines go one by one (each creates its reminders through the dashboard's path); the rest
        // four at a time.
        const reminders: Array<{ name: string; times: string[] }> = [];
        const save = async (f: Fact) => {
            try {
                await engineFact(familyId, subject, actor, f);
                if (f.domain === "medicine") reminders.push({ name: String(f.details.name), times: (f.details.times as string[]) || [] });
            } catch {
                problems.push(f.domain === "medicine" ? `medicine ${f.name}` : f.domain);
            }
        };
        const facts = factsFor(p, answers, answers.you.name);
        const others = facts.filter((f) => f.domain !== "medicine");
        for (let k = 0; k < others.length; k += 4) await Promise.all(others.slice(k, k + 4).map(save));
        for (const f of facts.filter((x) => x.domain === "medicine")) await save(f);
        try {
            await aiEngineJson("PUT", `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(subject)}/notes`, {
                actor, subject_id: subject, slug: "about", title: `About ${p.name}`, body: noteFor(p, answers),
            }, 30_000);
        } catch {
            problems.push("notes for Saheli");
        }
        // Saheli says hello only when they verified by messaging her: that message opened WhatsApp's 24-hour window.
        // Verified by a code we sent, she may write only after they message her once, so she greets them then.
        let welcome: Welcome = verifiedHere ? "waiting" : "not_verified";
        const v = verified.get(target);
        const windowOpen = verifiedHere && v?.method !== "otp" && Date.now() - new Date(v!.verifiedAt).getTime() < 23 * 3_600_000;
        if (windowOpen && !self) {
            try {
                const { sendSaheliWhatsApp } = await import("./careMemorySync.service");
                const text = await welcomeText(p, speech, reminders.map((r) => r.name));
                welcome = (await sendSaheliWhatsApp({ familyId, recipientUserId: subject, toUserId: subject, text })).delivered ? "sent" : "failed";
            } catch {
                welcome = "failed";
            }
            if (welcome === "failed") problems.push("Saheli's hello on WhatsApp");
        }
        result.persons.push({
            userId: subject, name: p.name, addressAs, language: speechLabel(speech),
            reminders, checkins, verified: verifiedHere, welcomeSent: welcome === "sent", welcome, problems: [...new Set(problems)],
        });
    }

    // Nobody could be added: nothing is marked done, the answers stay, and they can try again.
    if (!result.persons.some((x) => x.userId)) throw new AppError(result.persons[0]?.problems[0] || "Couldn't set up your family. Please try again.", 409);
    await User.updateOne({ userId }, { $set: { onboarding: { status: "done", at: new Date() } } });
    // The answers now live in the care record; keep only the summary here.
    await OnboardingDraft.updateOne({ userId, completedAt: null }, { $set: { completedAt: new Date(), result, answers: {} } });
    return result;
}
