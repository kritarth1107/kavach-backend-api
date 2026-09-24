import type { SaheliContextBundle } from "./saheliContext.service";
import { formatScheduleSection } from "./saheliContext.service";
import { messageLooksLikeOrder } from "./saheliOrder.service";

export function messageIsGreeting(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t || t.length > 48) return false;
    return /^(hi+|hello+|hey+|hlo+|hii+|yo+|sup+|gm+|namaste+|namaskar+|good\s+(morning|evening|night|afternoon))[\s!.?]*$/i.test(
        t,
    );
}

export function respectfulElderAddress(displayName: string): string {
    const raw = (displayName || "").trim();
    if (!raw) return "";
    const lower = raw.toLowerCase();
    // Prefer existing respectful titles / family address over first-name chatbot style.
    if (/\b(amma|maa|mummy|aji|aji ji|dadi|nani|papa|baba|uncle|aunty|ji)\b/i.test(raw)) {
        return raw;
    }
    if (lower.endsWith(" ji") || /\bji$/i.test(raw)) return raw;
    // Soften bare first names: avoid "Hi Vasundara!" — use Namaste without first-name.
    return "";
}

export function buildGreetingReply(displayName: string, memoryHook?: string | null): string {
    const address = respectfulElderAddress(displayName);
    const base = address
        ? `Namaste ${address}. Good to hear from you — how are you doing today?`
        : "Namaste. Good to hear from you — how are you doing today?";
    if (memoryHook?.trim()) {
        return `${base} ${memoryHook.trim()}`;
    }
    return base;
}

/** Warm neutral when AI fails mid-thread — never a greeting. */
export function buildWarmNeutralReply(opts?: { careAware?: boolean; offline?: boolean }): string {
    if (opts?.offline) {
        return "Saheli is reconnecting — please try again in a moment.";
    }
    if (opts?.careAware) {
        return "I'm here with you. I've noted what you shared — please try again in a moment if you need anything else.";
    }
    return "I'm here — please try again in a moment.";
}

export function messageAsksMemory(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t || messageLooksLikeOrder(text)) return false;
    return (
        /\b(remember|recall|you know|bataya tha|yaad|who is|kaun hai|tell me about|mera|meri|family|grand|beta|beti|didi|bhai|medicine|dawai|tablet|doctor)\b/i.test(
            t,
        ) ||
        /\b(kya yaad|what do you know|what did i say|kya jaanti)\b/i.test(t)
    );
}

export function messageIsAcknowledgment(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!t || t.length > 32) return false;
    return /^(thanks|thank you|thx|ok|okay|k|got it|noted|cool|sure|great|perfect|understood|theek|thik|ji|haan|han)[!.?\s]*$/i.test(
        t,
    );
}

export function messageIsCasualOffer(text: string): boolean {
    const t = text.trim().toLowerCase();
    return (
        /\banything you (want|need) to know\b/.test(t) ||
        /\bdo you need (any|some)? (info|information|help)\b/.test(t) ||
        /\bkuch puchna hai\b/.test(t) ||
        /\bkya jaanna hai\b/.test(t)
    );
}

export function messageAsksSchedule(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (messageLooksLikeOrder(text) || messageIsCasualOffer(text)) return false;
    return (
        elderMissedIntent(t) ||
        /\bwhat did i miss\b/.test(t) ||
        /\bwhat('s| is) next|coming up|upcoming\b/.test(t) ||
        /\b(schedule|aaj ka|today'?s? schedule|medicine|meds|reminder|tablet)\b/.test(t) ||
        /\bschedule_today\b/.test(t)
    );
}

function elderMissedIntent(qLower: string): boolean {
    return (
        /\bwhat\s+(did\s+)?i\s+miss/i.test(qLower) ||
        (/\b(miss(ed)?|forgot|skip(ped)?|didn't|did not)\b/i.test(qLower) &&
            /\b(today|aaj|schedule|medicine|meds|check|task)\b/i.test(qLower))
    );
}

export function messageAsksHelp(text: string): boolean {
    const t = text.trim().toLowerCase();
    return /\b(help|what can you|what do you|capabilities|features|kya kar)\b/.test(t);
}

export function buildCasualOfferReply(displayName: string): string {
    return `That's sweet of you to ask, ${displayName}! I don't need anything right now — tell me how you're doing or share any news.`;
}

export function buildElderHelpReply(displayName: string): string {
    return `I'm Saheli — here for you on WhatsApp, ${displayName}.\n\n• Today's medicines and schedule\n• Order food or groceries (Swiggy, Instamart)\n• Log how you're feeling\n\nJust tell me naturally — e.g. "what's next today?" or "order milk from instamart".`;
}

export function tryHandleElderScheduleQuery(input: {
    message: string;
    context: SaheliContextBundle;
}): string | null {
    if (!messageAsksSchedule(input.message)) return null;

    const q = input.message.trim().toLowerCase();

    if (elderMissedIntent(q) || /\bwhat did i miss\b/.test(q)) {
        if (!input.context.missed.length) return "Nothing missed today.";
        return formatScheduleSection(input.context.missed, "Missed today");
    }

    if (/\bwhat('s| is) next|coming up|upcoming\b/.test(q)) {
        if (!input.context.upcoming.length) return "Nothing else scheduled for today.";
        return formatScheduleSection(input.context.upcoming, "Up next");
    }

    const parts: string[] = [];
    if (input.context.missed.length) {
        parts.push(formatScheduleSection(input.context.missed, "Missed"));
    }
    if (input.context.upcoming.length) {
        parts.push(formatScheduleSection(input.context.upcoming, "Upcoming"));
    }
    if (!parts.length) return "Nothing scheduled for today.";
    return parts.filter(Boolean).join("\n\n");
}
