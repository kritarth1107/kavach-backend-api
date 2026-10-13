import { runCareNudgeTick } from "../services/saheliCareNudge.service";
import { runSaheliReminderTick } from "../services/saheliReminder.service";

const TICK_MS = 60 * 1000;
/** A tick that has not finished in this long is stuck: the next one may start (the slot claims keep sends single). */
const STUCK_MS = 10 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let running = false;
let runningSince = 0;

async function runTick() {
    if (running) {
        if (Date.now() - runningSince < STUCK_MS) return;
        console.error(`Care nudge tick stuck for ${Math.round((Date.now() - runningSince) / 60_000)} min: starting a new one`);
    }
    running = true;
    runningSince = Date.now();
    try {
        // the day's due list (B1.4), rebuilt when a schedule or reminder changed
        const { ensureDueList } = await import("../services/dueList.service");
        await ensureDueList().catch((e) => console.warn("due list build failed:", e instanceof Error ? e.message : e));
        const result = await runCareNudgeTick();
        if (result.sent > 0 || result.scanned > 0) {
            console.log(`Care nudge tick: sent=${result.sent} scanned=${result.scanned}`);
        }
        const reminders = await runSaheliReminderTick();
        if (reminders.sent > 0 || reminders.scanned > 0) {
            console.log(
                `Saheli reminder tick: sent=${reminders.sent} scanned=${reminders.scanned}`,
            );
        }
        // Saheli-as-delegate: delivery / medicine follow-ups, abandoned-task nudge, approvals, expiry.
        const { runDelegateTick } = await import("../services/delegate/followup.service");
        void runDelegateTick().catch((e) => console.warn("delegate tick failed:", e));
        // The Gemini daily snapshot (DailySnapshot) is retired for every family: the engine's nightly brief replaces it
        // (trust plan A1).
        // the Kavach team hears about any dose that did not go or did not reach the phone (B1.5), and gets the 23:30
        // due-vs-sent report (B1.6)
        const R = await import("../services/deliveryReport.service");
        await R.runDoseAlertCheck().catch((e) => console.warn("dose alert check failed:", e instanceof Error ? e.message : e));
        const { markMissed } = await import("../services/dueList.service");
        await markMissed().catch((e) => console.warn("due list missed-marking failed:", e instanceof Error ? e.message : e));
        await R.runDailyDeliveryReport().catch((e) => console.warn("daily delivery report failed:", e instanceof Error ? e.message : e));
        // 3 unanswered proactive messages + 60 min → the caregiver hears (B2); at 09:00 the day before is checked (B2.5b)
        const E = await import("../services/escalation.service");
        await E.runEscalationTick().catch((e) => console.warn("escalation tick failed:", e instanceof Error ? e.message : e));
        await E.runEscalationCheck().catch((e) => console.warn("escalation check failed:", e instanceof Error ? e.message : e));
    } catch (err) {
        console.warn("Care nudge tick failed:", err);
    } finally {
        running = false;
    }
}

export function startCareNudgeScheduler() {
    if (process.env.SAHELI_CARE_NUDGE_ENABLED === "false") {
        console.log("Care nudge scheduler disabled (SAHELI_CARE_NUDGE_ENABLED=false)");
        return;
    }
    if (timer) return;
    console.log("Care nudge scheduler started (1m tick, includes Instinct reminders)");
    void runTick();
    timer = setInterval(() => void runTick(), TICK_MS);
    // If the tick stops (stuck, or crashing before its heartbeat), the team hears (B1.7); the uptime worker watches
    // /api/health/reminders from outside Google too.
    watchdog = setInterval(() => void checkReminderHeartbeat().catch(() => undefined), TICK_MS);
}

/** The reminder tick's heartbeat is older than 3 minutes: email the team (at most every 30 min). */
export async function checkReminderHeartbeat(now = Date.now(), minUptimeS = 180): Promise<{ ok: boolean; ageMs: number | null; alerted?: boolean }> {
    const { reminderHeartbeat } = await import("../services/reminderHealth.service");
    const hb = await reminderHeartbeat(now);
    if (!hb.ok && process.uptime() >= minUptimeS) {
        const { alertOps } = await import("../services/opsAlert.service");
        await alertOps("reminder-tick-stopped", "Reminders are not running",
            `The reminder tick last ran ${hb.ageMs == null ? "never (no heartbeat)" : `${Math.round(hb.ageMs / 60_000)} minutes ago`}. ` +
            "Dose reminders and Saheli's reminders are not going out. Check kavach-backend on Cloud Run (logs, restarts).", { now });
        return { ...hb, alerted: true };
    }
    return hb;
}

export function stopCareNudgeScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (watchdog) {
        clearInterval(watchdog);
        watchdog = null;
    }
}

export async function runCareNudgeJob() {
    const nudge = await runCareNudgeTick();
    const reminders = await runSaheliReminderTick();
    return { ...nudge, reminders };
}
