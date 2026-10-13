import Family from "../models/family.model";
import Notification from "../models/notification.model";
import { toDateKeyIST } from "../utils/istTime.util";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { deliverOutboundMessage } from "./channelOutbound.service";
import { resolveRecipientWhatsAppPhone } from "./identityResolver.service";
import { createFamilyNotification } from "./notification.service";
import { composeWhatsAppReply } from "./whatsappMessageComposer.service";

const CAREGIVER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

/**
 * Caregiver WhatsApp policy. WhatsApp is ONLY for:
 *   1. order placed by the care recipient (item, total, COD, ETA, order id)
 *   2. health red flags / emergencies (never missed; deduped for a short window)
 *   3. 3-silence alert (nudge_silence)
 *   4. high-confidence unusual activity (unusual_activity; lower confidence → dashboard only)
 *   (+ elder_share: the elder explicitly asked Saheli to tell the family something)
 * Everything else (progress, prescriptions drafts, rides, routine) → dashboard activity
 * feed + in-app notification + daily snapshot. Never images.
 */
const WHATSAPP_KINDS = new Set([
    "emergency",
    "health_red_flag",
    "symptom",
    "lab_alert",
    "missed_tasks",
    "order_placed",
    "elder_share",
    // Elder silent through N consecutive Saheli check-ins (once per silence streak).
    "nudge_silence",
    // 4th category: high-confidence unusual activity (repeat/bulk/risky orders, confusion, scam cues,
    // marked mood drop / meds missed after >= 7 baseline days). Tiered + 24h-deduped upstream.
    "unusual_activity",
    // talk of suicide, self-harm or harming someone (founder 2026-10-13); the Kavach care team is emailed too
    "crisis",
]);

export function caregiverWhatsAppAllowed(kind?: string, urgency?: "low" | "medium" | "high"): boolean {
    if (kind && WHATSAPP_KINDS.has(kind)) return true;
    // Companion tool escalations without a kind: only urgent ones are treated as a red flag.
    return !kind && urgency === "high";
}

const recentAlerts = new Map<string, number>();
/** Suppress identical alerts inside `windowMs` (webhook retries / repeated mentions). */
export function claimCaregiverAlert(key: string, windowMs: number, now = Date.now()): boolean {
    const prev = recentAlerts.get(key);
    if (prev !== undefined && now - prev < windowMs) return false;
    recentAlerts.set(key, now);
    if (recentAlerts.size > 2000) recentAlerts.delete(recentAlerts.keys().next().value as string);
    return true;
}

/** The person an alert is about, as the family names them (users have no "name" field: live 2026-10-13 the template read
 *  "a medicine for - is not marked as taken"). */
export async function alertPersonName(family: { members?: Array<{ userId: string; name?: string }> } | null, userId: string): Promise<string> {
    const fromFamily = (family?.members ?? []).find((m) => m.userId === userId)?.name?.trim();
    if (fromFamily) return fromFamily.split(/\s+/)[0]!;
    const { default: User } = await import("../models/users.model");
    const u = await User.findOne({ userId }).select("firstName lastName").lean<{ firstName?: string; lastName?: string }>().catch(() => null);
    return (u?.firstName || "").trim().split(/\s+/)[0] || "your family member";
}

export async function notifyCaregivers(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    urgency?: "low" | "medium" | "high";
    kind?: string;
    /** Stable key for the in-app notification; without it every call makes a new one. */
    dedupeKey?: string;
    /** The engine's why-trail id (D-13): the admin console's alert list links to why it was sent. */
    traceId?: string;
    /** What the alert is about, for the delivery ledger (an escalation's streak key). */
    refId?: string;
    /** Only these caregivers (the rest are in their quiet hours, or already told). */
    onlyUserIds?: string[];
}): Promise<{ notifiedCount: number; channels: string[]; others: number; notifiedUserIds: string[] }> {
    const allowWhatsApp = caregiverWhatsAppAllowed(input.kind, input.urgency);
    const family = await Family.findOne({ familyId: input.familyId, status: "ACTIVE" }).lean();

    const caregiverIds = (family?.members ?? [])
        .filter(
            (m) =>
                m.status === FamilyMemberStatus.JOINED &&
                CAREGIVER_ROLES.has(m.role as FamilyRole),
        )
        .map((m) => m.userId)
        // never the person the alert is about: caring for themselves, they are their own primary caregiver (founder
        // 2026-10-13: a self-care user got five "urgent care alert" messages about himself)
        .filter((id) => id !== input.recipientUserId)
        .filter((id) => !input.onlyUserIds || input.onlyUserIds.includes(id));

    let notifiedCount = 0;
    const notifiedUserIds: string[] = [];
    const channels: string[] = [];
    try {
        const active = family;
        if (active) {
            // A caregiver whose WhatsApp chat is closed (24 hours since they wrote) gets the alert template for this kind, naming
            // the person; the full alert waits and Saheli gives it when they tap or write.
            let template: import("./channelOutbound.service").OutboundTemplate | undefined;
            const { alertTemplateFor } = await import("./whatsappTemplates.service");
            const purpose = allowWhatsApp ? alertTemplateFor(input.kind) : null;
            const person = purpose || input.kind === "order_placed" ? await alertPersonName(active, input.recipientUserId) : "";
            if (purpose) template = { purpose, params: [person] };

            for (const caregiverId of caregiverIds) {
                const isOrderPlaced = input.kind === "order_placed";
                void createFamilyNotification(input.familyId, {
                    kind: input.kind === "emergency" || input.kind === "crisis" ? "emergency" : isOrderPlaced ? "order_placed" : "care_alert",
                    title:
                        input.kind === "emergency" || input.kind === "health_red_flag" || input.kind === "crisis"
                            ? "Urgent care alert"
                            : isOrderPlaced
                              ? `${person} placed an order` // the family's own name for them (was "Amma" for everyone)
                              : input.urgency === "high"
                                ? "Urgent care alert"
                                : "Care update",
                    body: input.message.slice(0, 280),
                    actionUrl: isOrderPlaced ? "/dashboard/approvals" : "/dashboard",
                    recipientUserId: input.recipientUserId,
                    dedupeKey: input.dedupeKey || `alert:${input.recipientUserId}:${input.message.slice(0, 40)}:${Date.now()}`,
                }).catch(() => {});

                if (!allowWhatsApp) continue;
                // Found the way every outbound message finds a number: never the internal "+99" placeholder most caregivers
                // who signed up by email carry, else their WhatsApp link (until 2026-10-11 such alerts were dropped).
                const phone = (await resolveRecipientWhatsAppPhone(caregiverId, input.familyId).catch(() => null)) ?? undefined;
                if (phone) {
                    // Never attach "approve" interactive chrome for elder-placed notify-only alerts.
                    const payloads = composeWhatsAppReply(input.message, {
                        kind:
                            input.kind === "emergency" ||
                            input.kind === "health_red_flag" ||
                            input.kind === "crisis" ||
                            isOrderPlaced ||
                            input.kind === "missed_tasks" ||
                            input.kind === "symptom" ||
                            input.kind === "lab_alert" ||
                            input.kind === "elder_share" ||
                            input.kind === "nudge_silence" ||
                            input.kind === "unusual_activity"
                                ? "plain"
                                : "order_pending_approval",
                    });
                    const delivery = await deliverOutboundMessage({ purpose: "alert",
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                        toUserId: caregiverId, // a voice note goes in the caregiver's language, not the elder's
                        content: input.message,
                        channel: "whatsapp",
                        channelIdentifier: phone,
                        whatsappPayloads: payloads,
                        ...(template ? { template } : {}),
                        delivery: { kind: "alert", refId: input.refId ?? `alert:${input.kind || "care_alert"}` },
                    });
                    if (delivery.delivered) {
                        notifiedCount += 1;
                        notifiedUserIds.push(caregiverId);
                        channels.push("whatsapp");
                    }
                }
            }
        }
    } finally {
        // Written after the sends, so the record says who was told: a WhatsApp-kind alert with no one else to tell was
        // listed as a "WhatsApp alert" nobody got (13 Oct, two symptom notes about a caregiver caring for himself).
        const { logActivity } = await import("./activityLog.service");
        await logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            kind: "caregiver_alert",
            severity:
                input.kind === "emergency" || input.kind === "health_red_flag" || input.urgency === "high"
                    ? "error"
                    : input.kind === "nudge_silence"
                      ? "warn"
                      : "info",
            title: `Caregiver ${notifiedCount ? "WhatsApp alert" : "dashboard note"}: ${input.kind || "care_alert"}`,
            detail: input.message,
            data: {
                kind: input.kind || null,
                urgency: input.urgency || null,
                whatsapp: notifiedCount > 0,
                whatsappKind: allowWhatsApp,
                told: notifiedCount,
                caregivers: caregiverIds.length,
                ...(input.traceId ? { traceId: input.traceId } : {}),
            },
        }).catch(() => {});
    }
    return { notifiedCount, channels, others: caregiverIds.length, notifiedUserIds };
}

/** Durable check across restarts: notification dedupe keys are stored as `<caregiverId>:<key>`. */
async function alreadyNotifiedToday(familyId: string, key: string): Promise<boolean> {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return Boolean(await Notification.exists({ familyId, dedupeKey: { $regex: `:${escaped}$` } }));
}

export async function checkCaregiverAlertsForMissedTasks(input: {
    familyId: string;
    recipientUserId: string;
    missedCount: number;
    missedTitles: string[];
}, now: Date = new Date()): Promise<void> {
    if (input.missedCount < 2) return;
    // Called on every scheduler tick after 17:00, so the alert must be claimed once per day.
    const dayKey = toDateKeyIST(now);
    if (!claimCaregiverAlert(`missed:${input.recipientUserId}:${dayKey}`, 24 * 60 * 60_000, now.getTime())) return;
    if (await alreadyNotifiedToday(input.familyId, `missed:${input.recipientUserId}:${dayKey}`)) return;
    await notifyCaregivers({
        dedupeKey: `missed:${input.recipientUserId}:${dayKey}`,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.recipientUserId,
        message: `Care note: ${input.missedCount} tasks still missed today — ${input.missedTitles.slice(0, 4).join(", ")}.`,
        urgency: "medium",
        kind: "missed_tasks",
    });
}

/** Short WhatsApp to linked caregivers when the care recipient places an order. */
export async function notifyCaregiversOrderPlaced(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    elderName?: string;
    partnerLabel: string;
    item?: string;
    totalLabel?: string;
    etaLabel?: string;
    orderId?: string;
}): Promise<void> {
    const key = `order:${input.recipientUserId}:${input.orderId || input.item || ""}`;
    if (!claimCaregiverAlert(key, 30 * 60_000)) return;
    const message = formatCaregiverOrderPlaced(input);
    await notifyCaregivers({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message,
        urgency: "low",
        kind: "order_placed",
    }).catch((err) => console.warn("caregiver order-placed notify failed:", err instanceof Error ? err.message : err));
}

export function formatCaregiverOrderPlaced(input: {
    elderName?: string;
    partnerLabel: string;
    item?: string;
    totalLabel?: string;
    etaLabel?: string;
    orderId?: string;
}): string {
    const who = input.elderName?.trim() || "Your family member";
    return [
        `🛒 ${who} placed a *${input.partnerLabel}* order via Saheli`,
        input.item ? `• ${input.item.slice(0, 80)}` : "",
        `• ${input.totalLabel ? `${input.totalLabel} · ` : ""}Cash on Delivery`,
        `• ETA: ${input.etaLabel || "not shown yet"}`,
        input.orderId ? `• Order ID: ${input.orderId}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}
