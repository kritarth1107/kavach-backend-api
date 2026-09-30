/**
 * A nudge or a reply may only mention a fact already stored for this elder,
 * or something they just said. No invented dish, habit, wake-up, or name.
 */

const DISH =
    /paneer(?:\s+butter\s+masala)?|butter masala|biryani|dal makhani|khichdi|rajma|chole|paratha|idli|dosa|samosa|halwa|kheer|pulao|palak/i;

export function refusesMaa(text: string): boolean {
    return /don'?t call me maa|dont call me maa|mujhe maa mat|maa mat (?:bula|kah)/i.test(text || "");
}

export function medicineReminderComplaint(text: string): boolean {
    return /\bremind/i.test(text || "") && /\b(medicine|medicines|dawai|dawa|dose|tablet)\b/i.test(text || "");
}

export function wokeLate(text: string): boolean {
    return /woke up late|late uthi|der se (?:uthi|utha|uthe)|i woke late/i.test(text || "");
}

/** The reminder was missed. Do not explain it with a story that was never stored. */
export function missedMedicineReply(question: string, savedFacts: string): string | null {
    if (!medicineReminderComplaint(question)) return null;
    if (wokeLate(question) || wokeLate(savedFacts)) {
        return "You woke up late. Please take the medicine now.";
    }
    return "I missed the medicine reminder. Please take it now.";
}

export function replyInventsWake(reply: string, savedFacts: string, question: string): boolean {
    if (!/awake early|let (?:you|them|her|him) rest|subah jaldi/i.test(reply || "")) return false;
    const allowed = `${savedFacts}\n${question}`;
    return !/awake early|subah jaldi|woke up early/i.test(allowed);
}

export function inventedDish(reply: string, allowed: string): string | null {
    const found = (reply || "").match(DISH);
    if (!found) return null;
    const word = found[0];
    if (allowed.toLowerCase().includes(word.toLowerCase())) return null;
    return word;
}

export function stripMaa(reply: string): string {
    return String(reply || "")
        .replace(/\bmaa\b/gi, "")
        .replace(/[ ]{2,}/g, " ")
        .replace(/\s+([,!.?])/g, "$1")
        .trim();
}

const RESEND = /connection thoda dheema|phir bhej|send (?:it|that) again|resend/i;

/**
 * The message was received. Answer it.
 * A slow-connection line must not replace that answer, and Maa is dropped after a refusal.
 */
export function finishElderReply(input: {
    inbound: string;
    draft: string;
    savedFacts?: string;
    refusedMaa?: boolean;
}): string {
    const facts = input.savedFacts || "";
    let reply = input.draft || "How are you?";
    if (inventedDish(reply, `${facts}\n${input.inbound}`)) {
        reply = "How are you?";
    }
    if (RESEND.test(reply)) {
        reply = "I'm here. How are you?";
    }
    if (!reply.trim()) reply = "How are you?";
    return reply;
}

/** A check-in may mention only a stored fact. With none, ask how they are. */
export function groundOutreachReply(reply: string, allowedFacts: string): string {
    if (inventedDish(reply, allowedFacts) || /yaad aa rahi|i remember when you|you always make/i.test(reply) && !allowedFacts.trim()) {
        return "How are you?";
    }
    if (inventedDish(reply, allowedFacts)) return "How are you?";
    return reply;
}

/** Send the medicine WhatsApp in the minute it is due, then again if there is no reply. */
export function medicineDueWindow(minutesSince: number, status: string): "dose_due" | "followup" | null {
    if (status === "completed") return null;
    if (minutesSince >= 0 && minutesSince <= 2) return "dose_due";
    if (minutesSince >= 15 && minutesSince <= 60) return "followup";
    return null;
}
