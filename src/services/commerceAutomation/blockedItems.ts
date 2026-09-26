/**
 * Care OS guardrail: Saheli never orders tobacco, gutka/pan masala, vapes or alcohol — on any store
 * or path (MCP, browser, Apollo). The Gemini router flags it (route.blockedItem); this keyword
 * backstop (English + Hindi/Hinglish) runs under it and on every product name before a confirm card.
 */
export type BlockedCategory = "tobacco" | "gutka" | "vape" | "alcohol";

const RULES: Array<{ cat: BlockedCategory; label: { en: string; hi: string }; re: RegExp }> = [
    {
        cat: "vape",
        label: { en: "vapes", hi: "vape" },
        re: /\b(e[\s-]?cig(?:arette)?s?|vapes?|vaping|vape\s*pens?|juul|iqos|pod\s*mods?)\b|ई-?सिगरेट/i,
    },
    {
        cat: "tobacco",
        label: { en: "cigarettes or tobacco", hi: "cigarette ya tambaku" },
        re: /\b(cig+a?rett?e?s?|ciggies?|cigs?|sutt[ae]|sutta|bid(?:i|is|ee|ees)|beedis?|cigars?|cigarillos?|hookah|huqqa|hukka|shisha|tobacco|tambaa?ku|tambakoo|chewing\s*tobacco|snuff|nasvar|marlboro|gold\s*flake|navy\s*cut|ice\s*burst|benson\s*(?:&|and)?\s*hedges|dunhill|four\s*square|wills\s*(?:classic|navy)|classic\s*(?:milds?|ice\s*burst|connect)|stella\s*(?:ice|gold)?\s*cig)\b|सिगरेट|बीड़ी|बीडी|तंबाकू|तम्बाकू|हुक्का/i,
    },
    {
        cat: "gutka",
        label: { en: "gutka or pan masala", hi: "gutka ya pan masala" },
        re: /\b(gut(?:k|kh)as?|gutka|pan\s*masala|paan\s*masala|zarda|jarda|khaini|khainee|mawa|rajnigandha|vimal\s*(?:pan|paan)?|kamla\s*pasand|manikchand|baba\s*120|tulsi\s*zarda)\b|गुटखा|पान\s*मसाला|ज़र्दा|जर्दा|खैनी/i,
    },
    {
        cat: "alcohol",
        label: { en: "alcohol", hi: "sharab" },
        re: /\b(alcohol(?:ic)?|liquor|booze|daa?ru|daroo|sharaa?b|beers?|whisk(?:e)?y|vodka|rum|gin|brandy|tequila|wines?|champagne|scotch|bourbon|breezer|old\s*monk|kingfisher|budweiser|heineken|tuborg|carlsberg|bira\s*91|royal\s*stag|imperial\s*blue|mcdowell'?s|blenders\s*pride|magic\s*moments|smirnoff|bacardi|desi\s*(?:daru|sharab)|theka|thekka)\b|शराब|दारू|बियर|व्हिस्की/i,
    },
];

// "gin" inside "ginger", "rum" in "rumali roti" etc. are excluded by \b; these food words are allowed.
const ALLOW = /\b(ginger\s*beer|root\s*beer|ginger|rumali|(?:non[\s-]?alcoholic|alcohol[\s-]?free|0\.0%?|zero\s*alcohol)(?:\s+\w+)?|wine\s*vinegar|rum\s*(?:and\s*raisin|raisin|ball)|nicotine\s*(?:gum|patch)|quit\s*smoking)\b/gi;

export function detectBlockedItem(text: string | null | undefined): { cat: BlockedCategory; label: { en: string; hi: string } } | null {
    const t = String(text || "");
    if (!t.trim()) return null;
    const cleaned = t.replace(ALLOW, " ");
    for (const r of RULES) if (r.re.test(cleaned)) return { cat: r.cat, label: r.label };
    return null;
}

const HINGLISH = /\b(mangwa|mangao|chahiye|chaiye|kar\s*do|karo|dila|lana|la\s*do|bhej|mujhe|mera|meri|hai|hain|ek|do\s*packet|wala|wali|sutta|daru|daaru|sharab|tambaku|kripya|zara)\b|[\u0900-\u097F]/i;

export function blockedLabel(cat: BlockedCategory): { en: string; hi: string } {
    return RULES.find((r) => r.cat === cat)!.label;
}

/** Short, warm refusal in the elder's language (router language, else guessed from the text). */
export function blockedReply(cat: BlockedCategory, text: string, language?: string | null): string {
    const l = blockedLabel(cat);
    const hindi = language === "hi" || language === "hinglish" || (!language && HINGLISH.test(text)) || (language === "en" && HINGLISH.test(text));
    return hindi
        ? `Maaf kijiye, ${l.hi} main order nahi kar sakti 🙏 Aapki sehat sabse zaroori hai. Kuch aur chahiye to bataiye.`
        : `Sorry, I can't order ${l.en} 🙏 Your health matters most. Is there something else I can get you?`;
}

export function isBlockedCategory(v: unknown): v is BlockedCategory {
    return v === "tobacco" || v === "gutka" || v === "vape" || v === "alcohol";
}

/** Dashboard feed only ("blocked request") — never a caregiver WhatsApp. */
export async function logBlockedRequest(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    cat: BlockedCategory;
    text: string;
    stage: string;
    source: "gemini_router" | "keywords" | "product_name";
}): Promise<void> {
    const { logActivity } = await import("../activityLog.service");
    await logActivity({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        kind: "order_interrupt",
        severity: "warn",
        title: `Blocked request: ${blockedLabel(input.cat).en}`,
        detail: input.text.slice(0, 300),
        data: { intent: "blocked_request", blocked: input.cat, stage: input.stage, source: input.source },
    }).catch(() => undefined);
}
