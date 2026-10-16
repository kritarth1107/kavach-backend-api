/** The line the brain sees when a WhatsApp message quotes an earlier one. Media quotes are handled by the caller. */

const MAX = 400;

export function quoteText(raw: unknown): string {
    return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX);
}

export function quoteNote(q: { theirs: boolean; text?: string; mediaId?: string }): string | null {
    if (q.mediaId) return null;
    const text = quoteText(q.text);
    if (text && !q.theirs) return `They are replying to your message: ${text}`;
    if (text && q.theirs) return `They are replying to their earlier message: ${text}`;
    if (q.theirs) {
        return "They are replying to an earlier message of theirs. If it was a photo, video or document, you cannot see it now: do not guess what it showed; ask them to send it again.";
    }
    return "They are replying to one of your earlier messages.";
}
