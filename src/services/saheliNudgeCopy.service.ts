import type { SaheliNudgeKind } from "../models/saheliNudgeLog.model";
import { type SpeechProfile } from "./language.service";

type Copy = Record<SaheliNudgeKind | "default", (who: string, title: string, time: string) => string>;

/**
 * Saheli's care nudges — written like her own child would say it: warm, respectful ("aap"), short, never nagging.
 * Every Indian language in its own script; Roman-letter Hinglish only for someone who asked for Roman letters.
 */
const COPY: Record<string, Copy> = {
    en: {
        dose_due: (w, t, h) => `${w}, it's time for ${t} (${h}). Please take it now.`,
        pre_reminder: (w, t, h) => `${w}, ${t} is coming up at ${h} 🙂`,
        missed_followup: (w, t, h) => `${w}, just checking — did ${t} (${h}) happen? If not, no worries, whenever you can 🙏`,
        completion_praise: (w, t) => `Lovely, ${w} — ${t} done today 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} is at ${h}. If you'd like help with papers or a ride, just tell me.`,
        daily_schedule: (w, t) => `Good morning, ${w} 🌸 Here's your day:\n${t}`,
        default: (w, t, h) => `${w}, a gentle reminder: ${t} at ${h}.`,
    },
    roman_hi: {
        dose_due: (w, t, h) => `${w}, abhi ${t} ka time hai (${h}). Kripya abhi le lijiye.`,
        pre_reminder: (w, t, h) => `${w}, thodi der mein ${t} ka time ho jayega (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, bas pooch rahi thi — ${t} (${h}) ho gaya? Nahi hua to koi baat nahi, abhi kar lijiye 🙏`,
        completion_praise: (w, t) => `Wah ${w}, aaj ${t} ho gaya — bahut accha kiya 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h} baje hai. Kaagaz ya gaadi ka intezaam karna ho to bata dijiye, main madad kar dungi.`,
        daily_schedule: (w, t) => `Suprabhat ${w} 🌸 Aaj ka din aise hai:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h} baje yaad se 🙂`,
    },
    hi: {
        dose_due: (w, t, h) => `${w}, अभी ${t} का समय है (${h})। कृपया अभी ले लीजिए।`,
        pre_reminder: (w, t, h) => `${w}, थोड़ी देर में ${t} का समय हो जाएगा (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, बस पूछ रही थी — ${t} (${h}) हो गया? नहीं हुआ तो कोई बात नहीं, अभी कर लीजिए 🙏`,
        completion_praise: (w, t) => `वाह ${w}, आज ${t} हो गया — बहुत अच्छा किया 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h} बजे है। कागज़ या गाड़ी का इंतज़ाम करना हो तो बता दीजिए, मैं मदद कर दूँगी।`,
        daily_schedule: (w, t) => `सुप्रभात ${w} 🌸 आज का दिन ऐसा है:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h} बजे, याद से 🙂`,
    },
    mr: {
        dose_due: (w, t, h) => `${w}, आता ${t} घेण्याची वेळ झाली आहे (${h}). कृपया आत्ता घ्या.`,
        pre_reminder: (w, t, h) => `${w}, थोड्या वेळात ${t} ची वेळ होईल (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, फक्त विचारत होते — ${t} (${h}) झालं का? नसेल झालं तर हरकत नाही, आत्ता घ्या 🙏`,
        completion_praise: (w, t) => `छान ${w}, आज ${t} झालं — खूप छान केलंत 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h} वाजता आहे. कागदपत्रं किंवा गाडीची व्यवस्था हवी असेल तर सांगा, मी मदत करेन.`,
        daily_schedule: (w, t) => `सुप्रभात ${w} 🌸 आजचा दिवस असा आहे:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h} वाजता, लक्षात ठेवा 🙂`,
    },
    bn: {
        dose_due: (w, t, h) => `${w}, এখন ${t} খাওয়ার সময় (${h})। দয়া করে এখনই খেয়ে নিন।`,
        pre_reminder: (w, t, h) => `${w}, একটু পরেই ${t} এর সময় হবে (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, একটু জিজ্ঞেস করছিলাম — ${t} (${h}) হয়েছে? না হলে চিন্তা নেই, এখন করে নিন 🙏`,
        completion_praise: (w, t) => `বাহ ${w}, আজ ${t} হয়ে গেছে — খুব ভালো করেছেন 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h}-এ। কাগজপত্র বা গাড়ির ব্যবস্থা লাগলে বলবেন, আমি সাহায্য করব।`,
        daily_schedule: (w, t) => `সুপ্রভাত ${w} 🌸 আজকের দিনটা এরকম:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h}-এ, মনে রাখবেন 🙂`,
    },
    ta: {
        dose_due: (w, t, h) => `${w}, இப்போ ${t} எடுக்கும் நேரம் (${h}). தயவுசெய்து இப்போவே எடுத்துக்கோங்க.`,
        pre_reminder: (w, t, h) => `${w}, கொஞ்ச நேரத்துல ${t} நேரம் வரும் (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, சும்மா கேட்டேன் — ${t} (${h}) ஆச்சா? இல்லைன்னா பரவாயில்லை, இப்போ எடுத்துக்கோங்க 🙏`,
        completion_praise: (w, t) => `அருமை ${w}, இன்னைக்கு ${t} ஆச்சு — ரொம்ப நல்லது 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h} மணிக்கு. ஆவணங்கள் அல்லது வண்டி ஏற்பாடு வேணும்னா சொல்லுங்க, நான் உதவுறேன்.`,
        daily_schedule: (w, t) => `காலை வணக்கம் ${w} 🌸 இன்றைய நாள் இப்படி:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h} மணிக்கு, ஞாபகம் வெச்சுக்கோங்க 🙂`,
    },
    te: {
        dose_due: (w, t, h) => `${w}, ఇప్పుడు ${t} వేసుకునే సమయం (${h}). దయచేసి ఇప్పుడే వేసుకోండి.`,
        pre_reminder: (w, t, h) => `${w}, కాసేపట్లో ${t} సమయం అవుతుంది (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, ఊరికే అడుగుతున్నా — ${t} (${h}) అయిందా? కాకపోతే పర్వాలేదు, ఇప్పుడు వేసుకోండి 🙏`,
        completion_praise: (w, t) => `బాగుంది ${w}, ఈరోజు ${t} అయింది — చాలా మంచిది 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h}కి ఉంది. పేపర్లు లేదా బండి ఏర్పాటు కావాలంటే చెప్పండి, నేను సహాయం చేస్తాను.`,
        daily_schedule: (w, t) => `శుభోదయం ${w} 🌸 ఈరోజు ఇలా ఉంది:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h}కి, గుర్తుంచుకోండి 🙂`,
    },
    kn: {
        dose_due: (w, t, h) => `${w}, ಈಗ ${t} ತೆಗೆದುಕೊಳ್ಳುವ ಸಮಯ (${h}). ದಯವಿಟ್ಟು ಈಗಲೇ ತೆಗೆದುಕೊಳ್ಳಿ.`,
        pre_reminder: (w, t, h) => `${w}, ಸ್ವಲ್ಪ ಹೊತ್ತಿನಲ್ಲಿ ${t} ಸಮಯ ಆಗುತ್ತದೆ (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, ಸುಮ್ಮನೆ ಕೇಳುತ್ತಿದ್ದೆ — ${t} (${h}) ಆಯಿತಾ? ಆಗದಿದ್ದರೆ ಪರವಾಗಿಲ್ಲ, ಈಗ ತೆಗೆದುಕೊಳ್ಳಿ 🙏`,
        completion_praise: (w, t) => `ಚೆನ್ನಾಗಿದೆ ${w}, ಇವತ್ತು ${t} ಆಯಿತು — ತುಂಬಾ ಒಳ್ಳೆಯದು 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h}ಕ್ಕೆ ಇದೆ. ದಾಖಲೆಗಳು ಅಥವಾ ವಾಹನ ವ್ಯವಸ್ಥೆ ಬೇಕಾದರೆ ಹೇಳಿ, ನಾನು ಸಹಾಯ ಮಾಡುತ್ತೇನೆ.`,
        daily_schedule: (w, t) => `ಶುಭೋದಯ ${w} 🌸 ಇವತ್ತಿನ ದಿನ ಹೀಗಿದೆ:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h}ಕ್ಕೆ, ನೆನಪಿಟ್ಟುಕೊಳ್ಳಿ 🙂`,
    },
    ml: {
        dose_due: (w, t, h) => `${w}, ഇപ്പോൾ ${t} കഴിക്കേണ്ട സമയമാണ് (${h}). ദയവായി ഇപ്പോൾ തന്നെ കഴിക്കൂ.`,
        pre_reminder: (w, t, h) => `${w}, കുറച്ചു കഴിഞ്ഞ് ${t} സമയമാകും (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, വെറുതെ ചോദിച്ചതാ — ${t} (${h}) കഴിഞ്ഞോ? ഇല്ലെങ്കിൽ സാരമില്ല, ഇപ്പോൾ കഴിക്കൂ 🙏`,
        completion_praise: (w, t) => `കൊള്ളാം ${w}, ഇന്ന് ${t} കഴിഞ്ഞു — വളരെ നല്ലത് 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h}ന് ആണ്. രേഖകളോ വണ്ടിയോ ഏർപ്പാടാക്കണമെങ്കിൽ പറയൂ, ഞാൻ സഹായിക്കാം.`,
        daily_schedule: (w, t) => `സുപ്രഭാതം ${w} 🌸 ഇന്നത്തെ ദിവസം ഇങ്ങനെയാണ്:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h}ന്, ഓർമ്മയുണ്ടല്ലോ 🙂`,
    },
    gu: {
        dose_due: (w, t, h) => `${w}, હમણાં ${t} લેવાનો સમય છે (${h}). મહેરબાની કરીને હમણાં લઈ લો.`,
        pre_reminder: (w, t, h) => `${w}, થોડી વારમાં ${t} નો સમય થશે (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, બસ પૂછતી હતી — ${t} (${h}) થઈ ગયું? ન થયું હોય તો વાંધો નહીં, હમણાં કરી લો 🙏`,
        completion_praise: (w, t) => `વાહ ${w}, આજે ${t} થઈ ગયું — બહુ સરસ કર્યું 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h} વાગ્યે છે. કાગળો કે ગાડીની વ્યવસ્થા કરવી હોય તો કહેજો, હું મદદ કરીશ.`,
        daily_schedule: (w, t) => `સુપ્રભાત ${w} 🌸 આજનો દિવસ આવો છે:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h} વાગ્યે, યાદ રાખજો 🙂`,
    },
    pa: {
        dose_due: (w, t, h) => `${w}, ਹੁਣ ${t} ਲੈਣ ਦਾ ਸਮਾਂ ਹੈ (${h})। ਕਿਰਪਾ ਕਰਕੇ ਹੁਣੇ ਲੈ ਲਓ।`,
        pre_reminder: (w, t, h) => `${w}, ਥੋੜ੍ਹੀ ਦੇਰ ਵਿੱਚ ${t} ਦਾ ਸਮਾਂ ਹੋ ਜਾਵੇਗਾ (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, ਬੱਸ ਪੁੱਛ ਰਹੀ ਸੀ — ${t} (${h}) ਹੋ ਗਿਆ? ਨਹੀਂ ਹੋਇਆ ਤਾਂ ਕੋਈ ਗੱਲ ਨਹੀਂ, ਹੁਣੇ ਕਰ ਲਓ 🙏`,
        completion_praise: (w, t) => `ਵਾਹ ${w}, ਅੱਜ ${t} ਹੋ ਗਿਆ — ਬਹੁਤ ਵਧੀਆ ਕੀਤਾ 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h} ਵਜੇ ਹੈ। ਕਾਗਜ਼ਾਂ ਜਾਂ ਗੱਡੀ ਦਾ ਇੰਤਜ਼ਾਮ ਕਰਨਾ ਹੋਵੇ ਤਾਂ ਦੱਸ ਦਿਓ, ਮੈਂ ਮਦਦ ਕਰਾਂਗੀ।`,
        daily_schedule: (w, t) => `ਸ਼ੁਭ ਸਵੇਰ ${w} 🌸 ਅੱਜ ਦਾ ਦਿਨ ਇਸ ਤਰ੍ਹਾਂ ਹੈ:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h} ਵਜੇ, ਯਾਦ ਰੱਖਣਾ 🙂`,
    },
    or: {
        dose_due: (w, t, h) => `${w}, ଏବେ ${t} ଖାଇବା ସମୟ (${h})। ଦୟାକରି ଏବେ ଖାଇଦିଅନ୍ତୁ।`,
        pre_reminder: (w, t, h) => `${w}, ଟିକେ ପରେ ${t} ସମୟ ହେବ (${h}) 🙂`,
        missed_followup: (w, t, h) => `${w}, ଖାଲି ପଚାରୁଥିଲି — ${t} (${h}) ହେଲା କି? ନ ହୋଇଥିଲେ ଚିନ୍ତା ନାହିଁ, ଏବେ କରିନିଅନ୍ତୁ 🙏`,
        completion_praise: (w, t) => `ବାଃ ${w}, ଆଜି ${t} ହୋଇଗଲା — ବହୁତ ଭଲ କଲେ 💛`,
        appointment_prep: (w, t, h) => `${w}, ${t} ${h}ରେ ଅଛି। କାଗଜପତ୍ର କିମ୍ବା ଗାଡ଼ି ବ୍ୟବସ୍ଥା ଦରକାର ହେଲେ କୁହନ୍ତୁ, ମୁଁ ସାହାଯ୍ୟ କରିବି।`,
        daily_schedule: (w, t) => `ସୁପ୍ରଭାତ ${w} 🌸 ଆଜିର ଦିନ ଏମିତି:\n${t}`,
        default: (w, t, h) => `${w}, ${t} ${h}ରେ, ମନେ ରଖିବେ 🙂`,
    },
};

/** Old stored choices (SaheliCompanion.preferredLanguage) → a language code. */
const LEGACY: Record<string, string> = { english: "en", hindi: "hi", hinglish: "hi", tamil: "ta", kannada: "kn" };

/**
 * Which wording to use: the person's saved language (and Roman letters only if they asked), else the old companion
 * setting. Dialects use their base language's wording (Marwari → Hindi in Devanagari). Unknown → English.
 */
export function nudgeLanguage(speech?: SpeechProfile | null, preferredLanguage?: string): string {
    const lang = speech?.language || LEGACY[String(preferredLanguage ?? "").toLowerCase()] || "en";
    if (speech?.script === "roman") return lang === "hi" ? "roman_hi" : "en";
    if (lang === "ne" || lang === "kok") return "hi"; // Devanagari languages without their own wording yet
    if (lang === "as") return "bn";
    return COPY[lang] ? lang : "en";
}

/** After the Done button under a reminder: short, in their language and script (the medicine name stays as written). */
const TAKEN: Record<string, (title: string) => string> = {
    en: (t) => `Done ✅ ${t} is marked taken.`,
    roman_hi: (t) => `Ho gaya ✅ ${t} le li, maine likh liya.`,
    hi: (t) => `हो गया ✅ ${t} ले ली, मैंने लिख लिया।`,
    mr: (t) => `झालं ✅ ${t} घेतलं, मी नोंद केली.`,
    bn: (t) => `হয়ে গেছে ✅ ${t} খাওয়া হয়েছে, লিখে রাখলাম।`,
    ta: (t) => `சரி ✅ ${t} எடுத்துக்கொண்டீர்கள், குறித்துக்கொண்டேன்.`,
    te: (t) => `అయిపోయింది ✅ ${t} వేసుకున్నారు, నోట్ చేసుకున్నాను.`,
    kn: (t) => `ಆಯ್ತು ✅ ${t} ತೆಗೆದುಕೊಂಡಿದ್ದೀರಿ, ಬರೆದುಕೊಂಡೆ.`,
    ml: (t) => `ശരി ✅ ${t} കഴിച്ചു, ഞാൻ കുറിച്ചുവെച്ചു.`,
    gu: (t) => `થઈ ગયું ✅ ${t} લઈ લીધી, મેં નોંધી લીધું.`,
    pa: (t) => `ਹੋ ਗਿਆ ✅ ${t} ਲੈ ਲਈ, ਮੈਂ ਲਿਖ ਲਿਆ।`,
    or: (t) => `ହୋଇଗଲା ✅ ${t} ଖାଇଦେଲେ, ମୁଁ ଲେଖି ରଖିଲି।`,
};

export function doseTakenLine(title: string, speech?: SpeechProfile | null, preferredLanguage?: string): string {
    return (TAKEN[nudgeLanguage(speech, preferredLanguage)] ?? TAKEN.en)(title);
}

export function buildCareNudgeText(input: {
    nudgeKind: SaheliNudgeKind;
    title: string;
    time: string;
    displayName: string;
    preferredLanguage?: string;
    speech?: SpeechProfile | null;
    addressAs?: string;
}): string {
    const copy = COPY[nudgeLanguage(input.speech, input.preferredLanguage)];
    const who = input.addressAs?.trim() || input.displayName;
    const make = copy[input.nudgeKind] || copy.default;
    return make(who, input.title, input.time);
}
