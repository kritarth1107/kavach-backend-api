/**
 * Is the reminder tick running? (trust plan B1.7: "if the 60-second tick stops, nobody is alerted".) The tick writes a
 * heartbeat every minute (scheduler_heartbeats, "care-nudge"); older than 3 minutes means reminders are not going out.
 * Read by the public /api/health/reminders (503 when stale, watched every minute by the Cloudflare uptime worker) and by
 * the backend's own watchdog.
 */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export async function reminderHeartbeat(now = Date.now()): Promise<{ ok: boolean; lastTickAt: string | null; ageMs: number | null }> {
    const { default: HB } = await import("../models/schedulerHeartbeat.model");
    const row = (await HB.findById("care-nudge").lean()) as { lastTickAt?: Date } | null;
    if (!row?.lastTickAt) return { ok: false, lastTickAt: null, ageMs: null };
    const ageMs = now - new Date(row.lastTickAt).getTime();
    return { ok: ageMs <= HEARTBEAT_STALE_MS, lastTickAt: new Date(row.lastTickAt).toISOString(), ageMs };
}
