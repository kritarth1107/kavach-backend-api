/**
 * Phone calls with Saheli (off unless CALLS_ENABLED=on). The voice layer (ElevenLabs Agents on an Exotel number) calls:
 *  - POST /api/calls/llm/chat/completions  as its "custom LLM" (OpenAI format, Bearer CALLS_LLM_SECRET): each turn of a live
 *    call goes to Saheli's own brain in the engine, so a call reads and writes the same care record as WhatsApp.
 *  - POST /api/calls/post-call             after the call (ElevenLabs-Signature HMAC with CALLS_WEBHOOK_SECRET): the summary
 *    goes into the ledger.
 * Call variables (family_id, person_id, call_id, purpose) come from the agent's dynamic variables.
 */
import crypto from "crypto";
import { Router, type Request, type Response } from "express";
import { aiEngineJson } from "../clients/aiEngine.client";

const router = Router();

const on = () => process.env.CALLS_ENABLED === "on";

function vars(body: Record<string, unknown>): Record<string, string> {
    const extra = (body.elevenlabs_extra_body ?? body.dynamic_variables ?? {}) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const k of ["family_id", "person_id", "call_id", "purpose"]) {
        const v = extra[k] ?? (body as Record<string, unknown>)[k];
        if (v !== undefined && v !== null) out[k] = String(v).slice(0, 100);
    }
    return out;
}

export function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** ElevenLabs-Signature: t=<unix>,v0=<hex hmac_sha256(secret, `${t}.${raw}`)>; at most 30 minutes old. */
export function validSignature(header: string | undefined, raw: Buffer | undefined, secret: string, now = Date.now()): boolean {
    if (!header || !raw || !secret) return false;
    const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=") as [string, string]));
    const t = Number(parts.t);
    if (!t || Math.abs(now / 1000 - t) > 1800 || !parts.v0) return false;
    const want = crypto.createHmac("sha256", secret).update(`${t}.${raw.toString("utf8")}`).digest("hex");
    return safeEqual(want, parts.v0);
}

router.post("/llm/chat/completions", async (req: Request, res: Response) => {
    if (!on()) return res.status(503).json({ error: "calls are off" });
    const auth = String(req.headers.authorization || "");
    const secret = process.env.CALLS_LLM_SECRET || "";
    if (!secret || !safeEqual(auth, `Bearer ${secret}`)) return res.status(401).json({ error: "unauthorized" });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const v = vars(body);
    if (!v.family_id || !v.person_id) return res.status(400).json({ error: "family_id and person_id are required call variables" });
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: string; content?: unknown }>) : [];
    const users = messages.filter((m) => m.role === "user");
    const text = users.length ? String(users[users.length - 1].content ?? "") : "";
    let reply = "";
    try {
        const out = await aiEngineJson<{ reply?: string }>("POST", "/v2/calls/turn", {
            family_id: v.family_id, person_id: v.person_id, call_id: v.call_id || `call-${Date.now()}`, text,
            turn: Math.max(0, users.length - 1), purpose: v.purpose || "talk",
        }, 25_000);
        reply = String(out?.reply || "").trim();
    } catch (err) {
        console.warn("[calls] turn failed:", err instanceof Error ? err.message : err);
        reply = "";
    }
    if (!reply || reply === "none") reply = "जी, एक पल… मैं सुन रही हूँ।";
    const id = `chatcmpl-${crypto.randomUUID()}`;
    if (body.stream === false) {
        return res.json({ id, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] });
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant", content: reply }, null);
    chunk({}, "stop");
    res.write("data: [DONE]\n\n");
    res.end();
});

router.post("/post-call", async (req: Request, res: Response) => {
    if (!on()) return res.status(503).json({ error: "calls are off" });
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    if (!validSignature(req.headers["elevenlabs-signature"] as string | undefined, raw, process.env.CALLS_WEBHOOK_SECRET || "")) {
        return res.status(401).json({ error: "bad signature" });
    }
    const data = ((req.body ?? {}).data ?? {}) as Record<string, any>;
    const dyn = (data.conversation_initiation_client_data?.dynamic_variables ?? {}) as Record<string, unknown>;
    if (!dyn.family_id || !dyn.person_id) return res.json({ ok: true, skipped: "no call variables" });
    try {
        await aiEngineJson("POST", "/v2/calls/summary", {
            family_id: String(dyn.family_id), person_id: String(dyn.person_id), call_id: String(data.conversation_id || dyn.call_id || ""),
            purpose: String(dyn.purpose || "talk"), summary: String(data.analysis?.transcript_summary || "").slice(0, 2000),
            minutes: typeof data.metadata?.call_duration_secs === "number" ? data.metadata.call_duration_secs / 60 : null,
            outcome: data.analysis?.call_successful ? String(data.analysis.call_successful) : null,
        });
    } catch (err) {
        console.warn("[calls] summary failed:", err instanceof Error ? err.message : err);
    }
    res.json({ ok: true });
});

export default router;
