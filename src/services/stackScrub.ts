/**
 * Last line of defence: no user-facing WhatsApp text may reveal the tech stack (browser automation,
 * model / vendor names, servers, APIs, dry-run hosts…). Known phrasings are rewritten into plain
 * words; any leftover sentence that still names the stack is dropped.
 */
const REWRITES: Array<[RegExp, string]> = [
    [/\s*\((?:the )?browser can be slow\)/gi, ""],
    [/\b(blocked|is blocking|blocks) (?:the |my )?browser(?: session)?(?: \(CAPTCHA \/ bot check\))?/gi, "isn't letting me in right now"],
    [/\bshowed an error to my browser(?: \([^)]*\))?/gi, "showed an error"],
    [/\bshowed a block page to the browser/gi, "isn't letting me in right now"],
    [/\b(?:'s )?browser (?:hit an unexpected error|hit a problem)/gi, " hit a snag"],
    [/\bbrowser crashed(?: before (?:the )?login(?:-code step)?)?(?: \(Chromium\))?/gi, "hit a snag"],
    [/\btimed out (?:—\s*)?(?:while )?(?:the )?browser was busy(?: with another task)?/gi, "took too long — I was busy with another request"],
    [/\b(?:while )?(?:the )?browser was busy(?: with another task)?(?: and hit the time limit)?/gi, "I was busy with another request"],
    [/\bBrowser (?:task )?failed:[^\n]*?(?=(?:You can|Reply|$))/gi, "That didn't go through. "],
    [/\b(?:in|via|through|using) (?:my |Saheli's |a |the )?(?:private )?browser\b/gi, "for you"],
    [/\bcan'?t drive the browser right now \(AI vision unavailable\)/gi, "can't do that right now"],
    [/\bI'll shop via private browser\b/gi, "I'll shop for you"],
    [/\bbrowser order\b/gi, "order"],
];

/** Words that must never reach a user. "Gemini" alone can be a zodiac sign, so only its AI forms. */
export const STACK_WORD_RE =
    /\b(?:browser(?:[- ]use)?|chromium|playwright|puppeteer|stagehand|headless|MCP|dry[- ]?run|vertex(?: ai)?|LLM|large language model|AI model|webhook|API|backend|server|cloud run|google'?s?\W{0,3}gemini|gemini\W{0,3}(?:\d|pro|flash|ai|model|technology|tech)|chat\s?gpt|gpt-?\d|openai|anthropic|claude|grok|xai|deepmind|(?:run|built|powered|made|based)\s+(?:on|by|with|using)\s+\W{0,3}(?:google|gemini|ai\b))\b/i;

const VENDOR_RE =
    /\b(?:google'?s?\W{0,3}gemini|gemini\W{0,3}(?:\d|pro|flash|ai|model|technology|tech)|chat\s?gpt|gpt-?\d|openai|anthropic|claude|grok|deepmind|LLM|large language model|AI model|(?:run|built|powered|made|based)\s+(?:on|by|with|using)\s+\W{0,3}(?:google|gemini))\b/i;

export function hasStackWords(text: string): boolean {
    return STACK_WORD_RE.test(stripUrls(text));
}

function stripUrls(t: string): string {
    return t.replace(/https?:\/\/\S+/g, "");
}

export function scrubStack(text: string): string {
    if (!text) return text;
    let out = text;
    for (const [re, rep] of REWRITES) out = out.replace(re, rep);
    if (!hasStackWords(out)) return tidy(out);
    // She was asked what she runs on and named a model / vendor → the warm "secret recipe" line.
    if (VENDOR_RE.test(stripUrls(out)) && out.length < 600) {
        return /\b(hai|hoon|hun|main|aap|kya|nahi|toh)\b|[\u0900-\u097F]/i.test(out)
            ? "Yeh toh hamari secret recipe hai 😊 — main bas aapki madad ke liye hoon."
            : "That's our secret recipe 😊 — I'm just here to help you.";
    }
    // Drop any sentence that still names the stack (URLs are left alone).
    const lines = out.split("\n").map((line) => {
        if (!STACK_WORD_RE.test(stripUrls(line))) return line;
        const parts = line.split(/(?<=[.!?])\s+/);
        return parts.filter((p) => !STACK_WORD_RE.test(stripUrls(p))).join(" ");
    });
    const cleaned = tidy(lines.join("\n"));
    return cleaned.replace(/[\s_*—-]/g, "") ? cleaned : "Sorry, that didn't go through — reply *retry* or *cancel*.";
}

function tidy(t: string): string {
    return t
        .replace(/[ \t]{2,}/g, " ")
        .replace(/ +([.,!?])/g, "$1")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/^_\s*_$/gm, "")
        .trim();
}
