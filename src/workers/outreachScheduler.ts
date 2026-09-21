import { deliverSaheliOutreach } from "../services/saheliOutreach.service";
import {
    listEnabledCompanions,
    dueOutreachSlot,
    isWithinQuietHours,
    localDateParts,
} from "../services/saheliCompanion.service";
import SaheliOutreachLog from "../models/saheliOutreachLog.model";

const TICK_MS = 60_000;
const RANDOM_OUTREACH_CHANCE = 0.12;
const MEMORY_OUTREACH_CHANCE = 0.08;
const RANDOM_OUTREACH_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const OUTREACH_KINDS = ["casual", "care", "mixed"] as const;
const CASUAL_TOPICS = ["day_life", "family", "hobbies", "food", "mood", "memories"] as const;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function hadOutreachToday(
    familyId: string,
    recipientUserId: string,
    slot: "random" | "memory",
    dateKey: string,
): Promise<boolean> {
    const existing = await SaheliOutreachLog.findOne({
        familyId,
        recipientUserId,
        slotDate: dateKey,
        slot,
    }).lean();
    return Boolean(existing);
}

export async function runOutreachTick() {
    if (running) return;
    running = true;
    try {
        const companions = await listEnabledCompanions();
        const now = new Date();
        for (const companion of companions) {
            const timezone = companion.timezone || "Asia/Kolkata";
            const dateKey = localDateParts(timezone).date;
            const lonely =
                companion.lastWhatsAppInboundAt &&
                Date.now() - new Date(companion.lastWhatsAppInboundAt).getTime() >
                    48 * 60 * 60 * 1000;

            if (lonely && !dueOutreachSlot(companion, now) && !isWithinQuietHours(companion, now)) {
                try {
                    await deliverSaheliOutreach({
                        familyId: companion.familyId,
                        recipientUserId: companion.recipientUserId,
                        outreachKind: "mixed",
                        force: true,
                        outreachSlot: "random",
                    });
                } catch (err) {
                    console.warn(
                        `Loneliness outreach failed for ${companion.familyId}/${companion.recipientUserId}:`,
                        err,
                    );
                }
                continue;
            }

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
            if (!cooledDown || isWithinQuietHours(companion, now)) continue;

            const memoryAlready = await hadOutreachToday(
                companion.familyId,
                companion.recipientUserId,
                "memory",
                dateKey,
            );
            if (!memoryAlready && Math.random() < MEMORY_OUTREACH_CHANCE) {
                try {
                    await deliverSaheliOutreach({
                        familyId: companion.familyId,
                        recipientUserId: companion.recipientUserId,
                        outreachKind: "memory",
                        force: true,
                        outreachSlot: "memory",
                    });
                } catch (err) {
                    console.warn(
                        `Memory outreach failed for ${companion.familyId}/${companion.recipientUserId}:`,
                        err,
                    );
                }
                continue;
            }

            const randomAlready = await hadOutreachToday(
                companion.familyId,
                companion.recipientUserId,
                "random",
                dateKey,
            );
            if (randomAlready || Math.random() >= RANDOM_OUTREACH_CHANCE) continue;

            const roll = Math.random();
            const kind =
                roll < 0.35
                    ? "memory"
                    : OUTREACH_KINDS[Math.floor(Math.random() * OUTREACH_KINDS.length)];
            const topicHint =
                kind === "memory" || kind === "casual"
                    ? CASUAL_TOPICS[Math.floor(Math.random() * CASUAL_TOPICS.length)]
                    : undefined;
            try {
                await deliverSaheliOutreach({
                    familyId: companion.familyId,
                    recipientUserId: companion.recipientUserId,
                    outreachKind: kind === "memory" ? "memory" : kind,
                    topicBucket: topicHint,
                    topicHint,
                    force: true,
                    outreachSlot: "random",
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
    console.log("Saheli outreach scheduler started (60s tick, random + memory warmth)");
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
