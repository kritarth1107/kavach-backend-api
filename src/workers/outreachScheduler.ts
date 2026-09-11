import { deliverSaheliOutreach } from "../services/saheliOutreach.service";
import { listEnabledCompanions, dueOutreachSlot } from "../services/saheliCompanion.service";

const TICK_MS = 60_000;
const RANDOM_OUTREACH_CHANCE = 0.06;
const RANDOM_OUTREACH_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const OUTREACH_KINDS = ["casual", "care", "mixed"] as const;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function runOutreachTick() {
    if (running) return;
    running = true;
    try {
        const companions = await listEnabledCompanions();
        const now = new Date();
        for (const companion of companions) {
            const slot = dueOutreachSlot(companion, now);
            if (slot) {
                try {
                    await deliverSaheliOutreach({
                        familyId: companion.familyId,
                        recipientUserId: companion.recipientUserId,
                        slot,
                    });
                } catch (err) {
                    console.warn(
                        `Outreach failed for ${companion.familyId}/${companion.recipientUserId}:`,
                        err,
                    );
                }
                continue;
            }

            const last = companion.lastOutreachAt ? new Date(companion.lastOutreachAt).getTime() : 0;
            const cooledDown = Date.now() - last >= RANDOM_OUTREACH_COOLDOWN_MS;
            if (!cooledDown || Math.random() >= RANDOM_OUTREACH_CHANCE) continue;

            const kind = OUTREACH_KINDS[Math.floor(Math.random() * OUTREACH_KINDS.length)];
            try {
                await deliverSaheliOutreach({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    outreachKind: kind,
                    force: true,
                });
            } catch (err) {
                console.warn(
                    `Random outreach failed for ${companion.familyId}/${companion.recipientUserId}:`,
                    err,
                );
            }
        }
    } finally {
        running = false;
    }
}

export function startOutreachScheduler() {
    if (process.env.SAHELI_OUTREACH_ENABLED === "false") {
        console.log("Saheli outreach scheduler disabled (SAHELI_OUTREACH_ENABLED=false)");
        return;
    }
    if (timer) return;
    console.log("Saheli outreach scheduler started (60s tick)");
    void runOutreachTick();
    timer = setInterval(() => {
        void runOutreachTick();
    }, TICK_MS);
}

export function stopOutreachScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
