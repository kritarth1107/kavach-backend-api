/**
 * Amazon Bedrock (Converse API) for the AWS copy (LLM_PROVIDER_BACKEND=bedrock): the same calls vertexGenerateText makes,
 * text, JSON and a photo or PDF read with the prompt. Credentials come from the default AWS chain (the ECS task role).
 *
 * People's data stays in India: only India-resident ids are used (`in.*` inference profiles or plain model ids served
 * from ap-south-1). A cross-region id (global., apac., us., eu.…) is replaced by the India default.
 *
 *   BEDROCK_REGION        default ap-south-1
 *   BEDROCK_TEXT_MODEL    default in.moonshotai.kimi-k3
 *   BEDROCK_VISION_MODEL  default in.moonshotai.kimi-k3 (reads images; checked live 14 Oct 2026)
 *
 * Kimi K3 refuses `temperature` and document blocks (checked live): a model that refuses temperature is remembered and
 * asked again without it; a PDF is sent as its text, or as page images when it has no text layer.
 */
import {
    BedrockRuntimeClient,
    ConverseCommand,
    type ContentBlock,
    type ConverseCommandOutput,
    type ImageFormat,
} from "@aws-sdk/client-bedrock-runtime";

export const BEDROCK_DEFAULT_MODEL = "in.moonshotai.kimi-k3";

export type BedrockSender = {
    send(command: ConverseCommand, options?: { abortSignal?: AbortSignal }): Promise<ConverseCommandOutput>;
};

let client: BedrockSender | null = null;

/** Tests: a fake client (null restores the real one). */
export function setBedrockClientForTests(fake: BedrockSender | null): void {
    client = fake;
}

function bedrock(): BedrockSender {
    client ??= new BedrockRuntimeClient({ region: bedrockRegion(), maxAttempts: 3 });
    return client;
}

export function bedrockRegion(env: NodeJS.ProcessEnv = process.env): string {
    return env.BEDROCK_REGION?.trim() || "ap-south-1";
}

const CROSS_REGION = /^(global|apac|us|us-gov|eu|jp|au|ca)\./i;

/** An India-resident model id: the env value unless it routes outside India, else the default. */
export function indiaModelId(raw: string | undefined): string {
    const id = (raw || "").trim();
    if (!id) return BEDROCK_DEFAULT_MODEL;
    if (CROSS_REGION.test(id)) {
        console.warn(`bedrock: ${id} routes outside India; using ${BEDROCK_DEFAULT_MODEL}`);
        return BEDROCK_DEFAULT_MODEL;
    }
    return id;
}

export function bedrockTextModel(env: NodeJS.ProcessEnv = process.env): string {
    return indiaModelId(env.BEDROCK_TEXT_MODEL);
}

export function bedrockVisionModel(env: NodeJS.ProcessEnv = process.env): string {
    return indiaModelId(env.BEDROCK_VISION_MODEL);
}

const IMAGE_FORMATS: Record<string, ImageFormat> = {
    "image/jpeg": "jpeg", "image/jpg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
};

/** Reasoning models spend output tokens thinking first; a caller's small Gemini budget would cut the answer off. */
function minOutputTokens(): number {
    const n = Number(process.env.BEDROCK_MIN_OUTPUT_TOKENS);
    return Number.isFinite(n) && n > 0 ? n : 2048;
}

const temperatureRejected = new Set<string>();

/** A PDF as the model can take it: its text when it has a text layer, else its first pages as images. */
export async function pdfForModel(data: Buffer): Promise<{ text?: string; pages?: Buffer[] }> {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data });
    try {
        const text = ((await parser.getText()).text || "").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
        if (text.replace(/\s/g, "").length >= 40) return { text: text.slice(0, 60_000) };
        const pages = Math.max(1, Math.min(10, Number(process.env.BEDROCK_PDF_PAGES) || 4));
        const shots = await parser.getScreenshot({ first: pages, scale: 1.5, imageBuffer: true, imageDataUrl: false });
        return { pages: shots.pages.map((p) => Buffer.from(p.data)).filter((b) => b.length) };
    } finally {
        await parser.destroy().catch(() => undefined);
    }
}

export type BedrockInput = {
    prompt: string;
    system?: string;
    json?: boolean;
    responseSchema?: Record<string, unknown>;
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    inlineData?: { mimeType: string; data: string };
    /** A Bedrock model id instead of the env default (never a Gemini name). */
    bedrockModel?: string;
};

export type BedrockResult = { text: string | null; model: string; error?: string };

/** One Converse call. Never throws: a failure comes back as `error` with text null. */
export async function bedrockGenerateText(input: BedrockInput): Promise<BedrockResult> {
    const file = input.inlineData;
    const model = input.bedrockModel || (file ? bedrockVisionModel() : bedrockTextModel());
    const content: ContentBlock[] = [];
    let prompt = input.prompt;
    if (file) {
        const mime = file.mimeType.split(";")[0].trim().toLowerCase();
        const bytes = Buffer.from(file.data, "base64");
        if (IMAGE_FORMATS[mime]) {
            content.push({ image: { format: IMAGE_FORMATS[mime], source: { bytes } } });
        } else if (mime === "application/pdf") {
            const pdf = await pdfForModel(bytes).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
            if ("error" in pdf) return { text: null, model, error: `pdf unreadable: ${String(pdf.error).slice(0, 160)}` };
            if (pdf.text) prompt = `${prompt}\n\nThe document's text:\n<<<\n${pdf.text}\n>>>`;
            else if (pdf.pages?.length) for (const page of pdf.pages) content.push({ image: { format: "png", source: { bytes: page } } });
            else return { text: null, model, error: "pdf has no text and no pages" };
        } else {
            return { text: null, model, error: `unsupported file type ${mime}` };
        }
    }
    content.unshift({ text: prompt });

    const wantsJson = Boolean(input.json || input.responseSchema);
    const system = [
        input.system,
        wantsJson
            ? `Reply with one JSON object only: no markdown, no code fences, no text before or after it.${input.responseSchema ? `\nIt must match this schema:\n${JSON.stringify(input.responseSchema)}` : ""}`
            : "",
    ].filter(Boolean).join("\n\n");

    const ctrl = new AbortController();
    // Kimi K3 thinks before it answers (2-6 s live): a Gemini-sized 4.5 s budget would time out on most calls.
    const floor = Number(process.env.BEDROCK_MIN_TIMEOUT_MS ?? 10_000);
    const timer = setTimeout(() => ctrl.abort(), Math.max(input.timeoutMs ?? 8000, Number.isFinite(floor) ? floor : 0));
    const send = async (withTemperature: boolean): Promise<ConverseCommandOutput> =>
        bedrock().send(
            new ConverseCommand({
                modelId: model,
                messages: [{ role: "user", content }],
                ...(system ? { system: [{ text: system }] } : {}),
                inferenceConfig: {
                    maxTokens: Math.max(input.maxOutputTokens ?? 512, minOutputTokens()),
                    ...(withTemperature ? { temperature: input.temperature ?? 0.1 } : {}),
                },
            }),
            { abortSignal: ctrl.signal },
        );
    try {
        let out: ConverseCommandOutput;
        try {
            out = await send(!temperatureRejected.has(model));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!temperatureRejected.has(model) && /temperature/i.test(msg)) {
                temperatureRejected.add(model);
                out = await send(false);
            } else throw err;
        }
        const text = (out.output?.message?.content ?? [])
            .map((b) => b.text ?? "")
            .join("")
            .trim();
        const cleaned = wantsJson ? stripFences(text) : text;
        if (!cleaned) return { text: null, model, error: `empty answer (stop ${out.stopReason ?? "?"})` };
        return { text: cleaned, model, ...(out.stopReason && out.stopReason !== "end_turn" ? { error: `stop ${out.stopReason}` } : {}) };
    } catch (err) {
        const name = err instanceof Error ? err.name : "Error";
        const msg = err instanceof Error ? err.message : String(err);
        const error = `${name} ${msg}`.replace(/\s+/g, " ").slice(0, 200);
        console.warn(`bedrock ${model} failed: ${error}`);
        return { text: null, model, error };
    } finally {
        clearTimeout(timer);
    }
}

export function stripFences(text: string): string {
    const t = text.trim();
    const m = t.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
    return (m ? m[1] : t).trim();
}
