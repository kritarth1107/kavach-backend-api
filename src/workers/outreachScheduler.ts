import { deliverSaheliOutreach } from "../services/saheliOutreach.service";
import {
    listEnabledCompanions,
    dueOutreachSlot,
    isWithinQuietHours,
    localDateParts,
} from "../services/saheliCompanion.service";
import SaheliOutreachLog from "../models/saheliOutreachLog.model";
import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";

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



async function maybeSendOrderDeliveredFollowup(companion: {
    familyId: string;
    recipientUserId: string;
}): Promise<boolean> {
    const since = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const delivered = await Order.findOne({
        familyId: companion.familyId,
        subjectUserId: companion.recipientUserId,
        status: OrderStatus.DELIVERED,
        updatedAt: { $gte: since },
    })
        .sort({ updatedAt: -1 })
        .lean();
    if (!delivered) return false;

    const already = await SaheliOutreachLog.findOne({
        familyId: companion.familyId,
        recipientUserId: companion.recipientUserId,
        topicHint: `order_delivered:${delivered.orderId}`,
    }).lean();
    if (already) return false;

    await deliverSaheliOutreach({
        familyId: companion.familyId,
        recipientUserId: companion.recipientUserId,
        outreachKind: "casual",
        topicBucket: "order_delivered",
        topicHint: `order_delivered:${(delivered as { orderId?: string }).orderId}`,
        force: true,
        outreachSlot: "random",
    });
    return true;
}


async function maybeSymptomEveningFollowup(companion: {
    familyId: string;
    recipientUserId: string;
    timezone?: string;
}): Promise<boolean> {
    const { getISTParts, toDateKeyIST } = await import("../utils/istTime.util");
    const parts = getISTParts();
    // Evening window 18:00–20:30 IST
    if (parts.hours < 18 || parts.hours > 20 || (parts.hours === 20 && parts.minutes > 30)) {
        return false;
    }
    const since = new Date(Date.now() - 14 * 60 * 60 * 1000);
    const CareRecordEvent = (await import("../models/careRecordEvent.model")).default;
    const { CareRecordEventType } = await import("../types/careRecord.types");
    const recent = await CareRecordEvent.findOne({
        familyId: companion.familyId,
        subjectUserId: companion.recipientUserId,
        type: CareRecordEventType.SYMPTOM,
        createdAt: { $gte: since },
        "payload.followUpSuggested": "evening",
    })
        .sort({ createdAt: -1 })
        .lean();
    if (!recent) return false;

    const dateKey = toDateKeyIST();
    const topicHint = `symptom_followup:${String((recent as { eventId?: string }).eventId ?? dateKey)}`;
    const already = await SaheliOutreachLog.findOne({
        familyId: companion.familyId,
        recipientUserId: companion.recipientUserId,
        topicHint,
    }).lean();
    if (already) return false;

    await deliverSaheliOutreach({
        familyId: companion.familyId,
        recipientUserId: companion.recipientUserId,
        outreachKind: "care",
        topicBucket: "symptom_followup",
        topicHint,
        force: true,
        outreachSlot: "random",
    });
    return true;
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

            // Elder silent through N consecutive check-ins → one caregiver WhatsApp alert per streak.
            try {
                const { checkSilenceAndAlert } = await import("../services/saheliNudgeStreak.service");
                await checkSilenceAndAlert(companion.familyId, companion.recipientUserId, { now });
            } catch (err) {
                console.warn(
                    `Silence check failed for ${companion.familyId}/${companion.recipientUserId}:`,
                    err instanceof Error ? err.message : err,
                );
            }

            try {
                if (!isWithinQuietHours(companion, now)) {
                    const symptomFollowed = await maybeSymptomEveningFollowup(companion);
                    if (symptomFollowed) continue;
                }
            } catch (err) {
                console.warn(
                    `Symptom evening follow-up failed for ${companion.familyId}/${companion.recipientUserId}:`,
                    err,
                );
            }

                        // Soft check-in when elder has been quiet for 2+ days (respect quiet hours).
            const lonely =
                companion.lastWhatsAppInboundAt &&
                Date.now() - new Date(companion.lastWhatsAppInboundAt).getTime() >
                    2 * 24 * 60 * 60 * 1000;

            if (lonely && !dueOutreachSlot(companion, now) && !isWithinQuietHours(companion, now)) {
                try {
                    await deliverSaheliOutreach({
                        familyId: companion.familyId,
                        recipientUserId: companion.recipientUserId,
                        outreachKind: "mixed",
                        topicBucket: "check_in",
                        topicHint: "soft_lonely_check_in",
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

            
            // High-signal: order just delivered → short companion follow-up (once per order).
            if (!isWithinQuietHours(companion, now)) {
                try {
                    const sent = await maybeSendOrderDeliveredFollowup(companion);
                    if (sent) continue;
                } catch (err) {
                    console.warn(
                        `Order-delivered follow-up failed for ${companion.familyId}/${companion.recipientUserId}:`,
                        err,
                    );
                }
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
