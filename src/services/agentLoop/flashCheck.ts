/**
 * Flash checks the one line the elder will see.
 * Fail closed: a dish, a tech word, a resend, or a forbidden name.
 */

const DISH =
    /paneer(?:\s+butter\s+masala)?|butter masala|biryani|dal makhani|khichdi|rajma|chole|paratha|idli|dosa|samosa|halwa|kheer|pulao|palak/i;

export const TECH_WORDS = /\b(browser|model|server|api|mcp|captcha|bots?|automated)\b/i;
export const RESEND_WORDS = /resend|send (?:it|that|this) again|phir bhej|bhej dijiye/i;

export function flashCheck(input: {
    say: string;
    allowed: string[];
    forbiddenName?: string | null;
}): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const say = input.say || "";
    const allowed = input.allowed.join("\n").toLowerCase();
    const dish = say.match(DISH);
    if (dish && !allowed.includes(dish[0].toLowerCase())) reasons.push(`invented:${dish[0]}`);
    if (TECH_WORDS.test(say)) reasons.push("tech");
    if (RESEND_WORDS.test(say)) reasons.push("resend");
    const forbid = (input.forbiddenName || "").trim();
    if (forbid && new RegExp(`\\b${forbid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(say)) reasons.push("forbidden_name");
    for (const price of say.match(/₹\s?\d+(?:\.\d+)?/g) || []) {
        const token = price.replace(/\s/g, "");
        if (!allowed.replace(/\s/g, "").includes(token)) reasons.push(`invented_price:${token}`);
    }
    return { ok: reasons.length === 0, reasons };
}

export function safeLine(): string {
    return "I'm here. How are you?";
}

export function stillOnItLine(): string {
    return "I'm still on it.";
}
