/**
 * Vision read for a photo or a scanned page. Printed text is preferred when the PDF already has it.
 * A tilted or dim phone photo is still attempted. Failure returns null — the file is kept, nothing is invented.
 */
import { medicalRecordFromModelJson, type MedicalRecordExtract } from "./medicalRecordExtract.service";
import { GoogleAuth } from "google-auth-library";

const PROMPT = `You read medical documents for a family caregiving app.
The page may be a photo that is slightly tilted or dim, a prescription, a lab report, or a discharge summary.
Extract ONLY words and numbers that are visible on the page. If a field is unreadable, use null. Never guess a patient, date, doctor, dose, or lab value.

Return one JSON object:
{
  "patientName": string | null,
  "recordDate": string | null,
  "provider": string | null,
  "kind": "prescription" | "lab" | "discharge" | "other",
  "medicines": [{"name": string, "dose": string | null}],
  "labs": [{"name": string, "value": string, "unit": string | null}],
  "unread": string[]
}
unread may only contain: "patient name", "date", "doctor or lab", "medicines", "lab values", "the page".
Do not add a medicine or lab value that you cannot see.`;

function visionModel(): string {
    return process.env.VERTEX_VISION_MODEL?.trim() || process.env.VERTEX_STT_MODEL?.trim() || "gemini-3.5-flash";
}

function visionLocation(): string {
    const model = visionModel().toLowerCase();
    if (model.includes("flash")) return process.env.GCP_REGION?.trim() || "asia-south1";
    return process.env.VERTEX_LOCATION?.trim() || process.env.GCP_REGION?.trim() || "asia-south1";
}

export async function readMedicalPage(buffer: Buffer, mimeType: string): Promise<MedicalRecordExtract | null> {
    const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
    if (!buffer?.length) return null;
    if (mime !== "application/pdf" && !mime.startsWith("image/")) return null;
    try {
        const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const client = await auth.getClient();
        const token = (await client.getAccessToken()).token;
        if (!token) return null;
        const project = process.env.GCP_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "kavach-care";
        const location = visionLocation();
        const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
        const url = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${visionModel()}:generateContent`;
        const res = await fetch(url, {
            method: "POST",
            signal: AbortSignal.timeout(18_000),
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
                            { text: PROMPT },
                            { inlineData: { mimeType: mime === "image/jpg" ? "image/jpeg" : mime, data: buffer.toString("base64") } },
                        ],
                    },
                ],
                generationConfig: { temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json" },
            }),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
        const raw = json.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (!raw) return null;
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start < 0 || end <= start) return null;
        return medicalRecordFromModelJson(JSON.parse(raw.slice(start, end + 1)));
    } catch {
        return null;
    }
}
