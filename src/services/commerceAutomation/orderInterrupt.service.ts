/**
 * Classify a new elder message that arrives while an order job is open.
 * Rules first (fast, deterministic), Gemini flash only for genuinely ambiguous text.
 *
 *   cancel      → stop safely (before Place order)
 *   change      → new item / qty / address → update draft + re-confirm
 *   status      → answer from job state
 *   flow_reply  → confirm / OTP digits / 1-2-3 / retry — handled by the order state machine
 *   unrelated   → return null so the companion answers while the order keeps running
 */
import { parseJsonLoose, vertexFlashModel, vertexGenerateText } from "../../clients/vertexGemini.client";

export type OrderInterruptIntent = "cancel" | "change" | "status" | "flow_reply" | "unrelated";

export type OrderInterrupt = {
    intent: OrderInterruptIntent;
    source: "rules" | "gemini" | "fallback";
    /** For change: new item text / qty / address hint (best-effort). */
    item?: string;
    quantity?: number;
    address?: string;
};

export type OrderPhaseForInterrupt =
    | "awaiting_sku_confirm"
    | "running"
    | "awaiting_otp"
    | "awaiting_confirm"
    | string;

const CANCEL_RE =
    /^(?:please\s+)?(cancel|stop|never ?mind|nevermind|rehne\s*do|rahne\s*do|mat\s*karo|band\s*karo|ruk\s*jao|nahi\s*chahiye|don'?t\s+order|cancel\s+(?:it|the\s+order|order|kar\s*do|karo)|stop\s+(?:it|the\s+order|ordering)|cancel\s+all(?:\s+browsing)?)[.!\s]*$/i;

const FLOW_REPLY_RE =
    /^(confirm|confirm\s*order|place|place\s*order|yes|yeah|yep|haan|han|ha|ji|ok|okay|okk|k|pay|[1-9]|\d{4,8}|retry|try\s*again|again|order\s*again|re-?order|start\s*again)[.!\s]*$/i;

const STATUS_RE =
    /\b(status|order\s*status|kahan\s*(?:hai|tak)|kab\s*(?:aayega|ayega|tak)|kitna\s*time|how\s*long|where\s*is\s*(?:my|the)\s*order|what'?s\s*happening|kya\s*hua|order\s*ka\s*kya|update\s*(?:on|about)?\s*(?:my\s*)?order|is\s*it\s*(?:done|placed)|placed\s*yet|done\s*yet|progress)\b/i;

const CHANGE_RE =
    /\b(instead|change|different|another\s+(?:one|brand|item)|not\s+this|wrong\s+(?:item|one)|dusra|doosra|badal|badlo|make\s+it\s+\d+|quantity|qty|\d+\s*(?:packs?|strips?|bottles?|units?|pcs|pieces|boxes?|kg|g|ml|l)\b|change\s+(?:the\s+)?address|deliver(?:ed|y)?\s+(?:it\s+)?(?:to|at|home)|different\s+address|new\s+address|home\s+address|my\s+address|ghar\s+(?:pe|par)|send\s+(?:it\s+)?to)\b/i;

const QUESTIONY_RE =
    /\?|^(what|why|how|when|who|where|which|can|could|would|should|do|does|is|are|tell|kya|kaise|kyun|kab|kaun|kaunsa)\b/i;

const CHATTY_RE =
    /\b(hello|hi|hey|good\s*(?:morning|night|evening|afternoon)|thank|thanks|shukriya|dhanyavaad|weather|song|joke|story|news|feel|feeling|tired|lonely|sad|happy|remind|reminder|medicine\s+time|pain|dard|doctor|bp|sugar|namaste|love|miss)\b/i;

/** Pure rules. Returns null when ambiguous. */
export function classifyOrderInterruptRules(
    text: string,
    phase: OrderPhaseForInterrupt,
): OrderInterrupt | null {
    const t = text.trim();
    if (!t) return { intent: "unrelated", source: "rules" };
    if (CANCEL_RE.test(t)) return { intent: "cancel", source: "rules" };
    if (FLOW_REPLY_RE.test(t)) return { intent: "flow_reply", source: "rules" };
    if (STATUS_RE.test(t)) return { intent: "status", source: "rules" };
    if (CHANGE_RE.test(t)) {
        const qty = t.match(/\b(\d{1,2})\s*(?:packs?|strips?|bottles?|units?|pcs|pieces|boxes?)?\b/i);
        const addr =
            t.match(/\b(?:deliver(?:ed|y)?\s+(?:it\s+)?(?:to|at)|address(?:\s+is|\s+of)?)\s+(.{4,120})$/i)?.[1] ||
            (/\b(home\s+address|my\s+address|ghar)\b/i.test(t) ? t : undefined);
        return {
            intent: "change",
            source: "rules",
            quantity: qty ? Number(qty[1]) : undefined,
            address: addr?.trim(),
        };
    }
    if (CHATTY_RE.test(t) || QUESTIONY_RE.test(t)) return { intent: "unrelated", source: "rules" };
    // SKU list open: a short noun phrase ("dolo 650", "limcee") is a new product search.
    if (phase === "awaiting_sku_confirm" && t.split(/\s+/).length <= 4 && t.length >= 3) {
        return { intent: "change", source: "rules", item: t };
    }
    return null;
}

const recent = new Map<string, { at: number; value: OrderInterrupt }>();

/** Rules → Gemini (flash) → conservative fallback. Cached ~20s per phone+text (router calls twice). */
export async function classifyOrderInterrupt(input: {
    phone: string;
    text: string;
    phase: OrderPhaseForInterrupt;
    partnerLabel?: string;
    itemHint?: string;
}): Promise<OrderInterrupt> {
    const key = `${input.phone}:${input.phase}:${input.text.trim().toLowerCase()}`;
    const hit = recent.get(key);
    if (hit && Date.now() - hit.at < 20_000) return hit.value;
    const remember = (v: OrderInterrupt) => {
        recent.set(key, { at: Date.now(), value: v });
        if (recent.size > 500) recent.delete(recent.keys().next().value as string);
        return v;
    };

    const rules = classifyOrderInterruptRules(input.text, input.phase);
    if (rules) return remember(rules);

    const raw = await vertexGenerateText({
        model: vertexFlashModel(),
        json: true,
        timeoutMs: 4500,
        maxOutputTokens: 200,
        system:
            "You route WhatsApp messages from an elderly Indian user (English/Hindi/Hinglish) who has an order in progress. " +
            'Reply ONLY JSON: {"intent":"cancel|change|status|flow_reply|unrelated","item":string|null,"quantity":number|null,"address":string|null}. ' +
            "cancel = wants to stop the order. change = wants a different item, quantity or delivery address for THIS order. " +
            "status = asks how the order is going. flow_reply = confirm/yes/OTP/number pick. " +
            "unrelated = anything else (chat, health, reminders, questions) — the order continues in the background.",
        prompt: `Order: ${input.partnerLabel || "online order"}${input.itemHint ? ` — ${input.itemHint}` : ""}\nStage: ${input.phase}\nMessage: ${input.text.trim().slice(0, 400)}`,
    });
    const parsed = parseJsonLoose<{ intent?: string; item?: string | null; quantity?: number | null; address?: string | null }>(raw);
    const intents: OrderInterruptIntent[] = ["cancel", "change", "status", "flow_reply", "unrelated"];
    if (parsed?.intent && intents.includes(parsed.intent as OrderInterruptIntent)) {
        return remember({
            intent: parsed.intent as OrderInterruptIntent,
            source: "gemini",
            item: parsed.item || undefined,
            quantity: typeof parsed.quantity === "number" ? parsed.quantity : undefined,
            address: parsed.address || undefined,
        });
    }
    // Model unavailable: never hijack a real conversation — companion answers.
    return remember({ intent: "unrelated", source: "fallback" });
}
