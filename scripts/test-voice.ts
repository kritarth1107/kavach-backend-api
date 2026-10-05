/** Voice: what gets spoken is clean (no emoji, links, markdown); the transcript keeps how sure the engine was. */
import { languageCodeFor, parseScribe, speakable, sttLanguageCodes, sttOrder } from "../src/channels/voicePipeline";
import { shouldVoiceReply } from "../src/services/whatsappRouting.service";
import { VOICE_NOT_CAUGHT_REPLY } from "../src/services/saheliElderFacts.service";
import { isVoiceMode, wantsVoice } from "../src/services/voicePreference.service";
import { convertToOpus, getTtsVoiceConfig, isOggOpus, speechLanguage, toVoiceNote } from "../src/channels/voicePipeline";
import { voiceAudioPayload } from "../src/clients/metaWhatsApp.client";
import { spawnSync } from "node:child_process";

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
ok("punjabi uses Google's Gurmukhi code", languageCodeFor("pa-IN") === "pa-Guru-IN");
ok("unknown hint ignored", languageCodeFor("klingon") === undefined);
ok("default engine order", JSON.stringify(sttOrder({})) === JSON.stringify(["chirp", "scribe", "gemini"]));
ok("engine order from env, bad names dropped", JSON.stringify(sttOrder({ STT_ORDER: "scribe, foo, gemini" })) === JSON.stringify(["scribe", "gemini"]));

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
ok("wide model for languages v2 lacks", getTtsVoiceConfig("bn").modelId !== getTtsVoiceConfig("hi").modelId, [getTtsVoiceConfig("bn").modelId, getTtsVoiceConfig("hi").modelId]);
ok("elder pace, clamped", getTtsVoiceConfig().voiceSettings.speed === 0.9);

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
    } else {
        console.log("· ffmpeg not installed here: real conversion checked in the Docker image");
    }
}

void audioChecks().then(() => {
    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log("all passed");
});
