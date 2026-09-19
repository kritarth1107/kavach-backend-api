import Family from "../models/family.model";
import User from "../models/users.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { deliverOutboundMessage } from "./channelOutbound.service";
import { createFamilyNotification } from "./notification.service";
import { composeWhatsAppReply } from "./whatsappMessageComposer.service";

const CAREGIVER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

export async function notifyCaregivers(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    urgency?: "low" | "medium" | "high";
    kind?: string;
}): Promise<{ notifiedCount: number; channels: string[] }> {
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
        void createFamilyNotification(input.familyId, {
            kind: input.kind === "emergency" ? "emergency" : "care_alert",
            title: input.urgency === "high" ? "Urgent care alert" : "Care update",
            body: input.message.slice(0, 280),
            actionUrl: "/dashboard",
            recipientUserId: input.recipientUserId,
            dedupeKey: `alert:${input.recipientUserId}:${input.message.slice(0, 40)}:${Date.now()}`,
        }).catch(() => {});

        const user = await User.findOne({ userId: caregiverId }).lean();
        const phone =
            user?.phone?.countryCode && user.phone.number
                ? `${user.phone.countryCode}${user.phone.number}`
                : undefined;
        if (phone) {
            const payloads = composeWhatsAppReply(input.message, {
                kind: input.kind === "emergency" ? "plain" : "order_pending_approval",
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
