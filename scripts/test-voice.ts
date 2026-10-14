/** Voice: what gets spoken is clean (no emoji, links, markdown); the transcript keeps how sure the engine was. */
import { chirpLanguageSets, languageCodeFor, parseScribe, speakable, sttLanguageCodes, sttOrder } from "../src/channels/voicePipeline";
import { shouldVoiceReply } from "../src/services/whatsappRouting.service";
import { VOICE_NOT_CAUGHT_REPLY } from "../src/services/saheliElderFacts.service";
import { isVoiceMode, wantsVoice } from "../src/services/voicePreference.service";
import { baseLanguageOf, convertToOpus, getTtsVoiceConfig, googleVoiceFor, isOggOpus, moodFromText, plainSpeech, samePoints, speechLanguage, toVoiceNote, ttsLocale, ttsOrder, withinBytes } from "../src/channels/voicePipeline";
import { voiceAudioPayload } from "../src/clients/metaWhatsApp.client";
import { singableLyrics, singPrompt, singToVoiceNote } from "../src/channels/voicePipeline";
import { spawnSync } from "node:child_process";
import { frameRate, videoFrames } from "../src/services/videoFrames";
import { keytermsFrom, MAX_KEYTERMS } from "../src/services/sttKeyterms.service";
import { wifAudience, wifServiceAccount } from "../src/clients/googleWif";
import { scribeLanguageCode, speechToTextDetailed } from "../src/channels/voicePipeline";
import { withVoiceReply } from "../src/services/whatsappRouting.service";
import { sendVoiceAfterText } from "../src/services/voiceAfterText.service";
import { chatMark, noteChatSend, sentSince } from "../src/clients/metaWhatsApp.client";
import { ChannelType } from "../src/types/careRecord.types";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

ok("emoji removed", speakable("Bahut accha 🙏😊 Kamla ji!") === "Bahut accha Kamla ji!", speakable("Bahut accha 🙏😊 Kamla ji!"));
ok("flags and joined emoji removed", speakable("Done 👨‍👩‍👧 🇮🇳") === "Done", speakable("Done 👨‍👩‍👧 🇮🇳"));
ok("links dropped", !speakable("Card yahan hai: https://app.kavach.care/e/abc123 dekhiye").includes("http"));
ok("markdown stars and bullets gone", speakable("*Metformin* 500 mg\n- subah 8 baje\n- raat 9 baje") === "Metformin 500 milligram. subah 8 baje. raat 9 baje",
    speakable("*Metformin* 500 mg\n- subah 8 baje\n- raat 9 baje"));
ok("numbered list gone", speakable("1. Pehla\n2) Doosra") === "Pehla. Doosra", speakable("1. Pehla\n2) Doosra"));
ok("Hindi kept", speakable("दवाई ले ली? 🙂") === "दवाई ले ली?", speakable("दवाई ले ली? 🙂"));
ok("only emoji → nothing to speak", speakable("🙏") === "");
ok("numbers and doses kept", speakable("BP 130/80, aadhi goli") === "B P 130 by 80, aadhi goli", speakable("BP 130/80, aadhi goli"));

// every reply to a voice note is voiced: the Brain v2 path used to return text only
const reply = { modality: "text" as const, content: "Dawai le li, bahut accha." };
ok("voice note in → voice reply", shouldVoiceReply({ mediaType: "voice" }, reply));
ok("audio file in → voice reply", shouldVoiceReply({ mediaType: "audio" }, reply));
ok("text in → text reply", !shouldVoiceReply({ text: "dawai le li" }, reply));
ok("already voiced → not twice", !shouldVoiceReply({ mediaType: "voice" }, { modality: "voice", content: "x" }));
ok("couldn't-catch fallback never spoken", !shouldVoiceReply({ mediaType: "voice" }, { modality: "text", content: VOICE_NOT_CAUGHT_REPLY }));
ok("empty reply never spoken", !shouldVoiceReply({ mediaType: "voice" }, { modality: "text", content: "  " }));

// speech-to-text in each person's own language
ok("tamil hint → ta-IN first", sttLanguageCodes("tamil")[0] === "ta-IN", sttLanguageCodes("tamil"));
ok("bengali via iso3 'ben'", languageCodeFor("ben") === "bn-IN");
ok("hinglish → Hindi + English", JSON.stringify(sttLanguageCodes("hinglish")) === JSON.stringify(["hi-IN", "en-IN"]), sttLanguageCodes("hinglish"));
ok("no hint → Hindi and Indian English", JSON.stringify(sttLanguageCodes(null)) === JSON.stringify(["hi-IN", "en-IN"]));
ok("at most 3 codes", sttLanguageCodes("marathi").length <= 3 && sttLanguageCodes("marathi")[0] === "mr-IN");
ok("chirp: bengali retried as Bengali + English, then Bengali alone (Chirp 3 refuses bn+hi+en)",
    JSON.stringify(chirpLanguageSets("bengali")) === JSON.stringify([["bn-IN", "hi-IN", "en-IN"], ["bn-IN", "en-IN"], ["bn-IN"]]), chirpLanguageSets("bengali"));
ok("chirp: hinglish needs no smaller retry list", JSON.stringify(chirpLanguageSets("hinglish")) === JSON.stringify([["hi-IN", "en-IN"], ["hi-IN"]]), chirpLanguageSets("hinglish"));
ok("punjabi uses Google's Gurmukhi code", languageCodeFor("pa-IN") === "pa-Guru-IN");
ok("unknown hint ignored", languageCodeFor("klingon") === undefined);
ok("default engine order", JSON.stringify(sttOrder({})) === JSON.stringify(["chirp", "scribe", "gemini"]));
ok("engine order from env, bad names dropped", JSON.stringify(sttOrder({ STT_ORDER: "scribe, foo, gemini" })) === JSON.stringify(["scribe", "gemini"]));
ok("chirp only, scribe backup", JSON.stringify(sttOrder({ VOICE_STT: "chirp", VOICE_GOOGLE: "off", LLM_PROVIDER_BACKEND: "bedrock", STT_ORDER: "chirp,scribe" })) === JSON.stringify(["chirp", "scribe"]));

// ElevenLabs transcript: audio tags dropped, confidence from word probabilities, language normalised
const sc = parseScribe({ text: "(background noise) Maine dawai le li", language_code: "hin",
    words: [{ text: "Maine", type: "word", logprob: -0.05 }, { text: " ", type: "spacing" }, { text: "dawai", type: "word", logprob: -0.7 }] });
ok("scribe text cleaned", sc?.text === "Maine dawai le li", sc);
ok("scribe language normalised", sc?.language === "hi-IN", sc?.language);
ok("scribe confidence from words", !!sc?.confidence && sc.confidence > 0.6 && sc.confidence < 0.8, sc?.confidence);
ok("scribe empty → null", parseScribe({ text: "(music)" }) === null);
ok("scribe without word scores → no confidence", parseScribe({ text: "haan" })?.confidence === undefined);

// the person's choice: auto (voice when they send voice), always, never
ok("always voices a typed message", shouldVoiceReply({ text: "hi" }, reply, "always"));
ok("never voices nothing", !shouldVoiceReply({ mediaType: "voice" }, reply, "never"));
ok("auto = only for voice notes", shouldVoiceReply({ mediaType: "voice" }, reply, "auto") && !shouldVoiceReply({ text: "hi" }, reply, "auto"));
ok("wantsVoice matches", wantsVoice("always", false) && !wantsVoice("never", true) && wantsVoice("auto", true) && !wantsVoice("auto", false));
ok("mode validation", isVoiceMode("always") && !isVoiceMode("loud") && !isVoiceMode(undefined));

// spoken the way people say it, in the language it is written in
ok("BP read as 'by'", speakable("BP 130/80 hai") === "B P 130 by 80 hai", speakable("BP 130/80 hai"));
ok("a date is not a BP", speakable("12/10 ko aana") === "12/10 ko aana", speakable("12/10 ko aana"));
ok("time without leading zero", speakable("subah 08:00 baje") === "subah 8:00 baje", speakable("subah 08:00 baje"));
ok("mg said in full", speakable("Metformin 500mg") === "Metformin 500 milligram", speakable("Metformin 500mg"));
ok("rupees said", speakable("Total ₹318") === "Total 318 rupaye", speakable("Total ₹318"));
ok("script → language", speechLanguage("நான் மாத்திரை சாப்பிட்டேன்") === "ta" && speechLanguage("দাওয়াই খেয়েছেন") === "bn"
    && speechLanguage("दवाई ले ली") === "hi" && speechLanguage("Dawai le li") === "latin");
process.env.ELEVENLABS_VOICE_IDS = JSON.stringify({ bn: "voice-bn" });
ok("per-language voice", getTtsVoiceConfig("bn").voiceId === "voice-bn" && getTtsVoiceConfig("hi").voiceId !== "voice-bn");
ok("one model that speaks every Indian language (v4)", getTtsVoiceConfig("bn").modelId === "eleven_v4" && getTtsVoiceConfig("hi").modelId === "eleven_v4", [getTtsVoiceConfig("bn").modelId]);
ok("elder pace, clamped", getTtsVoiceConfig().voiceSettings.speed === 0.92);
// Google voice: locale from script + the listener's language
ok("Tamil script → Tamil voice", ttsLocale("வணக்கம் அம்மா! மருந்து சாப்பிட்டீங்களா?") === "ta-IN");
ok("Bengali script → Bengali voice (not Gujarati)", ttsLocale("নমস্কার মা! ওষুধ খেয়েছেন?") === "bn-IN");
ok("Devanagari + Marathi listener → Marathi voice", ttsLocale("नमस्कार आई, औषध घेतलं का?", "mr") === "mr-IN" && ttsLocale("नमस्कार आई, औषध घेतलं का?", "marathi") === "mr-IN");
ok("Devanagari + Marwari listener → Hindi voice", ttsLocale("राम राम सा! थे दवाई ले ली कांई?", baseLanguageOf("marwari")) === "hi-IN" && baseLanguageOf("mwr") === "hi" && baseLanguageOf("tulu") === "kn");
ok("Devanagari, no hint → Hindi voice", ttsLocale("दवाई ले ली?") === "hi-IN");
ok("English → Indian English voice", ttsLocale("Good morning! Time for your medicine.") === "en-IN");
ok("Roman Hinglish → Hindi voice", ttsLocale("Namaste ji, dawai le li kya? Subah ki goli hai.") === "hi-IN" && ttsLocale("Dawai le li?", "hinglish") === "hi-IN");
ok("Gurmukhi → Punjabi voice", ttsLocale("ਸਤ ਸ੍ਰੀ ਅਕਾਲ ਮਾਂ ਜੀ") === "pa-IN");
ok("English from a Tamil listener → Indian English voice (not Hindi)", ttsLocale("Good morning! Time for your medicine.", "ta") === "en-IN" && ttsLocale("Good morning!", "marwari") === "hi-IN");
const long = "दवाई ले लीजिए। ".repeat(400);
const cut = withinBytes(long, 4800);
ok("Google TTS input kept under 5000 bytes, ending at a sentence", Buffer.byteLength(cut, "utf8") <= 4800 && cut.endsWith("।") && withinBytes("short", 4800) === "short", Buffer.byteLength(cut, "utf8"));
ok("ElevenLabs first, then Gemini, then Google", ttsOrder().join() === "eleven,gemini,google");
process.env.TTS_ORDER_BY_LANG = JSON.stringify({ bn: "eleven,google" });
ok("order per language", ttsOrder("bn-IN").join() === "eleven,google" && ttsOrder("hi-IN").join() === "eleven,gemini,google");
delete process.env.TTS_ORDER_BY_LANG;
// spoken script: same facts, pauses only for engines that use them, mood
ok("pause tags out for Chirp", plainSpeech("अच्छा [short pause] दवाई ले ली? [medium pause] ठीक है") === "अच्छा दवाई ले ली? ठीक है");
ok("spoken script keeps every number", samePoints("BP 130 by 80 hai, 8:00 baje", "देखिए [short pause] BP 130 by 80 है, 8:00 बजे") &&
    !samePoints("BP 130 by 80 hai", "BP 130 by 90 है") && samePoints("बीपी १२८ बाय ८० है", "अच्छा, बीपी 128 बाय 80 है"));
ok("spoken script not padded with new content", !samePoints("दवाई ले ली?", "दवाई ले ली? " + "और भी बहुत सारी बातें जो उसने नहीं कही थीं ".repeat(3)));
ok("worry → concerned mood without a model", moodFromText("घबराइए मत, सीने में दर्द तो नहीं?") === "concerned" && moodFromText("दवाई ले ली?") === "neutral");
ok("one Saheli voice in every language", googleVoiceFor("ta-IN").name === "ta-IN-Chirp3-HD-Kore" && googleVoiceFor("hi-IN").speakingRate === 0.95);

// pronunciation table: built-ins and TTS_SAY_AS, whole words only, any case
process.env.TTS_SAY_AS = JSON.stringify({ Ecosprin: "Eko-sprin" });
ok("say-as from env", speakable("Ecosprin le li? ecosprin khatam") === "Eko-sprin le li? Eko-sprin khatam", speakable("Ecosprin le li? ecosprin khatam"));
ok("built-in OTP spelled", speakable("OTP bhejiye") === "O T P bhejiye");
ok("not inside other words", speakable("BPL card") === "BPL card");
process.env.TTS_SAY_AS = "not json";
ok("bad table ignored", speakable("Ecosprin") === "Ecosprin");

// voice note, not an audio file: OGG/Opus + voice: true
const fakeOgg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead"), Buffer.alloc(40)]);
ok("OGG/Opus recognised", isOggOpus(fakeOgg) && !isOggOpus(Buffer.from("ID3" + "x".repeat(60))) && !isOggOpus(undefined));
ok("ogg → sent as a voice note", JSON.stringify(voiceAudioPayload("m1", "audio/ogg")) === JSON.stringify({ type: "audio", audio: { id: "m1", voice: true } }));
ok("mp3 → plain audio (WhatsApp only voices OGG/Opus)", JSON.stringify(voiceAudioPayload("m1", "audio/mpeg")) === JSON.stringify({ type: "audio", audio: { id: "m1" } }));

async function audioChecks() {
    const already = await toVoiceNote(fakeOgg, "audio/ogg");
    ok("already OGG/Opus kept as is", already.voice && already.buffer === fakeOgg);
    const saved = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = "/nonexistent/ffmpeg";
    const fallback = await toVoiceNote(Buffer.from("ID3 not really mp3"), "audio/mpeg");
    ok("no ffmpeg → still sends, as an audio file", !fallback.voice && fallback.mimeType === "audio/mpeg");
    if (saved === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = saved;
    // real conversion where ffmpeg exists (the Docker image, CI runners)
    const ff = process.env.FFMPEG_PATH || "ffmpeg";
    if (spawnSync(ff, ["-version"]).status === 0) {
        const mp3 = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "mp3", "pipe:1"]).stdout;
        const opus = await convertToOpus(mp3);
        ok("mp3 → OGG/Opus voice note (real ffmpeg)", isOggOpus(opus) && opus.length > 1000, opus.length);
        const note = await toVoiceNote(mp3, "audio/mpeg");
        ok("toVoiceNote converts", note.voice && note.mimeType === "audio/ogg");
        // a 30 s video gives 6 stills spread over all of it, not just its first seconds
        const mp4 = spawnSync(ff, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=30:size=320x240:rate=10",
            "-pix_fmt", "yuv420p", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"]).stdout;
        const frames = await videoFrames(mp4);
        ok("video → 6 stills across the whole clip (real ffmpeg)", frames.length === 6 && frames.every((f) => f[0] === 0xff && f[1] === 0xd8), frames.length);
    } else {
        console.log("· ffmpeg not installed here: real conversion checked in the Docker image");
    }
}

ok("video stills spread over its length", frameRate(30, 6) === "6/30.00" && frameRate(0.4, 6) === "6/1.00");
ok("video of unknown length: one still a second", frameRate(null, 6) === "1" && frameRate(Number.NaN, 6) === "1");

// songs: lyrics are sung line by line as written (no spoken-script rewrite), and the prompt asks for a real tune
const bhajan = "🎶 *पायो जी म्हणे राम रतन धन पायो।*\n\nवस्तु अमोलक दी म्हारे सतगुरु, किरपा कर अपणायो॥ 🙏";
ok("lyrics keep their lines, no emoji or markdown", singableLyrics(bhajan) === "पायो जी म्हणे राम रतन धन पायो।\nवस्तु अमोलक दी म्हारे सतगुरु, किरपा कर अपणायो॥", singableLyrics(bhajan));
ok("lyrics capped at 12 lines", singableLyrics(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")).split("\n").length === 12);
ok("only emoji → nothing to sing", singableLyrics("🎶🙏") === "");
ok("sing prompt asks for a melody, not reading", /melody/.test(singPrompt("Meera bhajan", "Marwari")) && /Do not read/.test(singPrompt("lullaby", "Hindi")) && singPrompt("lullaby", "Tamil").includes("Tamil"));

async function songChecks() {
    const none = await singToVoiceNote("🎶", { languageHint: "marwari" });
    ok("nothing singable → no audio, text kept", !none.audioBuffer && none.text === "🎶");
}

// A voiced reply never holds back its text, and a voice note overtaken by a newer message is dropped. Live 2026-10-12:
// the answer to a voice note waited for its audio, so "Shall I place it now?" arrived after "Okay, placing the order
// now", the reply to the tap that came a second later.
async function replyOrderChecks() {
    const out = { channelType: ChannelType.WHATSAPP, channelIdentifier: "+919000000123", modality: "text" as const, content: "Shall I place it now?" };
    const marked = withVoiceReply(out, "u1");
    ok("voiced reply: marked to speak after the text, no audio made yet", marked.voiceLater?.listenerUserId === "u1" && !marked.audioBuffer && marked.content === out.content);
    ok("marked reply is not voiced twice", !shouldVoiceReply({ mediaType: "voice" }, marked));
    ok("fallback copy is never marked", !withVoiceReply({ ...out, content: VOICE_NOT_CAUGHT_REPLY }, "u1").voiceLater);

    const to = "+91 90000 00123";
    noteChatSend(to); // the reply's text went out
    const mark = chatMark(to);
    ok("same chat however the number is written", chatMark("919000000123") === mark && !sentSince("+919000000123", mark));
    const sent: string[] = [];
    const audio = Buffer.from("OggS fake");
    const deps = (newerWhileSpeaking: boolean) => ({
        speak: async () => {
            if (newerWhileSpeaking) noteChatSend(to); // "Okay, placing the order now" went out meanwhile
            return { audioBuffer: audio, mimeType: "audio/ogg" };
        },
        sendAudio: async (t: string) => { sent.push(t); },
        sentSince,
    });
    ok("nothing newer → the voice note follows its text", (await sendVoiceAfterText({ to, text: "x", mark: chatMark(to) }, deps(false))) === "sent" && sent.length === 1);
    ok("a newer message went first → the old voice note is dropped", (await sendVoiceAfterText({ to, text: "x", mark: chatMark(to) }, deps(true))) === "stale" && sent.length === 1);
    ok("no voice available → nothing sent", (await sendVoiceAfterText({ to, text: "x", mark: chatMark(to) }, { ...deps(false), speak: async () => ({}) })) === "none" && sent.length === 1);
    ok("a voice failure never throws (the text is already out)", (await sendVoiceAfterText({ to, text: "x", mark: chatMark(to) }, { ...deps(false), speak: async () => { throw new Error("tts down"); } })) === "failed");
    ok("another chat's sends don't count", (() => { const m = chatMark(to); noteChatSend("+919000000999"); return !sentSince(to, m); })());
}


// Scribe v2 (STT bake-off 14 Oct 2026): it detects the language itself and listens for the family's own words
ok("scribe detects the language by default", scribeLanguageCode("bengali", {}) === undefined && scribeLanguageCode("tamil", {}) === undefined);
ok("SCRIBE_LANGUAGE=hint passes the saved language, never for Hinglish",
    scribeLanguageCode("bengali", { SCRIBE_LANGUAGE: "hint" }) === "bn" && scribeLanguageCode("hinglish", { SCRIBE_LANGUAGE: "hint" }) === undefined);
ok("STT_ORDER=scribe is Scribe only: nothing put in front (founder 14 Oct)",
    JSON.stringify(sttOrder({ VOICE_STT: "chirp", VOICE_GOOGLE: "off", GOOGLE_SERVICES: "off", STT_ORDER: "scribe" })) === JSON.stringify(["scribe"])
    && JSON.stringify(sttOrder({ VOICE_STT: "off", VOICE_GOOGLE: "off", LLM_PROVIDER_BACKEND: "bedrock", STT_ORDER: "scribe" })) === JSON.stringify(["scribe"]));
ok("an engine that is off is dropped from an explicit order",
    JSON.stringify(sttOrder({ VOICE_STT: "off", VOICE_GOOGLE: "off", GOOGLE_SERVICES: "off", STT_ORDER: "chirp,scribe" })) === JSON.stringify(["scribe"]));
ok("federation: off without an audience; one account per use",
    wifAudience({}) === null && wifServiceAccount("vertex", {}).startsWith("kavach-brain@") && wifServiceAccount("chirp", {}).startsWith("kavach-chirp@")
    && wifServiceAccount("vertex", { GOOGLE_VERTEX_SA: "x@y" }) === "x@y");
ok("scribe first, chirp as backup", JSON.stringify(sttOrder({ VOICE_STT: "chirp", VOICE_GOOGLE: "off", LLM_PROVIDER_BACKEND: "bedrock", STT_ORDER: "scribe,chirp" })) === JSON.stringify(["scribe", "chirp"]));
ok("key terms: medicines first, cleaned, no repeats",
    JSON.stringify(keytermsFrom(["Thyronorm 50", " thyronorm 50 ", "Metformin", null], ["Asha", "Asha Rao", "", "x"])) === JSON.stringify(["Thyronorm 50", "Metformin", "Asha", "Asha Rao"]));
ok("key terms capped", keytermsFrom(Array.from({ length: 90 }, (_, i) => `Med ${i}`), []).length === MAX_KEYTERMS);

async function scribeChecks() {
    const realFetch = globalThis.fetch;
    const savedKey = process.env.ELEVENLABS_API_KEY;
    const savedModel = process.env.ELEVENLABS_STT_MODEL;
    process.env.ELEVENLABS_API_KEY = "test-key";
    delete process.env.ELEVENLABS_STT_MODEL;
    let form: FormData | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ text: "माँ ने Thyronorm ले ली", language_code: "hin", language_probability: 0.97, words: [] }), { status: 200 });
    }) as typeof fetch;
    try {
        const heard = await speechToTextDetailed({ audioBase64: Buffer.from("OggS fake").toString("base64"), mimeType: "audio/ogg",
            languageHint: "hindi", keyterms: ["Thyronorm", "Metformin"], engines: ["scribe"] });
        const f = form as FormData | null;
        ok("scribe v2 gets the family's key terms and no forced language",
            heard.text.includes("Thyronorm") && f?.get("model_id") === "scribe_v2" && JSON.stringify(f?.getAll("keyterms")) === JSON.stringify(["Thyronorm", "Metformin"]) && !f?.has("language_code"),
            { model: f?.get("model_id"), keyterms: f?.getAll("keyterms"), lang: f?.get("language_code") });
    } finally {
        globalThis.fetch = realFetch;
        if (savedKey === undefined) delete process.env.ELEVENLABS_API_KEY;
        else process.env.ELEVENLABS_API_KEY = savedKey;
        if (savedModel !== undefined) process.env.ELEVENLABS_STT_MODEL = savedModel;
    }
}

void songChecks().then(audioChecks).then(replyOrderChecks).then(scribeChecks).then(() => {
    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log("all passed");
});
