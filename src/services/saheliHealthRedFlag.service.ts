/**
 * Health red-flag alerts to caregivers — must never miss.
 *   1. Keyword safety net (EN + Hindi/Hinglish), synchronous, biased toward alerting.
 *   2. Gemini flash classifier for everything else (async, bias: alert when unsure).
 * Deduped per recipient+category for a short window. Copy never diagnoses.
 */
import { parseJsonLoose, vertexFlashModel, vertexGenerateText } from "../clients/vertexGemini.client";
import { claimCaregiverAlert, notifyCaregivers } from "./saheliCaregiverAlert.service";
import { logActivity } from "./activityLog.service";

export type RedFlagCategory =
    | "chest_pain"
    | "breathing"
    | "fall"
    | "fainting"
    | "dizziness"
    | "confusion"
    | "stroke_signs"
    | "severe_pain"
    | "bleeding"
    | "missed_critical_meds"
    | "low_mood"
    | "self_harm"
    | "other_concern";

const RULES: Array<{ category: RedFlagCategory; re: RegExp }> = [
    { category: "self_harm", re: /\b(suicid\w*|kill\s+myself|end\s+my\s+life|want\s+to\s+die|don'?t\s+want\s+to\s+live|marna\s+chahti|marna\s+chahta|mar\s+jaun|jeena\s+nahi|khudkushi|no\s+reason\s+to\s+live)\b/i },
    { category: "chest_pain", re: /\b(chest\s*(?:pain|tight\w*|pressure|heavy|heaviness)|seene\s+(?:mein|me)\s+dard|chhati\s+(?:mein|me)\s+dard|heart\s*(?:pain|attack)|dil\s+(?:mein|me)\s+dard|left\s+arm\s+pain)\b/i },
    { category: "breathing", re: /\b(breathless\w*|short(?:ness)?\s+of\s+breath|can'?t\s+breathe|cannot\s+breathe|difficulty\s+breathing|trouble\s+breathing|saans\s+(?:nahi|lene\s+mein|phool|fool|ruk)|saans\s+ki\s+taklif|dam\s+ghut)\b/i },
    { category: "fall", re: /\b(i\s+fell|fell\s+down|have\s+fallen|had\s+a\s+fall|slipped\s+and|gir\s+(?:gayi|gaya|gai|padi|pada)|fisal\s+(?:gayi|gaya))\b/i },
    { category: "fainting", re: /\b(faint\w*|passed\s+out|blacked\s+out|lost\s+consciousness|behosh|unconscious)\b/i },
    { category: "dizziness", re: /\b(dizz\w*|giddy|vertigo|chakkar|sar\s+ghoom|head\s+(?:is\s+)?spinning|room\s+is\s+spinning)\b/i },
    { category: "stroke_signs", re: /\b(face\s+(?:is\s+)?droop\w*|slurred\s+speech|can'?t\s+speak|one\s+side\s+(?:weak|numb)|numb(?:ness)?\s+(?:in\s+)?(?:my\s+)?(?:arm|leg|face)|haath\s+sunn|paralys\w*)\b/i },
    { category: "confusion", re: /\b(confused|confusion|don'?t\s+know\s+where\s+i\s+am|can'?t\s+remember\s+where|lost\s+my\s+way|kuch\s+samajh\s+nahi\s+aa\s+raha|bhool\s+gayi\s+main\s+kahan)\b/i },
    { category: "bleeding", re: /\b(bleed\w*|blood\s+(?:in|from|coming)|vomit\w*\s+blood|khoon\s+(?:aa|nikal|beh))\b/i },
    { category: "severe_pain", re: /\b(severe|unbearable|terrible|worst|extreme|bahut\s+(?:zyada\s+)?tez|bohot\s+tez|asahniya)\s+(?:\w+\s+)?(?:pain|dard|headache|ache)\b|\b(?:pain|dard)\s+(?:is\s+)?(?:unbearable|very\s+bad|bahut\s+zyada)\b/i },
    { category: "missed_critical_meds", re: /\b(?:forgot|missed|skipped|didn'?t\s+take|haven'?t\s+taken|nahi\s+li|bhool\s+gayi|bhool\s+gaya)\b[^.]{0,40}\b(?:insulin|bp|blood\s+pressure|heart|thyroid|seizure|epilepsy|blood\s+thinner|warfarin|medicine|medicines|dawai|dawa|tablet|goli)\b|\b(?:insulin|dawai|dawa|medicine)\b[^.]{0,20}\b(?:nahi\s+li|missed|forgot|khatam\s+ho\s+gayi)\b/i },
    { category: "low_mood", re: /\b(very\s+(?:sad|lonely|depressed)|so\s+(?:lonely|depressed|hopeless)|hopeless|depressed|feel\s+worthless|nobody\s+cares|bahut\s+akeli|bahut\s+akela|udaas\s+hoon|dil\s+nahi\s+lagta|rona\s+aa\s+raha)\b/i },
    { category: "other_concern", re: /\b(high\s+fever|tez\s+bukhar|sugar\s+(?:is\s+)?(?:very\s+)?(?:low|high)|bp\s+(?:is\s+)?(?:very\s+)?(?:high|low)|can'?t\s+(?:walk|stand|get\s+up)|uth\s+nahi\s+pa\s+rahi|swollen|swelling|seizure|fits?\s+aa)\b/i },
];

const LABEL: Record<RedFlagCategory, string> = {
    chest_pain: "chest pain / pressure",
    breathing: "trouble breathing",
    fall: "a fall",
    fainting: "fainting",
    dizziness: "dizziness",
    confusion: "confusion",
    stroke_signs: "possible stroke signs",
    severe_pain: "severe pain",
    bleeding: "bleeding",
    missed_critical_meds: "missed medicine",
    low_mood: "very low mood",
    self_harm: "thoughts of self-harm",
    other_concern: "a health concern",
};

/** Pure keyword safety net. */
export function detectHealthRedFlagRules(text: string): RedFlagCategory | null {
    const t = text.trim();
    if (t.length < 3) return null;
    // "no chest pain" / "not dizzy anymore" → still alert only when no clear negation right before.
    for (const r of RULES) {
        const m = t.match(r.re);
        if (!m) continue;
        const before = t.slice(Math.max(0, (m.index ?? 0) - 14), m.index ?? 0).toLowerCase();
        if (/\b(no|not|never|without|nahi|na)\s*$/.test(before) && r.category !== "self_harm") continue;
        return r.category;
    }
    return null;
}

export function formatRedFlagAlert(input: { elderName?: string; category: RedFlagCategory; quote: string }): string {
    const who = input.elderName?.trim() || "Your family member";
    const quote = input.quote.replace(/\s+/g, " ").trim().slice(0, 180);
    const urgentLine =
        input.category === "self_harm" || input.category === "chest_pain" || input.category === "breathing" || input.category === "stroke_signs"
            ? "Please call them right now. If it seems serious, call 112."
            : "Please check in with them soon.";
    return [
        `⚠️ *Health alert — ${who}*`,
        `They mentioned ${LABEL[input.category]} to Saheli:`,
        `“${quote}”`,
        urgentLine,
        `_Saheli can't diagnose — this is just what they said._`,
    ].join("\n");
}

async function sendAlert(input: {
    familyId: string;
    recipientUserId: string;
    elderName?: string;
    text: string;
    category: RedFlagCategory;
    source: "rules" | "gemini";
}): Promise<boolean> {
    // Same category for the same person within 20 min → one alert (repeats are logged only).
    if (!claimCaregiverAlert(`redflag:${input.recipientUserId}:${input.category}`, 20 * 60_000)) {
        void logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            kind: "health",
            severity: "warn",
            title: `Health mention (repeat, alert already sent): ${LABEL[input.category]}`,
            detail: input.text,
            data: { category: input.category, source: input.source, deduped: true },
        });
        return false;
    }
    void logActivity({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        kind: "health",
        severity: "error",
        title: `Health red flag: ${LABEL[input.category]}`,
        detail: input.text,
        data: { category: input.category, source: input.source },
    });
    await notifyCaregivers({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.recipientUserId,
        message: formatRedFlagAlert({ elderName: input.elderName, category: input.category, quote: input.text }),
        urgency: "high",
        kind: "health_red_flag",
    });
    return true;
}

/**
 * Screen one elder message. Keyword hit → alert immediately (awaited). No hit → Gemini
 * screens in the background and alerts when concerned or unsure. Never throws.
 */
export async function screenElderMessageForRedFlags(input: {
    familyId: string;
    recipientUserId: string;
    elderName?: string;
    text: string;
}): Promise<RedFlagCategory | null> {
    const text = input.text.trim();
    if (!text || text.length < 4 || /^\[.*\]$/.test(text)) return null;
    try {
        const hit = detectHealthRedFlagRules(text);
        if (hit) {
            await sendAlert({ ...input, text, category: hit, source: "rules" });
            return hit;
        }
    } catch (err) {
        console.warn("red-flag rules failed:", err instanceof Error ? err.message : err);
    }
    // Cheap pre-filter: purely transactional short texts (confirm, digits, "order X") skip the model.
    if (/^(ok|okay|yes|no|haan|confirm|cancel|thanks?|\d+|[123])$/i.test(text)) return null;
    void (async () => {
        const raw = await vertexGenerateText({
            model: vertexFlashModel(),
            json: true,
            timeoutMs: 6000,
            maxOutputTokens: 120,
            system:
                "You screen WhatsApp messages from an elderly person (English/Hindi/Hinglish) for anything a caregiver " +
                "should know about NOW: physical symptoms (pain, breathing, fall, dizziness, fainting, confusion, bleeding, fever, " +
                "weakness), missed important medicines, very low mood, loneliness crisis, self-harm thoughts. " +
                "Be sensitive: when unsure, say concern=true. Ordinary chat, orders, reminders, jokes → concern=false. " +
                'Reply ONLY JSON {"concern":boolean,"category":"chest_pain|breathing|fall|fainting|dizziness|confusion|stroke_signs|severe_pain|bleeding|missed_critical_meds|low_mood|self_harm|other_concern"}',
            prompt: text.slice(0, 600),
        });
        const parsed = parseJsonLoose<{ concern?: boolean; category?: string }>(raw);
        if (!parsed?.concern) return;
        const category = (Object.keys(LABEL) as RedFlagCategory[]).includes(parsed.category as RedFlagCategory)
            ? (parsed.category as RedFlagCategory)
            : "other_concern";
        await sendAlert({ ...input, text, category, source: "gemini" });
    })().catch((err) => console.warn("red-flag gemini screen failed:", err instanceof Error ? err.message : err));
    return null;
}
