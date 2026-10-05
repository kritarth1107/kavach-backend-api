/** Voice: what gets spoken is clean (no emoji, links, markdown); the transcript keeps how sure the engine was. */
import { speakable } from "../src/channels/voicePipeline";
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

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
