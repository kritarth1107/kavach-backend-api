/**
 * Stamp short-circuit / canned elder replies with a light Saheli child-voice line
 * when companion profile (and optional memory one-liner) is available.
 * Does not alter interactive button payloads — callers stamp text only.
 */
import { getCompanionProfile } from "./saheliCompanion.service";

export type CompanionVoiceOpts = {
    familyId: string;
    recipientUserId: string;
    /** When true, skip if reply already looks like companion voice. */
    skipIfAlreadyWarm?: boolean;
};

function looksAlreadyWarm(reply: string): boolean {
    return /\b(beta|mummy|papa|amma|how are you|kaise ho|yaad|miss you|💕|😊)\b/i.test(reply.slice(0, 120));
}

function pickOpener(childName: string, relationshipLabel: string, hindi: boolean, memoryHook?: string | null): string {
    const name = childName?.trim() || "Saheli";
    const rel = relationshipLabel?.trim() || "your child";
    if (memoryHook?.trim()) {
        return hindi
            ? `${name} here (${rel}) — ${memoryHook.trim()}`
            : `${name} here (${rel}) — ${memoryHook.trim()}`;
    }
    return hindi
        ? `${name} bol rahi hoon…`
        : `Hi, it's ${name}…`;
}

/**
 * Prepend a short companion-voice line to a canned/smart reply.
 * Returns original reply if profile missing or reply empty.
 */
export async function stampCompanionVoice(
    reply: string,
    opts: CompanionVoiceOpts & { memoryHook?: string | null },
): Promise<string> {
    const text = (reply ?? "").trim();
    if (!text) return reply;
    if (opts.skipIfAlreadyWarm !== false && looksAlreadyWarm(text)) return reply;

    try {
        const profile = await getCompanionProfile(opts.familyId, opts.recipientUserId);
        if (!profile) return reply;
        const hindi =
            (profile.preferredLanguage ?? "english").toLowerCase() === "hindi" ||
            (profile.preferredLanguage ?? "").toLowerCase() === "hinglish";
        const opener = pickOpener(
            profile.childName,
            profile.relationshipLabel,
            hindi,
            opts.memoryHook,
        );
        // Avoid double-stamping exact opener
        if (text.startsWith(opener)) return reply;
        return `${opener}\n\n${text}`;
    } catch {
        return reply;
    }
}
