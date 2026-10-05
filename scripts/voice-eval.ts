/**
 * Voice-note test set: 50 elder-style messages (Hindi, Hinglish, English, Tamil, Bengali, Marathi, Gujarati) with the words
 * that must survive transcription (medicine names, numbers, emergencies). Each is spoken with ElevenLabs (slowed down,
 * like an elder), transcribed with every available speech engine, and scored.
 *
 *     npx tsx scripts/voice-eval.ts               # shows what it would cost, does nothing
 *     npx tsx scripts/voice-eval.ts --yes [--out report.md] [--only scribe,gemini]
 *
 * Uses the founder's ElevenLabs plan (about 1,400 characters of speech and ~4 minutes of transcription per run); Google
 * engines only when Google Cloud access works. Synthetic voices are cleaner than real elders, so treat the scores as an
 * upper bound and add real voice notes (with consent) to the set later.
 */
import { writeFileSync } from "node:fs";
import { languageCodeFor, speechToTextDetailed, sttOrder } from "../src/channels/voicePipeline";

type Case = { lang: string; text: string; must: string[][] }; // must: each inner list = accepted spellings of one key term

const CASES: Case[] = [
    { lang: "hinglish", text: "Beta maine subah ki Metformin le li hai", must: [["metformin", "मेटफॉर्मिन"]] },
    { lang: "hinglish", text: "Aaj BP ek sau chalees by nabbe aaya", must: [["140", "chalees", "चालीस", "एक सौ चालीस"], ["90", "nabbe", "नब्बे"]] },
    { lang: "hinglish", text: "Mujhe seene mein dard ho raha hai", must: [["seene", "सीने", "sine"], ["dard", "दर्द"]] },
    { lang: "hinglish", text: "Main bathroom mein gir gayi, uth nahi pa rahi", must: [["gir", "गिर"], ["uth", "उठ"]] },
    { lang: "hinglish", text: "Amlodipine raat ko nau baje leni hai", must: [["amlodipine", "एम्लोडिपिन", "अम्लोडिपिन"], ["nau", "9", "नौ"]] },
    { lang: "hinglish", text: "Sugar do sau das aayi hai khane ke baad", must: [["210", "do sau das", "दो सौ दस"]] },
    { lang: "hinglish", text: "Thyronorm pachaas khali pet subah saat baje", must: [["thyronorm", "थायरोनॉर्म", "थायरोनोर्म"], ["7", "saat", "सात"]] },
    { lang: "hinglish", text: "Ecosprin khatam ho gayi hai, mangwa do", must: [["ecosprin", "इकोस्प्रिन", "ईकोस्प्रिन"], ["mangwa", "मंगवा"]] },
    { lang: "hinglish", text: "Ankit ko bolo kal doctor ke paas jaana hai", must: [["ankit", "अंकित"], ["doctor", "डॉक्टर"]] },
    { lang: "hinglish", text: "Aadhi goli Telma chalees ki", must: [["telma", "टेल्मा"], ["aadhi", "आधी"]] },
    { lang: "hinglish", text: "Chakkar aa raha hai aur paseena bhi", must: [["chakkar", "चक्कर"], ["paseena", "पसीना"]] },
    { lang: "hinglish", text: "Doodh se mujhe allergy hai", must: [["doodh", "दूध"], ["allergy", "एलर्जी"]] },
    { lang: "hinglish", text: "Kal raat neend nahi aayi bilkul", must: [["neend", "नींद"]] },
    { lang: "hinglish", text: "Pension aaj aayi, das hazaar", must: [["pension", "पेंशन"], ["10000", "das hazaar", "दस हजार", "दस हज़ार", "10,000"]] },
    { lang: "hinglish", text: "Mera ghutna bahut dukh raha hai", must: [["ghutna", "घुटना"]] },
    { lang: "hindi", text: "मैंने दोपहर की दवाई नहीं ली", must: [["दवाई", "davai", "dawai"]] },
    { lang: "hindi", text: "मेरी सांस फूल रही है", must: [["सांस", "साँस", "saans"]] },
    { lang: "hindi", text: "डॉक्टर ने इंसुलिन दस यूनिट कहा है", must: [["इंसुलिन", "insulin"], ["10", "दस", "das"]] },
    { lang: "hindi", text: "बेटा आज मंदिर गई थी", must: [["मंदिर", "mandir"]] },
    { lang: "hindi", text: "आज खाना अच्छा नहीं लगा", must: [["खाना", "khana"]] },
    { lang: "hindi", text: "मुझे बुखार है एक सौ दो", must: [["बुखार", "bukhar"], ["102", "एक सौ दो"]] },
    { lang: "hindi", text: "राहुल को फोन करो", must: [["राहुल", "rahul"]] },
    { lang: "hindi", text: "पापा के हाथ में ताकत नहीं है", must: [["हाथ", "haath"], ["ताकत", "ताक़त", "taakat"]] },
    { lang: "english", text: "I took my blood pressure tablet at eight", must: [["blood pressure", "bp"], ["8", "eight"]] },
    { lang: "english", text: "My sugar is one hundred and ninety", must: [["190", "one hundred and ninety", "hundred ninety"]] },
    { lang: "english", text: "Please remind me to walk at seven in the evening", must: [["walk"], ["7", "seven"]] },
    { lang: "english", text: "I have a doctor's appointment on Tuesday", must: [["tuesday"], ["appointment"]] },
    { lang: "english", text: "I feel lonely today", must: [["lonely"]] },
    { lang: "english", text: "Order Pantoprazole forty from Apollo", must: [["pantoprazole"], ["40", "forty"], ["apollo"]] },
    { lang: "english", text: "My chest feels tight", must: [["chest"], ["tight"]] },
    { lang: "tamil", text: "நான் காலை மாத்திரை சாப்பிட்டேன்", must: [["மாத்திரை"]] },
    { lang: "tamil", text: "எனக்கு தலை சுற்றுகிறது", must: [["தலை"]] },
    { lang: "tamil", text: "சர்க்கரை இருநூறு வந்தது", must: [["சர்க்கரை"], ["200", "இருநூறு"]] },
    { lang: "tamil", text: "மகனுக்கு போன் பண்ணுங்க", must: [["மகன்", "மகனுக்கு"]] },
    { lang: "tamil", text: "நெஞ்சு வலிக்குது", must: [["நெஞ்சு"]] },
    { lang: "bengali", text: "আমি সকালের ওষুধ খেয়েছি", must: [["ওষুধ"]] },
    { lang: "bengali", text: "আমার বুকে ব্যথা করছে", must: [["বুকে", "বুক"], ["ব্যথা"]] },
    { lang: "bengali", text: "প্রেসার একশো চল্লিশ", must: [["প্রেসার"], ["140", "একশো চল্লিশ"]] },
    { lang: "bengali", text: "খোকাকে ফোন করো", must: [["ফোন"]] },
    { lang: "bengali", text: "রাতে ঘুম হয়নি", must: [["ঘুম"]] },
    { lang: "marathi", text: "मी सकाळची गोळी घेतली", must: [["गोळी"]] },
    { lang: "marathi", text: "मला चक्कर येत आहे", must: [["चक्कर"]] },
    { lang: "marathi", text: "बाबांनी रात्रीची गोळी घेतली नाही", must: [["गोळी"], ["रात्री", "रात्रीची"]] },
    { lang: "marathi", text: "शुगर दोनशे आली", must: [["शुगर", "sugar"], ["200", "दोनशे"]] },
    { lang: "gujarati", text: "મેં દવા લીધી", must: [["દવા"]] },
    { lang: "gujarati", text: "મને છાતીમાં દુખે છે", must: [["છાતી", "છાતીમાં"]] },
    { lang: "hinglish", text: "Haan", must: [["haan", "हाँ", "हां", "han"]] },
    { lang: "hinglish", text: "Nahi, abhi nahi chahiye", must: [["nahi", "नहीं"]] },
    { lang: "hinglish", text: "Apollo se Dolo chhe sau pachaas mangwa do", must: [["dolo", "डोलो"], ["650", "chhe sau pachaas", "छह सौ पचास"]] },
    { lang: "hinglish", text: "Mummy ka phone nahi lag raha, chinta ho rahi hai", must: [["mummy", "मम्मी"], ["chinta", "चिंता"]] },
];

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[.,!?;:"'()\-–—]/g, " ").replace(/\s+/g, " ").trim();

function wer(ref: string, hyp: string): number {
    const r = norm(ref).split(" ").filter(Boolean);
    const h = norm(hyp).split(" ").filter(Boolean);
    const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
    for (let j = 1; j <= h.length; j++) d[0][j] = j;
    for (let i = 1; i <= r.length; i++)
        for (let j = 1; j <= h.length; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    return r.length ? d[r.length][h.length] / r.length : 0;
}

async function speak(text: string): Promise<Buffer | null> {
    const key = process.env.ELEVENLABS_API_KEY?.trim() || process.env.ELEVEN_LABS_API_KEY?.trim();
    if (!key) throw new Error("ELEVENLABS_API_KEY not set");
    const voice = process.env.ELEVENLABS_EVAL_VOICE_ID?.trim() || process.env.ELEVENLABS_VOICE_ID?.trim() || "A5W9pR9OjIbu80J0WuDW";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.7, speed: 0.85 } }),
    });
    if (!res.ok) {
        console.warn(`TTS failed ${res.status}: ${(await res.text()).slice(0, 160)}`);
        return null;
    }
    return Buffer.from(await res.arrayBuffer());
}

async function main() {
    const args = process.argv.slice(2);
    const chars = CASES.reduce((n, c) => n + c.text.length, 0);
    if (!args.includes("--yes")) {
        console.log(`Would speak ${CASES.length} messages (${chars} characters of ElevenLabs speech) and transcribe each with: ${sttOrder().join(", ")}.`);
        console.log("Nothing was sent. Run again with --yes to do it.");
        return;
    }
    const only = (args[args.indexOf("--only") + 1] || "").split(",").filter((e) => args.includes("--only") && e);
    const engines = only.length ? sttOrder({ STT_ORDER: only.join(",") }) : sttOrder();
    const rows: string[] = [];
    const score: Record<string, { n: number; wer: number; keys: number; keysOk: number; empty: number; unsure: number }> = {};
    for (const c of CASES) {
        const audio = await speak(c.text);
        if (!audio) continue;
        for (const e of engines) {
            const got = await speechToTextDetailed({ audioBuffer: audio, mimeType: "audio/mpeg", languageHint: c.lang, engines: [e] })
                .catch(() => ({ text: "", engine: "none" as const, confidence: undefined }));
            const s = (score[e] ??= { n: 0, wer: 0, keys: 0, keysOk: 0, empty: 0, unsure: 0 });
            const hit = c.must.filter((alts) => alts.some((a) => norm(got.text).includes(norm(a))));
            s.n++;
            s.wer += wer(c.text, got.text);
            s.keys += c.must.length;
            s.keysOk += hit.length;
            s.empty += got.text ? 0 : 1;
            s.unsure += typeof got.confidence === "number" && got.confidence < 0.6 ? 1 : 0;
            rows.push(`| ${c.lang} | ${e} | ${c.text} | ${got.text || "(nothing)"} | ${hit.length}/${c.must.length} |`);
        }
    }
    const lines = [
        `# Voice-note transcription test (${new Date().toISOString().slice(0, 16)})`, "",
        `${CASES.length} synthetic elder-style messages (ElevenLabs, speed 0.85). Language hint = the case's language (${languageCodeFor("tamil")} etc.).`, "",
        "| Engine | Messages | Key words heard | Word error rate | Empty | Unsure |", "| --- | --- | --- | --- | --- | --- |",
        ...Object.entries(score).map(([e, s]) =>
            `| ${e} | ${s.n} | ${((s.keysOk / Math.max(1, s.keys)) * 100).toFixed(0)}% | ${((s.wer / Math.max(1, s.n)) * 100).toFixed(0)}% | ${s.empty} | ${s.unsure} |`),
        "", "Pass bar: key words heard ≥ 90% (medicine names, numbers, emergencies); no emergency message missed.", "",
        "| Lang | Engine | Said | Heard | Key words |", "| --- | --- | --- | --- | --- |", ...rows,
    ];
    const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "";
    if (out) writeFileSync(out, lines.join("\n"));
    console.log(lines.slice(0, 8 + Object.keys(score).length).join("\n"));
}

void main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
