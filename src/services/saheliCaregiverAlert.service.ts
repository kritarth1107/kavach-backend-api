import Family from "../models/family.model";
import User from "../models/users.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { deliverOutboundMessage } from "./channelOutbound.service";
import { createFamilyNotification } from "./notification.service";
import { composeWhatsAppReply } from "./whatsappMessageComposer.service";

const CAREGIVER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

/**
 * Caregiver WhatsApp policy. WhatsApp is ONLY for:
 *   1. order placed by the care recipient (item, total, COD, ETA, order id)
 *   2. health red flags / emergencies (never missed; deduped for a short window)
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

export async function notifyCaregivers(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    urgency?: "low" | "medium" | "high";
    kind?: string;
}): Promise<{ notifiedCount: number; channels: string[] }> {
    const allowWhatsApp = caregiverWhatsAppAllowed(input.kind, input.urgency);
    {
        const { logActivity } = await import("./activityLog.service");
        void logActivity({
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
            title: `Caregiver ${allowWhatsApp ? "WhatsApp alert" : "dashboard note"}: ${input.kind || "care_alert"}`,
            detail: input.message,
            data: { kind: input.kind || null, urgency: input.urgency || null, whatsapp: allowWhatsApp },
        });
    }
    const family = await Family.findOne({ familyId: input.familyId, status: "ACTIVE" }).lean();
    if (!family) return { notifiedCount: 0, channels: [] };

    const caregiverIds = family.members
        .filter(
            (m) =>
                m.status === FamilyMemberStatus.JOINED &&
                CAREGIVER_ROLES.has(m.role as FamilyRole),
        )
        .map((m) => m.userId);

    let notifiedCount = 0;
    const channels: string[] = [];

    for (const caregiverId of caregiverIds) {
        const isOrderPlaced = input.kind === "order_placed";
        void createFamilyNotification(input.familyId, {
            kind: input.kind === "emergency" ? "emergency" : isOrderPlaced ? "order_placed" : "care_alert",
            title:
                input.kind === "emergency" || input.kind === "health_red_flag"
                    ? "Urgent care alert"
                    : isOrderPlaced
                      ? "Amma placed an order"
                      : input.urgency === "high"
                        ? "Urgent care alert"
                        : "Care update",
            body: input.message.slice(0, 280),
            actionUrl: isOrderPlaced ? "/dashboard/approvals" : "/dashboard",
            recipientUserId: input.recipientUserId,
            dedupeKey: `alert:${input.recipientUserId}:${input.message.slice(0, 40)}:${Date.now()}`,
        }).catch(() => {});

        if (!allowWhatsApp) continue;
        const user = await User.findOne({ userId: caregiverId }).lean();
        const phone =
            user?.phone?.countryCode && user.phone.number
                ? `${user.phone.countryCode}${user.phone.number}`
                : undefined;
        if (phone) {
            // Never attach "approve" interactive chrome for elder-placed notify-only alerts.
            const payloads = composeWhatsAppReply(input.message, {
                kind:
                    input.kind === "emergency" ||
                    input.kind === "health_red_flag" ||
                    isOrderPlaced ||
                    input.kind === "missed_tasks" ||
                    input.kind === "symptom" ||
                    input.kind === "lab_alert" ||
                    input.kind === "elder_share" ||
                    input.kind === "nudge_silence"
                        ? "plain"
                        : "order_pending_approval",
            });
            const delivery = await deliverOutboundMessage({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                content: input.message,
                channel: "whatsapp",
                channelIdentifier: phone,
                whatsappPayloads: payloads,
            });
            if (delivery.delivered) {
                notifiedCount += 1;
                channels.push("whatsapp");
            }
        }
    }

    return { notifiedCount, channels };
}

export async function checkCaregiverAlertsForMissedTasks(input: {
    familyId: string;
    recipientUserId: string;
    missedCount: number;
    missedTitles: string[];
}): Promise<void> {
    if (input.missedCount < 2) return;
    await notifyCaregivers({
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
