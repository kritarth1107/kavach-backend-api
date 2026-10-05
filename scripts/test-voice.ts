/** Voice: what gets spoken is clean (no emoji, links, markdown); the transcript keeps how sure the engine was. */
import { languageCodeFor, parseScribe, speakable, sttLanguageCodes, sttOrder } from "../src/channels/voicePipeline";
import { shouldVoiceReply } from "../src/services/whatsappRouting.service";
import { VOICE_NOT_CAUGHT_REPLY } from "../src/services/saheliElderFacts.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

ok("emoji removed", speakable("Bahut accha 🙏😊 Kamla ji!") === "Bahut accha Kamla ji!", speakable("Bahut accha 🙏😊 Kamla ji!"));
ok("flags and joined emoji removed", speakable("Done 👨‍👩‍👧 🇮🇳") === "Done", speakable("Done 👨‍👩‍👧 🇮🇳"));
ok("links dropped", !speakable("Card yahan hai: https://app.kavach.care/e/abc123 dekhiye").includes("http"));
ok("markdown stars and bullets gone", speakable("*Metformin* 500 mg\n- subah 8 baje\n- raat 9 baje") === "Metformin 500 mg. subah 8 baje. raat 9 baje",
    speakable("*Metformin* 500 mg\n- subah 8 baje\n- raat 9 baje"));
ok("numbered list gone", speakable("1. Pehla\n2) Doosra") === "Pehla. Doosra", speakable("1. Pehla\n2) Doosra"));
ok("Hindi kept", speakable("दवाई ले ली? 🙂") === "दवाई ले ली?", speakable("दवाई ले ली? 🙂"));
ok("only emoji → nothing to speak", speakable("🙏") === "");
ok("numbers and doses kept", speakable("BP 130/80, aadhi goli") === "BP 130/80, aadhi goli");

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

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
