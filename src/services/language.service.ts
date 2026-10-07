/**
 * The languages and dialects Saheli speaks, and the script each is written in. Saheli writes every Indian language
 * in its own script (Hindi and the Hindi-belt dialects in Devanagari, Tamil in Tamil…), never in Roman letters unless
 * the person asked for that. Dialects are spoken with their base language's voice.
 * Mirrored in the engine (app/care/language.py); keep the two lists the same.
 */
export type Script = "latin" | "devanagari" | "bengali" | "gurmukhi" | "gujarati" | "odia" | "tamil" | "telugu" | "kannada" | "malayalam" | "arabic";

export type LanguageInfo = { code: string; name: string; native: string; script: Script };
export type DialectInfo = { code: string; name: string; native: string; base: string; region: string; greeting?: string };

export const LANGUAGES: LanguageInfo[] = [
    { code: "hi", name: "Hindi", native: "हिन्दी", script: "devanagari" },
    { code: "en", name: "English", native: "English", script: "latin" },
    { code: "bn", name: "Bengali", native: "বাংলা", script: "bengali" },
    { code: "mr", name: "Marathi", native: "मराठी", script: "devanagari" },
    { code: "ta", name: "Tamil", native: "தமிழ்", script: "tamil" },
    { code: "te", name: "Telugu", native: "తెలుగు", script: "telugu" },
    { code: "gu", name: "Gujarati", native: "ગુજરાતી", script: "gujarati" },
    { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", script: "kannada" },
    { code: "ml", name: "Malayalam", native: "മലയാളം", script: "malayalam" },
    { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", script: "gurmukhi" },
    { code: "or", name: "Odia", native: "ଓଡ଼ିଆ", script: "odia" },
    { code: "as", name: "Assamese", native: "অসমীয়া", script: "bengali" },
    { code: "ur", name: "Urdu", native: "اردو", script: "arabic" },
    { code: "ne", name: "Nepali", native: "नेपाली", script: "devanagari" },
    { code: "kok", name: "Konkani", native: "कोंकणी", script: "devanagari" },
];

export const DIALECTS: DialectInfo[] = [
    { code: "mwr", name: "Marwari", native: "मारवाड़ी", base: "hi", region: "Rajasthan (Jodhpur, Bikaner, Nagaur)", greeting: "राम राम सा" },
    { code: "mtr", name: "Mewari", native: "मेवाड़ी", base: "hi", region: "Rajasthan (Udaipur, Chittorgarh)", greeting: "राम राम सा" },
    { code: "dhd", name: "Dhundhari (Jaipuri)", native: "ढूंढाड़ी", base: "hi", region: "Rajasthan (Jaipur)", greeting: "राम राम सा" },
    { code: "swv", name: "Shekhawati", native: "शेखावाटी", base: "hi", region: "Rajasthan (Sikar, Jhunjhunu, Churu)", greeting: "राम राम सा" },
    { code: "hoj", name: "Hadoti", native: "हाड़ौती", base: "hi", region: "Rajasthan (Kota, Bundi)", greeting: "राम राम सा" },
    { code: "wbr", name: "Wagdi", native: "वागड़ी", base: "hi", region: "Rajasthan (Dungarpur, Banswara)" },
    { code: "bgc", name: "Haryanvi", native: "हरियाणवी", base: "hi", region: "Haryana", greeting: "राम राम" },
    { code: "bho", name: "Bhojpuri", native: "भोजपुरी", base: "hi", region: "East UP, West Bihar", greeting: "प्रणाम" },
    { code: "mai", name: "Maithili", native: "मैथिली", base: "hi", region: "North Bihar (Mithila)", greeting: "प्रणाम" },
    { code: "mag", name: "Magahi", native: "मगही", base: "hi", region: "South Bihar (Patna, Gaya)", greeting: "प्रणाम" },
    { code: "anp", name: "Angika", native: "अंगिका", base: "hi", region: "Bihar (Bhagalpur)", greeting: "प्रणाम" },
    { code: "bjj", name: "Bajjika", native: "बज्जिका", base: "hi", region: "Bihar (Vaishali, Muzaffarpur)", greeting: "प्रणाम" },
    { code: "awa", name: "Awadhi", native: "अवधी", base: "hi", region: "Central UP (Lucknow, Ayodhya)", greeting: "राम राम" },
    { code: "bns", name: "Bundeli", native: "बुंदेली", base: "hi", region: "Bundelkhand (Jhansi, Sagar)", greeting: "राम राम" },
    { code: "bfy", name: "Bagheli", native: "बघेली", base: "hi", region: "MP (Rewa, Satna)", greeting: "राम राम" },
    { code: "hne", name: "Chhattisgarhi", native: "छत्तीसगढ़ी", base: "hi", region: "Chhattisgarh", greeting: "जय जोहार" },
    { code: "bra", name: "Braj", native: "ब्रज", base: "hi", region: "Mathura, Agra", greeting: "राधे राधे" },
    { code: "mup", name: "Malvi", native: "मालवी", base: "hi", region: "MP (Indore, Ujjain)", greeting: "राम राम" },
    { code: "noe", name: "Nimadi", native: "निमाड़ी", base: "hi", region: "MP (Khandwa, Khargone)" },
    { code: "gbm", name: "Garhwali", native: "गढ़वाली", base: "hi", region: "Uttarakhand (Garhwal)", greeting: "सेवा लगाणु छौं" },
    { code: "kfy", name: "Kumaoni", native: "कुमाऊँनी", base: "hi", region: "Uttarakhand (Kumaon)", greeting: "पैलाग" },
    { code: "him", name: "Pahari (Himachali)", native: "पहाड़ी", base: "hi", region: "Himachal Pradesh" },
    { code: "doi", name: "Dogri", native: "डोगरी", base: "hi", region: "Jammu" },
    { code: "sck", name: "Sadri (Nagpuri)", native: "सादरी", base: "hi", region: "Jharkhand", greeting: "जोहार" },
    { code: "vah", name: "Varhadi", native: "वऱ्हाडी", base: "mr", region: "Vidarbha (Amravati, Akola)", greeting: "राम राम" },
    { code: "mlv", name: "Malvani", native: "मालवणी", base: "mr", region: "Konkan (Sindhudurg)" },
    { code: "ahr", name: "Ahirani", native: "अहिराणी", base: "mr", region: "Khandesh (Jalgaon, Dhule)", greeting: "राम राम" },
    { code: "tcy", name: "Tulu", native: "ತುಳು", base: "kn", region: "Coastal Karnataka (Mangaluru, Udupi)", greeting: "ನಮಸ್ಕಾರ" },
    { code: "kfa", name: "Kodava", native: "ಕೊಡವ", base: "kn", region: "Kodagu (Coorg)" },
    { code: "syl", name: "Sylheti", native: "সিলেটি", base: "bn", region: "Barak Valley (Silchar), Sylhet" },
    { code: "spv", name: "Sambalpuri", native: "ସମ୍ବଲପୁରୀ", base: "or", region: "West Odisha (Sambalpur)" },
    { code: "kth", name: "Kathiawadi", native: "કાઠિયાવાડી", base: "gu", region: "Saurashtra (Rajkot, Bhavnagar)" },
];

const LANG_BY = new Map<string, LanguageInfo>();
for (const l of LANGUAGES) for (const k of [l.code, l.name.toLowerCase(), l.native.toLowerCase()]) LANG_BY.set(k, l);
// Older stored values and common ways people write the names.
const LANG_ALIAS: Record<string, string> = { hinglish: "hi", hindustani: "hi", bangla: "bn", oriya: "or", english: "en", punjabi: "pa", panjabi: "pa", gujrati: "gu" };
const DIALECT_BY = new Map<string, DialectInfo>();
for (const d of DIALECTS) {
    for (const k of [d.code, d.name.toLowerCase(), d.native.toLowerCase(), d.name.toLowerCase().split(" (")[0]]) DIALECT_BY.set(k, d);
}
const DIALECT_ALIAS: Record<string, string> = { rajasthani: "mwr", jaipuri: "dhd", nagpuri: "sck", sadri: "sck", himachali: "him", pahari: "him", kumauni: "kfy", chattisgarhi: "hne", chhatisgarhi: "hne", chhattisgadi: "hne", marwadi: "mwr", haryanavi: "bgc", bhojpuria: "bho", mythili: "mai", maithli: "mai", konkani: "kok" };

export function languageInfo(code?: string | null): LanguageInfo | undefined {
    const k = String(code ?? "").trim().toLowerCase();
    return LANG_BY.get(k) ?? LANG_BY.get(LANG_ALIAS[k] ?? "") ?? LANG_BY.get(k.split(/[-_]/)[0]);
}

export function dialectInfo(code?: string | null): DialectInfo | undefined {
    const k = String(code ?? "").trim().toLowerCase();
    return DIALECT_BY.get(k) ?? DIALECT_BY.get(DIALECT_ALIAS[k] ?? "");
}

export type SpeechProfile = { language?: string; dialect?: string; script?: "native" | "roman" };

/**
 * Normalise what someone said or chose ("Marwari", "hindi", {language:"hi", dialect:"Maithili"}) to codes: a dialect
 * brings its base language with it. Unknown values are dropped rather than stored as free text.
 */
export function normaliseSpeech(input: { language?: unknown; dialect?: unknown; script?: unknown }): SpeechProfile {
    const out: SpeechProfile = {};
    const d = dialectInfo(input.dialect as string) ?? dialectInfo(input.language as string);
    const l = languageInfo(input.language as string);
    if (d) {
        out.dialect = d.code;
        out.language = d.base;
    } else if (l) out.language = l.code;
    if (dialectInfo(input.language as string)?.code === "kok" || String(input.language).toLowerCase() === "konkani") out.language = "kok";
    if (input.script === "roman" || input.script === "native") out.script = input.script;
    return out;
}

/** The script a reply to this person must be written in. */
export function replyScript(p: SpeechProfile): Script {
    if (p.script === "roman") return "latin";
    return languageInfo(p.language)?.script ?? "devanagari";
}

/** "Marwari (मारवाड़ी), in Devanagari" style label for screens and prompts. */
export function speechLabel(p: SpeechProfile): string {
    const d = dialectInfo(p.dialect);
    const l = languageInfo(p.language);
    const name = d ? `${d.name} (${d.native})` : l ? `${l.name}${l.code !== "en" ? ` (${l.native})` : ""}` : "not set";
    return p.script === "roman" ? `${name}, in Roman letters` : name;
}

/** The language a voice should use for this person: the dialect (its voice maps to the base) or the language. */
export function voiceHint(p: SpeechProfile | null | undefined): string | null {
    if (!p) return null;
    return p.dialect || p.language || null;
}

/** Dialect code or name → base language (for voices and speech recognition). */
export function dialectBase(code?: string | null): string | null {
    const d = dialectInfo(code);
    if (d) return d.base;
    return languageInfo(code)?.code ?? null;
}
