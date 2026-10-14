/**
 * What the AI models and Services pages may say. Built from the engine's live routes and the backend's live
 * voice settings (GET /api/health/models). Nothing here is a default brand name: a speech engine or a Bedrock
 * row appears only when that config says it runs, or when the AWS bill has a Bedrock charge.
 */
export type OtherModel = { model: string; provider: string; use: string; billedUnder: string };

export type VoicePublic = {
    llm: string | null;
    stt: string[];
    sttModel: string | null;
    tts: string[];
    ttsModel: string | null;
};

export type LiveRoute = { provider: string; model: string; location: string };
export type LiveEngineModels = {
    llm?: string | null;
    embeddings?: string | null;
    roles?: Record<string, { routes?: LiveRoute[] }>;
};

export type AiStack = {
    gemini: boolean;
    bedrockRoutes: boolean;
    embeddingsBedrock: boolean;
    embedModel: string | null;
    geminiModel: string | null;
    location: string | null;
};

const STT_ROW: Record<string, (v: VoicePublic) => OtherModel> = {
    scribe: (v) => ({ model: v.sttModel || "scribe_v2", provider: "ElevenLabs", use: "Voice notes to text", billedUnder: "ElevenLabs" }),
    transcribe: () => ({ model: "Amazon Transcribe", provider: "AWS", use: "Voice notes to text", billedUnder: "AWS bill → Amazon Transcribe" }),
    chirp: () => ({ model: "Chirp", provider: "Google", use: "Voice notes to text", billedUnder: "Google bill → Speech-to-Text" }),
    gemini: () => ({ model: "Gemini", provider: "Gemini", use: "Voice notes to text", billedUnder: "Google bill → Vertex AI" }),
};

/** Speech, voice and embeddings that run outside the engine ledger. */
export function otherFromLive(voice: VoicePublic | null, embeddings: string | null): OtherModel[] {
    const other: OtherModel[] = [];
    if (voice) {
        for (const name of voice.stt) {
            const make = STT_ROW[name];
            other.push(make ? make(voice) : { model: name, provider: "Speech-to-text", use: "Voice notes to text", billedUnder: "Live speech-to-text order" });
        }
        if (voice.tts.includes("eleven")) {
            other.push({ model: voice.ttsModel || "eleven_v4", provider: "ElevenLabs", use: "Saheli's spoken replies", billedUnder: "ElevenLabs monthly plan" });
        }
        if (voice.tts.includes("gemini") || voice.tts.includes("google")) {
            other.push({ model: "Chirp", provider: "Google", use: "Saheli's spoken replies", billedUnder: "Google bill → text-to-speech" });
        }
    }
    const emb = (embeddings || "").trim();
    if (emb && emb !== "none") {
        const bedrock = /^bedrock:/i.test(emb) || /titan/i.test(emb);
        const model = emb.replace(/^(bedrock|vertex|azure|xai|openai):/i, "").replace(/@.*$/, "") || emb;
        other.push({
            model,
            provider: bedrock ? "Amazon Bedrock" : "Embeddings",
            use: "Memory search (embeddings)",
            billedUnder: bedrock ? "AWS bill → Amazon Bedrock" : "The embedding provider's bill",
        });
    }
    return other;
}

/** Which AI services the AWS stack actually runs, from the engine's /models answer. */
export function aiStack(models: LiveEngineModels | null): AiStack {
    const routes = Object.values(models?.roles || {}).flatMap((r) => r.routes || []);
    const gemini = routes.find((r) => r.provider === "gemini");
    const emb = (models?.embeddings || "").trim();
    return {
        gemini: !!gemini || /gemini/i.test(models?.llm || ""),
        bedrockRoutes: routes.some((r) => r.provider === "bedrock"),
        embeddingsBedrock: /^bedrock:/i.test(emb) || /titan/i.test(emb),
        embedModel: emb && emb !== "none" ? emb.replace(/^(bedrock|vertex|azure|xai|openai):/i, "").replace(/@.*$/, "") : null,
        geminiModel: gemini?.model || null,
        location: gemini?.location && gemini.location !== "global" ? gemini.location : null,
    };
}

/** A Bedrock row only when a route uses it, embeddings use it, or the bill has a Bedrock charge. */
export function showBedrockRow(ai: AiStack, hasBill: boolean): boolean {
    return ai.bedrockRoutes || ai.embeddingsBedrock || hasBill;
}

export function bedrockPurpose(ai: AiStack): string {
    if (ai.bedrockRoutes && ai.embeddingsBedrock) return `A live model route, and memory search (${ai.embedModel || "embeddings"})`;
    if (ai.bedrockRoutes) return "A live model route uses Amazon Bedrock";
    if (ai.embeddingsBedrock) return `Memory search (${ai.embedModel || "embeddings"})`;
    return "Amazon Bedrock charges on the AWS bill";
}

/** The family backend's own voice settings. Null when this process cannot ask it. */
export async function fetchVoiceHealth(): Promise<VoicePublic | null> {
    const base = (process.env.BACKEND_URL || "").replace(/\/$/, "");
    if (!base) return null;
    try {
        const res = await fetch(`${base}/api/health/models`, { signal: AbortSignal.timeout(4_000) });
        if (!res.ok) return null;
        const j = (await res.json()) as Partial<VoicePublic>;
        if (!Array.isArray(j.stt) || !Array.isArray(j.tts)) return null;
        return { llm: j.llm ?? null, stt: j.stt, sttModel: j.sttModel ?? null, tts: j.tts, ttsModel: j.ttsModel ?? null };
    } catch {
        return null;
    }
}
