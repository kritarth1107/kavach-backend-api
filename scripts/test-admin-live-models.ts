/**
 * The admin AI pages follow the live voice config and the engine routes.
 * Run: npx tsx scripts/test-admin-live-models.ts
 */
import assert from "node:assert/strict";
import { voicePublicConfig } from "../src/channels/voicePipeline";
import { aiStack, bedrockPurpose, otherFromLive, showBedrockRow } from "../src/admin/infra/liveModels";

const live = voicePublicConfig({
    STT_ORDER: "scribe",
    ELEVENLABS_STT_MODEL: "scribe_v2",
    GOOGLE_SERVICES: "off",
    LLM_PROVIDER_BACKEND: "vertex",
    TTS_ORDER: "elevenlabs",
} as NodeJS.ProcessEnv);
assert.deepEqual(live.stt, ["scribe"]);
assert.equal(live.sttModel, "scribe_v2");
assert.deepEqual(live.tts, ["eleven"]);
assert.equal(live.ttsModel, "eleven_v4");
assert.equal(live.llm, "vertex");

const rows = otherFromLive(live, "vertex:text-multilingual-embedding-002@asia-south1");
const names = rows.map((r) => r.model);
assert.deepEqual(names, ["scribe_v2", "eleven_v4", "text-multilingual-embedding-002"]);
assert.equal(rows.find((r) => r.use.startsWith("Memory search"))?.provider, "Google");
assert.equal(rows.some((r) => /transcribe|chirp|gpt-oss|kimi|titan|bedrock/i.test(`${r.model} ${r.provider}`)), false);

const titan = otherFromLive(live, "bedrock:amazon.titan-embed-text-v2:0@ap-south-1");
assert.equal(titan.find((r) => r.use.startsWith("Memory search"))?.provider, "Amazon Bedrock");

const withTranscribe = voicePublicConfig({ STT_ORDER: "transcribe,scribe", GOOGLE_SERVICES: "off" } as NodeJS.ProcessEnv);
assert.deepEqual(withTranscribe.stt, ["transcribe", "scribe"]);
assert.equal(otherFromLive(withTranscribe, null).some((r) => r.model === "Amazon Transcribe"), true);

const gemini = {
    llm: "router:gemini:gemini-3.5-flash@asia-south1",
    embeddings: "vertex:text-multilingual-embedding-002@asia-south1",
    roles: { brain: { routes: [{ provider: "gemini", model: "gemini-3.5-flash", location: "asia-south1" }] } },
};
const stack = aiStack(gemini);
assert.equal(stack.gemini, true);
assert.equal(stack.geminiModel, "gemini-3.5-flash");
assert.equal(stack.location, "asia-south1");
assert.equal(stack.bedrockRoutes, false);
assert.equal(stack.embeddingsBedrock, false);
assert.equal(stack.embedProvider, "vertex");
assert.equal(stack.embedModel, "text-multilingual-embedding-002");
assert.equal(showBedrockRow(stack, true), false);

const titanStack = aiStack({ embeddings: "bedrock:amazon.titan-embed-text-v2:0@ap-south-1", roles: {} });
assert.equal(titanStack.embeddingsBedrock, true);
assert.equal(showBedrockRow(titanStack, false), true);
assert.match(bedrockPurpose(titanStack), /Memory search \(amazon\.titan-embed-text-v2:0\)/);
assert.equal(/Saheli's models/.test(bedrockPurpose(titanStack)), false);

const onlyGemini = aiStack({ llm: "router", embeddings: "vertex:text-multilingual-embedding-002@asia-south1", roles: { brain: { routes: [{ provider: "gemini", model: "gemini-3.5-flash", location: "asia-south1" }] } } });
assert.equal(showBedrockRow(onlyGemini, false), false);
assert.equal(showBedrockRow(onlyGemini, true), false);

const bedrockRoute = aiStack({ roles: { brain: { routes: [{ provider: "bedrock", model: "example", location: "ap-south-1" }] } } });
assert.equal(bedrockRoute.bedrockRoutes, true);
assert.match(bedrockPurpose(bedrockRoute), /live model route/);

console.log("admin live models: ok");
