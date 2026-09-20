import { runCareNudgeTick } from "../services/saheliCareNudge.service";

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
    console.log("Care nudge scheduler started (1m tick)");
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
    return runCareNudgeTick();
}
