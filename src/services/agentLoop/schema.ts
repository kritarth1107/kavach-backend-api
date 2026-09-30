import { PRO_KEYS, type ProDecision } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Reject extra keys, a missing say, and anything that is not one tool. */
export function parseProDecision(raw: unknown): { ok: true; value: ProDecision } | { ok: false; error: string } {
    if (!isRecord(raw)) return { ok: false, error: "not an object" };
    const extra = Object.keys(raw).filter((k) => !(PRO_KEYS as readonly string[]).includes(k));
    if (extra.length) return { ok: false, error: `extra keys: ${extra.join(",")}` };
    if (typeof raw.goal !== "string" || typeof raw.step !== "string" || typeof raw.say !== "string") {
        return { ok: false, error: "goal, step, and say must be strings" };
    }
    if (raw.tool !== null && raw.tool !== undefined && typeof raw.tool !== "string") return { ok: false, error: "tool must be a string or null" };
    if (raw.tool_args != null && !isRecord(raw.tool_args)) return { ok: false, error: "tool_args must be an object" };
    if (raw.ask != null && typeof raw.ask !== "string") return { ok: false, error: "ask must be a string or null" };
    if (typeof raw.done !== "boolean") return { ok: false, error: "done must be a boolean" };
    const facts = raw.save_facts;
    if (facts != null && !Array.isArray(facts)) return { ok: false, error: "save_facts must be a list" };
    const save_facts: Array<{ text: string }> = [];
    for (const row of facts || []) {
        if (!isRecord(row) || typeof row.text !== "string") return { ok: false, error: "save_facts text" };
        save_facts.push({ text: row.text });
    }
    return {
        ok: true,
        value: {
            goal: raw.goal,
            step: raw.step,
            tool: typeof raw.tool === "string" && raw.tool.trim() ? raw.tool.trim() : null,
            tool_args: isRecord(raw.tool_args) ? raw.tool_args : {},
            say: raw.say,
            ask: typeof raw.ask === "string" ? raw.ask : null,
            done: raw.done,
            save_facts,
        },
    };
}

/** A saved fact must be words they just said, or words a tool returned this turn. */
export function factIsSubstring(text: string, userMessage: string, toolTexts: string[]): boolean {
    const n = text.trim().toLowerCase();
    if (n.length < 2) return false;
    const hay = [userMessage, ...toolTexts].join("\n").toLowerCase();
    return hay.includes(n);
}
