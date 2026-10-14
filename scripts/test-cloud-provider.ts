/**
 * The Google-free switch (founder decision 14 Oct 2026: the AWS copy uses Bedrock and ElevenLabs, never Google).
 * Defaults keep the GCP behaviour; LLM_PROVIDER_BACKEND=bedrock sends every model call to Bedrock (a fake client here)
 * and no Google API is fetched for voice, photos, the live check or the admin infra page.
 */
import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { googleEnabled, llmBackend, NOT_ON_GCP, voiceGoogleEnabled } from "../src/config/cloudProvider";
import { bedrockGenerateText, bedrockTextModel, bedrockVisionModel, indiaModelId, setBedrockClientForTests, stripFences, BEDROCK_DEFAULT_MODEL } from "../src/clients/bedrock.client";
import * as Vertex from "../src/clients/vertexGemini.client";
import { analyzeCareMedia } from "../src/services/saheliMediaVision.service";
import { speechToTextDetailed, sttOrder, textToSpeech, ttsOrder } from "../src/channels/voicePipeline";
import { COLLECTORS } from "../src/admin/liveCheck";
import { CloudError, gapi, onGcp } from "../src/admin/infra/google";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

type Sent = { modelId?: string; system?: Array<{ text?: string }>; messages?: Array<{ content?: Array<Record<string, unknown>> }>; inferenceConfig?: { maxTokens?: number; temperature?: number } };
const sent: Sent[] = [];
let answer: (input: Sent) => ConverseCommandOutput | Error = () => reply("ok");
function reply(text: string, extra: Partial<ConverseCommandOutput> = {}): ConverseCommandOutput {
    return { output: { message: { role: "assistant", content: [{ reasoningContent: { reasoningText: { text: "thinking" } } }, { text }] } }, stopReason: "end_turn", $metadata: {}, metrics: undefined, usage: undefined, ...extra } as ConverseCommandOutput;
}
setBedrockClientForTests({
    async send(command: ConverseCommand) {
        const input = command.input as unknown as Sent;
        sent.push(input);
        const out = answer(input);
        if (out instanceof Error) throw out;
        return out;
    },
});

// every fetch a test makes is recorded: none may go to Google when it is off
const fetched: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    fetched.push(u);
    return new Response(JSON.stringify({ error: { message: "offline test" } }), { status: 503 });
}) as typeof fetch;
const googleFetches = () => fetched.filter((u) => /googleapis\.com/.test(u));

const SWITCH_KEYS = ["LLM_PROVIDER_BACKEND", "GOOGLE_SERVICES", "VOICE_GOOGLE", "NODE_ENV", "VERTEX_DISABLED", "ELEVENLABS_API_KEY", "ELEVEN_LABS_API_KEY", "TTS_PREPARE", "BEDROCK_TEXT_MODEL", "BEDROCK_VISION_MODEL"];
const saved = Object.fromEntries(SWITCH_KEYS.map((k) => [k, process.env[k]]));
function env(vars: Record<string, string | undefined>) {
    for (const k of SWITCH_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
}

async function main() {
    // ── the switch ──
    ok("default: Vertex", llmBackend({}) === "vertex");
    ok("default: Google on", googleEnabled({}) && voiceGoogleEnabled({}));
    ok("bedrock: Bedrock", llmBackend({ LLM_PROVIDER_BACKEND: "Bedrock" }) === "bedrock");
    ok("bedrock turns Google off", !googleEnabled({ LLM_PROVIDER_BACKEND: "bedrock" }) && !voiceGoogleEnabled({ LLM_PROVIDER_BACKEND: "bedrock" }));
    ok("GOOGLE_SERVICES=on keeps Google with Bedrock", googleEnabled({ LLM_PROVIDER_BACKEND: "bedrock", GOOGLE_SERVICES: "on" }));
    ok("GOOGLE_SERVICES=off alone turns Google off", !googleEnabled({ GOOGLE_SERVICES: "off" }) && llmBackend({ GOOGLE_SERVICES: "off" }) === "vertex");
    ok("VOICE_GOOGLE=off: voice only", !voiceGoogleEnabled({ VOICE_GOOGLE: "off" }) && googleEnabled({ VOICE_GOOGLE: "off" }));
    ok("an unknown backend stays Vertex", llmBackend({ LLM_PROVIDER_BACKEND: "openai" }) === "vertex");

    // ── India-only model ids ──
    ok("default model is Kimi K3 in India", bedrockTextModel({}) === "in.moonshotai.kimi-k3" && bedrockVisionModel({}) === BEDROCK_DEFAULT_MODEL);
    ok("in.* kept", indiaModelId("in.anthropic.claude-sonnet-5") === "in.anthropic.claude-sonnet-5");
    ok("plain model id kept", bedrockVisionModel({ BEDROCK_VISION_MODEL: "qwen.qwen3-vl-235b-a22b" }) === "qwen.qwen3-vl-235b-a22b");
    ok("global. refused", indiaModelId("global.anthropic.claude-sonnet-5") === BEDROCK_DEFAULT_MODEL);
    ok("apac. refused", indiaModelId("apac.amazon.nova-pro-v1:0") === BEDROCK_DEFAULT_MODEL);
    ok("fences stripped", stripFences('```json\n{"a":1}\n```') === '{"a":1}' && stripFences("plain") === "plain");

    // ── Bedrock calls (fake client) ──
    env({ LLM_PROVIDER_BACKEND: "bedrock", NODE_ENV: "development" });
    sent.length = 0;
    answer = () => reply("```json\n{\"redFlag\":true}\n```");
    const json = await Vertex.vertexGenerateText({
        model: Vertex.GEMINI_PRO_MODEL, system: "Classify.", prompt: "Mummy ko chakkar", maxOutputTokens: 256,
        responseSchema: { type: "object", properties: { redFlag: { type: "boolean" } } }, thinkingLevel: "low",
    });
    ok("vertexGenerateText answers from Bedrock", json === '{"redFlag":true}', json);
    ok("the Gemini model name is never sent to Bedrock", sent[0]?.modelId === BEDROCK_DEFAULT_MODEL, sent[0]?.modelId);
    ok("system and JSON rule sent", /Classify\./.test(sent[0]?.system?.[0]?.text || "") && /one JSON object/.test(sent[0]?.system?.[0]?.text || "") && /redFlag/.test(sent[0]?.system?.[0]?.text || ""));
    ok("prompt sent as text", sent[0]?.messages?.[0]?.content?.[0]?.text === "Mummy ko chakkar");
    ok("a small Gemini budget is raised for a thinking model", (sent[0]?.inferenceConfig?.maxTokens ?? 0) >= 2048);
    ok("Vertex was not fetched", googleFetches().length === 0, googleFetches());

    // a model that refuses temperature is asked again without it, and remembered
    env({ LLM_PROVIDER_BACKEND: "bedrock", NODE_ENV: "development", BEDROCK_TEXT_MODEL: "in.test.no-temp" });
    sent.length = 0;
    answer = (i) => (i.inferenceConfig?.temperature !== undefined ? new Error("This model doesn't support the temperature field.") : reply("pong"));
    ok("temperature refusal → retried without", (await Vertex.vertexGenerateText({ model: "x", prompt: "ping" })) === "pong" && sent.length === 2);
    sent.length = 0;
    await Vertex.vertexGenerateText({ model: "x", prompt: "ping" });
    ok("…and not sent again", sent.length === 1 && sent[0]?.inferenceConfig?.temperature === undefined);

    // a failure is null with the reason in lastVertexError, never a throw
    answer = () => Object.assign(new Error("Too many requests"), { name: "ThrottlingException" });
    Vertex.resetVertexError();
    ok("a Bedrock failure is null", (await Vertex.vertexGenerateText({ model: "x", prompt: "ping" })) === null);
    ok("…with the reason recorded", /ThrottlingException/.test(Vertex.lastVertexError), Vertex.lastVertexError);
    answer = () => reply("", { stopReason: "max_tokens" });
    ok("an empty answer is null", (await Vertex.vertexGenerateText({ model: "x", prompt: "ping" })) === null && /max_tokens/.test(Vertex.lastVertexError));

    // a photo goes as an image block to the vision model; a PDF as its text
    env({ LLM_PROVIDER_BACKEND: "bedrock", NODE_ENV: "development", BEDROCK_VISION_MODEL: "in.test.vision" });
    sent.length = 0;
    answer = () => reply("Red");
    await Vertex.vertexGenerateText({ model: "x", prompt: "colour?", inlineData: { mimeType: "image/jpg", data: Buffer.from("fakejpeg").toString("base64") } });
    const img = sent[0]?.messages?.[0]?.content?.[1]?.image as { format?: string; source?: { bytes?: Uint8Array } } | undefined;
    ok("photo → image block on the vision model", sent[0]?.modelId === "in.test.vision" && img?.format === "jpeg" && Buffer.from(img?.source?.bytes || []).toString() === "fakejpeg", sent[0]);
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).drawText("Synthetic lab sheet: Haemoglobin 12.1 g/dL on 01-02-2026", { x: 10, y: 100, size: 9, font: await doc.embedFont(StandardFonts.Helvetica) });
    sent.length = 0;
    await bedrockGenerateText({ prompt: "Read it.", inlineData: { mimeType: "application/pdf", data: Buffer.from(await doc.save()).toString("base64") } });
    const blocks = sent[0]?.messages?.[0]?.content || [];
    ok("PDF with text → its text in the prompt, no document block", blocks.length === 1 && /Haemoglobin 12\.1/.test(String(blocks[0]?.text)), blocks);
    const odd = await bedrockGenerateText({ prompt: "x", inlineData: { mimeType: "audio/ogg", data: "AAAA" } });
    ok("an unsupported file is refused, not sent", odd.text === null && /unsupported/.test(odd.error || ""));

    // photo reading (WhatsApp care media) on Bedrock
    sent.length = 0;
    answer = () => reply('{"kind":"food","summary":"Dal and rice","nutritionNote":"Home thali","elderReplyHint":"Lovely thali!"}');
    const media = await analyzeCareMedia({ buffer: Buffer.from("fakepng"), mimeType: "image/png", caption: "lunch" });
    ok("photo reading answers from Bedrock", media?.kind === "food" && media.elderReplyHint === "Lovely thali!", media);
    ok("…with the caption in the prompt", /Elder caption: lunch/.test(String(sent[0]?.messages?.[0]?.content?.[0]?.text)));
    ok("…and no Google call", googleFetches().length === 0, googleFetches());

    // tests and the default never reach Bedrock
    env({ LLM_PROVIDER_BACKEND: "bedrock", NODE_ENV: "test" });
    sent.length = 0;
    ok("NODE_ENV=test: no model call at all", (await Vertex.vertexGenerateText({ model: "x", prompt: "p" })) === null && sent.length === 0);
    env({ NODE_ENV: "development", VERTEX_DISABLED: "1" });
    ok("default (vertex): Bedrock never called", (await Vertex.vertexGenerateText({ model: "x", prompt: "p" })) === null && sent.length === 0);

    // ── voice: ElevenLabs only ──
    env({});
    ok("default STT order unchanged", sttOrder().join(",") === "chirp,scribe,gemini");
    ok("default TTS order unchanged", ttsOrder("hi-IN").join(",") === "eleven,gemini,google");
    env({ LLM_PROVIDER_BACKEND: "bedrock", NODE_ENV: "development" });
    // an explicit STT_ORDER runs as written, minus the Google engines that are off; nothing is put in front (14 Oct)
    ok("bedrock: an explicit order keeps only the engines that are on", sttOrder({ ...process.env, STT_ORDER: "chirp,gemini,scribe" }).join(",") === "scribe");
    ok("bedrock: no order set is Transcribe then Scribe", sttOrder({ ...process.env, STT_ORDER: "" }).join(",") === "transcribe,scribe");
    ok("bedrock: TTS is ElevenLabs only", ttsOrder("hi-IN").join(",") === "eleven");
    env({ VOICE_GOOGLE: "off" });
    ok("VOICE_GOOGLE=off: Transcribe, Scribe, and ElevenLabs", sttOrder({ VOICE_GOOGLE: "off" }).join(",") === "transcribe,scribe" && ttsOrder("ta-IN").join(",") === "eleven");
    env({ LLM_PROVIDER_BACKEND: "bedrock", NODE_ENV: "development", ELEVENLABS_API_KEY: "test-key", TTS_PREPARE: "off" });
    fetched.length = 0;
    const heard = await speechToTextDetailed({ audioBuffer: Buffer.from("OggS fake"), mimeType: "audio/ogg", engines: ["chirp", "gemini", "scribe"] });
    ok("STT asks ElevenLabs only (even when Chirp/Gemini are asked for)", fetched.length === 1 && /elevenlabs\.io\/v1\/speech-to-text/.test(fetched[0]) && heard.engine === "none", fetched);
    fetched.length = 0;
    const spoken = await textToSpeech("Dawai le li?", { languageHint: "hi" });
    ok("TTS asks ElevenLabs only", fetched.length === 1 && /elevenlabs\.io\/v1\/text-to-speech/.test(fetched[0]) && !spoken.audioBuffer, fetched);

    // ── admin infra and the live check: "not on GCP", not an error ──
    ok("admin: not on GCP", !onGcp());
    const err = await gapi("https://run.googleapis.com/v2/x").then(() => null, (e: unknown) => e);
    ok("gapi refuses without asking Google", err instanceof CloudError && err.message === NOT_ON_GCP && googleFetches().length === 0);
    for (const key of ["errors", "gemini429", "cloudsql"]) {
        const item = await COLLECTORS[key](Date.now(), "hourly");
        ok(`live check ${key}: not on GCP, not a problem`, item.status === "ok" && item.value === NOT_ON_GCP && item.key === key, item);
    }
    ok("no Google API was fetched in the whole Google-off run", googleFetches().length === 0, googleFetches());
    env({});
    ok("default: admin on GCP", onGcp());
}

main()
    .catch((e) => {
        console.error(e);
        fail++;
    })
    .finally(() => {
        globalThis.fetch = realFetch;
        setBedrockClientForTests(null);
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        if (fail) {
            console.error(`${fail} failed`);
            process.exit(1);
        }
        console.log("cloud provider switch: all passed");
    });
