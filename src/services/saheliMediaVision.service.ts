/**
 * Gemini vision for WhatsApp care media (plate/food + Rx/prescription).
 * Uses gemini-3.5-flash @ asia-south1 by default (same live model as Phase 1).
 * Never diagnoses — extract printed facts / visible meal description only.
 */
import { GoogleAuth } from "google-auth-library";

export type VisionMediaKind = "food" | "prescription" | "other";

export type VisionMedication = {
    name: string;
    dosage?: string;
    time?: string;
    instructions?: string;
    frequency?: string;
};

export type VisionMediaResult = {
    kind: VisionMediaKind;
    summary: string;
    nutritionNote?: string;
    medications?: VisionMedication[];
    elderReplyHint: string;
    rawModelText?: string;
};

function gcpProjectId(): string {
    return (
        process.env.GCP_PROJECT_ID?.trim() ||
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
        "kavach-care"
    );
}

function visionLocation(): string {
    if (process.env.VERTEX_VISION_LOCATION?.trim()) {
        return process.env.VERTEX_VISION_LOCATION.trim();
    }
    // Flash is live in asia-south1; Cloud Run often sets VERTEX_LOCATION=global for Pro.
    const model = (
        process.env.VERTEX_VISION_MODEL?.trim() ||
        process.env.VERTEX_STT_MODEL?.trim() ||
        "gemini-3.5-flash"
    ).toLowerCase();
    if (model.includes("flash")) {
        return process.env.GCP_REGION?.trim() || "asia-south1";
    }
    return process.env.VERTEX_LOCATION?.trim() || process.env.GCP_REGION?.trim() || "asia-south1";
}

function visionModel(): string {
    return (
        process.env.VERTEX_VISION_MODEL?.trim() ||
        process.env.VERTEX_STT_MODEL?.trim() ||
        "gemini-3.5-flash"
    );
}

async function getAccessToken(): Promise<string | null> {
    try {
        const auth = new GoogleAuth({
            scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        });
        const client = await auth.getClient();
        const token = await client.getAccessToken();
        return token.token || null;
    } catch (err) {
        console.warn(
            "GCP access token unavailable for vision:",
            err instanceof Error ? err.message : err,
        );
        return null;
    }
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    let text = raw.trim();
    if (text.startsWith("```")) {
        text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function normalizeKind(value: unknown): VisionMediaKind {
    const k = String(value || "other").toLowerCase();
    if (k === "food" || k === "plate" || k === "meal") return "food";
    if (k === "prescription" || k === "rx" || k === "medicine" || k === "medication") {
        return "prescription";
    }
    return "other";
}

function normalizeMedications(raw: unknown): VisionMedication[] {
    if (!Array.isArray(raw)) return [];
    const out: VisionMedication[] = [];
    for (const row of raw) {
        if (!row || typeof row !== "object") continue;
        const r = row as Record<string, unknown>;
        const name = String(r.name || r.medicine || r.drug || "").trim().slice(0, 120);
        if (!name) continue;
        out.push({
            name,
            dosage: r.dosage ? String(r.dosage).trim().slice(0, 80) : undefined,
            time: r.time ? String(r.time).trim().slice(0, 40) : undefined,
            instructions: r.instructions
                ? String(r.instructions).trim().slice(0, 200)
                : undefined,
            frequency: r.frequency ? String(r.frequency).trim().slice(0, 80) : undefined,
        });
        if (out.length >= 12) break;
    }
    return out;
}

const VISION_PROMPT = `You help Saheli, a family caregiving companion in India.
Look at this image or document photo. Extract ONLY what is visible. Never diagnose, never interpret labs as high/low/normal, never invent medicines.

Respond with a single JSON object (no markdown) using exactly these keys:
- kind: "food" | "prescription" | "other"
  - food: plate, meal, snacks, groceries on a plate/bowl
  - prescription: Rx slip, medicine strip label, handwritten/printed medicine list from a doctor
  - other: anything else (ID, random photo, lab report without clear Rx, etc.)
- summary: 1 short factual sentence of what is visible (max 200 chars)
- nutritionNote: for food only — brief non-clinical meal note (e.g. "Rice, dal, sabzi — home thali"). Empty string otherwise.
- medications: for prescription only — array of {name, dosage, time, instructions, frequency}. Use only printed/handwritten names. Empty array otherwise. Prefer 24h times like "08:00" when dosage schedule is clear; else omit time.
- elderReplyHint: warm 1-2 sentence WhatsApp reply to the elder acknowledging what they shared. No diagnosis. No "saved in care record" dead-end. For Rx, say family will confirm the schedule. For food, a kind acknowledgment of the meal.

If unreadable, kind="other", short summary saying it was hard to read, and a gentle elderReplyHint asking them to type what it is.`;

export async function analyzeCareMedia(input: {
    buffer: Buffer;
    mimeType: string;
    caption?: string;
}): Promise<VisionMediaResult | null> {
    if (!input.buffer?.length) return null;
    const mime = (input.mimeType || "image/jpeg").split(";")[0].trim() || "image/jpeg";
    if (!mime.startsWith("image/") && mime !== "application/pdf") {
        return null;
    }

    const token = await getAccessToken();
    if (!token) return null;

    const project = gcpProjectId();
    const location = visionLocation();
    const model = visionModel();
    const host =
        location === "global"
            ? "https://aiplatform.googleapis.com"
            : `https://${location}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${model}:generateContent`;

    const captionLine = input.caption?.trim()
        ? `\nElder caption: ${input.caption.trim().slice(0, 300)}`
        : "";

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "x-goog-user-project": project,
        },
        body: JSON.stringify({
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: `${VISION_PROMPT}${captionLine}` },
                        {
                            inlineData: {
                                mimeType: mime,
                                data: input.buffer.toString("base64"),
                            },
                        },
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 1024,
            },
        }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`Gemini vision failed (${res.status}): ${body.slice(0, 240)}`);
        return null;
    }

    const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const rawText = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!rawText) return null;

    const parsed = parseJsonObject(rawText);
    if (!parsed) {
        return {
            kind: "other",
            summary: rawText.slice(0, 200),
            elderReplyHint: "Got your photo — tell me a bit more about it when you can.",
            rawModelText: rawText.slice(0, 500),
        };
    }

    const kind = normalizeKind(parsed.kind);
    const summary = String(parsed.summary || "").trim().slice(0, 240) || "Shared a photo.";
    const nutritionNote =
        kind === "food"
            ? String(parsed.nutritionNote || summary).trim().slice(0, 400) || undefined
            : undefined;
    const medications = kind === "prescription" ? normalizeMedications(parsed.medications) : [];
    let elderReplyHint = String(parsed.elderReplyHint || "").trim().slice(0, 400);
    if (!elderReplyHint) {
        if (kind === "food") {
            elderReplyHint = nutritionNote
                ? `Nice — noted your meal (${nutritionNote}). How was it?`
                : "Got your meal photo — thank you for sharing.";
        } else if (kind === "prescription") {
            elderReplyHint =
                medications.length > 0
                    ? `I can see ${medications.length} medicine${medications.length === 1 ? "" : "s"} on that slip. I've shared a draft with your family to confirm before we add them to the schedule.`
                    : "Got the prescription photo — I've shared it with your family to confirm.";
        } else {
            elderReplyHint = "Got your photo. Tell me what you'd like me to do with it.";
        }
    }

    return {
        kind,
        summary,
        nutritionNote,
        medications: medications.length ? medications : undefined,
        elderReplyHint,
        rawModelText: rawText.slice(0, 800),
    };
}
