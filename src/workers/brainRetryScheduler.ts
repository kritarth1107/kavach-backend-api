/**
 * Every 30 s: held WhatsApp turns are tried again (services/brainHold.service.ts: the brain could not answer when they
 * came). Once a day after 07:00 IST: the "0 writes to the old memory stores" check (services/legacyWriteCheck.service.ts).
 * The backend runs as one instance, so one timer is enough; each row is claimed before it is tried.
 */
import { runBrainRetryTick } from "../services/brainHold.service";

const TICK_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick() {
    if (running) return;
    running = true;
    try {
        const out = await runBrainRetryTick();
        if (out.tried) console.log(`[brain-hold] tick: tried=${out.tried} answered=${out.answered} trouble=${out.trouble} gaveUp=${out.gaveUp}`);
        const { runLegacyWriteCheck } = await import("../services/legacyWriteCheck.service");
        await runLegacyWriteCheck().catch((e) => console.warn("[legacy-writes] check failed:", e instanceof Error ? e.message : e));
    } catch (err) {
        console.warn("[brain-hold] tick failed:", err instanceof Error ? err.message : err);
    } finally {
        running = false;
    }
}

export function startBrainRetryScheduler() {
    if (timer) return;
    console.log("Brain retry scheduler started (30s tick; daily legacy-write check)");
    timer = setInterval(() => void tick(), TICK_MS);
}

export function stopBrainRetryScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
