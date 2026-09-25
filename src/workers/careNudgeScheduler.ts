import { runCareNudgeTick } from "../services/saheliCareNudge.service";
import { runSaheliReminderTick } from "../services/saheliReminder.service";

const TICK_MS = 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runTick() {
    if (running) return;
    running = true;
    try {
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
        const { runDailySnapshotTick } = await import("../services/dailySnapshot.service");
        void runDailySnapshotTick().catch((e) => console.warn("daily snapshot tick failed:", e));
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
}

export function stopCareNudgeScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

export async function runCareNudgeJob() {
    const nudge = await runCareNudgeTick();
    const reminders = await runSaheliReminderTick();
    return { ...nudge, reminders };
}
