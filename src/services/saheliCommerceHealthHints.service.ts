import { careFacts } from "./engineCareFacts.service";

export type CommerceHealthSuggestion = {
    kind: "diet" | "medication" | "preference" | "general";
    text: string;
};

const SALT_RE = /\b(salt|namak|sodium|pickle|papad|chips|namkeen|soup|maggi|noodles|instant|ready\s*to\s*eat)\b/i;
const JUICE_SWEET_RE =
    /\b(juice|fruit\s*punch|soda|cola|coke|fanta|sprite|nimbu|sharbat|sweet|mithai|dessert|ice\s*cream|lassi|jalebi)\b/i;
const OTC_PAIN_RE = /\b(crocin|dolo|paracetamol|combiflam|ibrufen|ibuprofen|aspirin|disprin|saridon)\b/i;
const BP_MEMORY_RE = /\b(blood\s*pressure|bp\b|hypertension|high\s*bp|उच्च\s*रक्तचाप|ಬಿಪಿ)\b/i;
const METFORMIN_RE = /\b(metformin|glycomet|glucophage|diabetic|diabetes|sugar\s*medicine|मेटाफॉर्मिन)\b/i;
const BLOOD_THINNER_RE = /\b(warfarin|ecosprin|clopidogrel|blood\s*thinner|aspirin\s*75)\b/i;
const LOW_SODIUM_HINT =
    "Suggestion (you decide): your record notes blood pressure — low-sodium / rock salt is an option instead of regular salt.";
const METFORMIN_JUICE_HINT =
    "Suggestion (you decide): Metformin/diabetes meds are on file — sweet drinks or juice with meals can affect sugar; stick to your usual plan if unsure.";
const OTC_BP_HINT =
    "Suggestion (you decide): BP is on file — some OTC pain tablets can affect BP; stick to what your doctor already okayed if unsure.";
const OTC_THINNER_HINT =
    "Suggestion (you decide): a blood-thinner note is on file — check with your usual care plan before extra aspirin-type OTC.";

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

    // Her care record in the engine (trust plan A1: the one memory), never the retired Instinct inbox.
    let memoryBlob = "";
    try {
        const facts = await careFacts(input.familyId, input.recipientUserId, ["condition", "medicine", "diet", "allergy", "vital_target"]);
        memoryBlob = facts.map((f) => `${f.domain}: ${f.text}`).join("\n");
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

    const cartHasOtcPain = OTC_PAIN_RE.test(cartBlob);
    if (hasBp && cartHasOtcPain) {
        push({ kind: "medication", text: OTC_BP_HINT });
    }
    if (BLOOD_THINNER_RE.test(memoryBlob) && cartHasOtcPain) {
        push({ kind: "medication", text: OTC_THINNER_HINT });
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
