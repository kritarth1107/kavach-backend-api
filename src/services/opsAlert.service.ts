/**
 * Operational alerts to the Kavach team (founder 2026-10-13: "if reminder data is lost or spoofed, nothing else matters").
 * One email per problem key at most every `everyMs` (default 30 min), so a flood becomes one message with a count.
 * Used for: webhook signatures rejected, dose reminders that did not go, backups that failed, the reminder tick stopping.
 * The backend runs as a single instance (min = max = 1), so the throttle can live in memory.
 */

type Entry = { lastSent: number; suppressed: number };

const seen = new Map<string, Entry>();

export async function alertOps(key: string, subject: string, text: string, opts: { everyMs?: number; now?: number } = {}): Promise<{ sent: boolean; suppressed?: number; error?: string }> {
    const now = opts.now ?? Date.now();
    const every = opts.everyMs ?? 30 * 60_000;
    const entry = seen.get(key);
    if (entry && now - entry.lastSent < every) {
        entry.suppressed += 1;
        return { sent: false, suppressed: entry.suppressed };
    }
    const suppressed = entry?.suppressed ?? 0;
    seen.set(key, { lastSent: now, suppressed: 0 });
    const body = suppressed ? `${text}\n\n(${suppressed} more of these since the last email.)` : text;
    try {
        const { sendCareTeamAlert } = await import("./email.service");
        await sendCareTeamAlert(`[Kavach ops] ${subject}`, body);
        return { sent: true };
    } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 200) : "send failed";
        console.error(`[ops-alert] email failed key=${key}: ${error}`);
        return { sent: false, error };
    }
}

/** Tests only. */
export function resetOpsAlerts(): void {
    seen.clear();
}
