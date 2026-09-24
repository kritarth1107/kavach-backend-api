import { aiGrepMemory } from "../clients/aiEngine.client";
import { ensureAiContext } from "./aiTenant.service";
import { buildSaheliMemoryContext } from "./saheliMemoryContext.service";

export type CommerceHealthSuggestion = {
    kind: "diet" | "medication" | "preference" | "general";
    text: string;
};

const SALT_RE = /\b(salt|namak|sodium|pickle|papad|chips|namkeen|soup|maggi|noodles|instant)\b/i;
const JUICE_SWEET_RE =
    /\b(juice|fruit\s*punch|soda|cola|coke|fanta|sprite|nimbu|sharbat|sweet|mithai|dessert|ice\s*cream|lassi)\b/i;
const BP_MEMORY_RE = /\b(blood\s*pressure|bp\b|hypertension|high\s*bp|उच्च\s*रक्तचाप|ಬಿಪಿ)\b/i;
const METFORMIN_RE = /\b(metformin|glycomet|glucophage|diabetic|diabetes|sugar\s*medicine|मेटाफॉर्मिन)\b/i;
const LOW_SODIUM_HINT =
    "Suggestion (you decide): your record notes blood pressure — low-sodium / rock salt is an option instead of regular salt.";
const METFORMIN_JUICE_HINT =
    "Suggestion (you decide): Metformin/diabetes meds are on file — sweet drinks or juice with meals can affect sugar; stick to your usual plan if unsure.";

/**
 * Pulls relevant care memory and turns it into gentle commerce suggestions.
 * Saheli only suggests — elder confirms. Never diagnoses.
 */
export async function buildCommerceHealthSuggestions(input: {
    familyId: string;
    recipientUserId: string;
    cartItemNames: string[];
}): Promise<CommerceHealthSuggestion[]> {
    const cartBlob = input.cartItemNames.filter(Boolean).join(" · ").slice(0, 400);
    if (!cartBlob.trim()) return [];

    const suggestions: CommerceHealthSuggestion[] = [];
    const seen = new Set<string>();

    const push = (s: CommerceHealthSuggestion) => {
        const key = s.text.toLowerCase();
        if (seen.has(key) || suggestions.length >= 3) return;
        seen.add(key);
        suggestions.push(s);
    };

    let memoryBlob = "";
    try {
        const ctx = await buildSaheliMemoryContext(input.familyId, input.recipientUserId);
        if (ctx?.care_record_context) memoryBlob += `\n${ctx.care_record_context}`;

        const aiCtx = await ensureAiContext(input.familyId, input.recipientUserId, "Care recipient");
        const grep = await aiGrepMemory({
            aiFamilyId: aiCtx.aiFamilyId,
            aiElderId: aiCtx.aiElderId,
            query: `blood pressure hypertension sodium salt metformin diabetes medication diet ${cartBlob}`.slice(
                0,
                400,
            ),
            limit: 8,
        });
        for (const hit of grep.hits) {
            memoryBlob += `\n${hit.kind}: ${hit.title} — ${hit.snippet}`;
        }
    } catch {
        // Best-effort — never block cart on memory outage.
    }

    const hasBp = BP_MEMORY_RE.test(memoryBlob);
    const hasMetformin = METFORMIN_RE.test(memoryBlob);
    const cartHasSaltish = SALT_RE.test(cartBlob);
    const cartHasJuiceSweet = JUICE_SWEET_RE.test(cartBlob);

    if (hasBp && cartHasSaltish) {
        push({ kind: "diet", text: LOW_SODIUM_HINT });
    } else if (hasBp && /\b(rice|roti|dal|curry|sabzi|oil|ghee)\b/i.test(cartBlob)) {
        push({
            kind: "diet",
            text: "Suggestion (you decide): BP is noted in your record — prefer less salty options if that matches your usual care plan.",
        });
    }

    if (hasMetformin && cartHasJuiceSweet) {
        push({ kind: "medication", text: METFORMIN_JUICE_HINT });
    }

    // Surface a short memory-backed preference if cart-related entity hit is clear.
    try {
        const aiCtx = await ensureAiContext(input.familyId, input.recipientUserId, "Care recipient");
        const pref = await aiGrepMemory({
            aiFamilyId: aiCtx.aiFamilyId,
            aiElderId: aiCtx.aiElderId,
            query: `preference allergy avoid ${cartBlob}`.slice(0, 300),
            limit: 3,
        });
        for (const hit of pref.hits) {
            if (hit.kind !== "preference" && hit.kind !== "medication" && hit.kind !== "condition") {
                continue;
            }
            const snippet = (hit.snippet || hit.title || "").trim().slice(0, 140);
            if (!snippet) continue;
            push({
                kind: hit.kind === "medication" ? "medication" : "preference",
                text: `Suggestion from saved notes (you decide): ${snippet}`,
            });
            break;
        }
    } catch {
        /* ignore */
    }

    return suggestions;
}

export function formatCommerceHealthSuggestionsForCopy(
    suggestions: CommerceHealthSuggestion[],
): string {
    if (!suggestions.length) return "";
    const lines = suggestions.map((s) => `• ${s.text}`);
    return `\n\n*Saheli tip — you decide:*\n${lines.join("\n")}`;
}
