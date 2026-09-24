import { randomUUID } from "crypto";
import EmergencyEscalationLog from "../models/emergencyEscalationLog.model";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
} from "../types/careRecord.types";
import { appendCareRecordEvent } from "./careRecord.service";
import { notifyCaregivers } from "./saheliCaregiverAlert.service";

const EMERGENCY_DEDUPE_MS = 15 * 60 * 1000;

const EMERGENCY_PATTERNS =
    /\b(chest pain|can't breathe|cannot breathe|heart attack|fell down|fallen|help me|emergency|ambulance|112|108|severe pain|unbearable pain|unconscious|stroke|seizure|bleeding heavily|suffocating|saans\s+nahi|gir gay(?:a|i)?|gir\s+gay(?:a|i)?|bahut\s+dard|bohot\s+dard|madad\s+karo|call\s+ambulance)\b/i;

export function messageLooksLikeEmergency(text: string): boolean {
    return EMERGENCY_PATTERNS.test(text.trim());
}

export function elderEmergencyReply(displayName: string): string {
    return [
        `${displayName}, I'm here with you.`,
        "If this is urgent, please call 112 or your nearest emergency number right away.",
        "Sit down, stay calm, and don't be alone if you can help it.",
        "I've alerted your family on WhatsApp.",
    ].join("\n\n");
}

export async function triggerEmergencyEscalation(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    message: string;
    channel?: string;
}): Promise<Record<string, unknown>> {
    const recent = await EmergencyEscalationLog.findOne({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        createdAt: { $gte: new Date(Date.now() - EMERGENCY_DEDUPE_MS) },
    }).lean();

    if (recent) {
        return { escalated: false, reason: "recent_escalation", escalationId: recent.escalationId };
    }

    const notify = await notifyCaregivers({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: `Emergency alert from care recipient: "${input.message.slice(0, 280)}"`,
        urgency: "high",
        kind: "emergency",
    });

    const escalationId = randomUUID();
    await EmergencyEscalationLog.create({
        escalationId,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: input.message.slice(0, 500),
        channel: input.channel ?? "whatsapp",
        caregiversNotified: notify.notifiedCount ?? 0,
    });

    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.SYSTEM,
        source: CareRecordSource.SAHELI,
        channel: ChannelType.WHATSAPP,
        title: "Emergency escalation",
        detail: input.message.slice(0, 280),
        status: "reported",
        payload: { escalationId, caregiversNotified: notify.notifiedCount },
        skipSignalCheck: true,
    });

    return { escalated: true, escalationId, caregiversNotified: notify.notifiedCount };
}

export async function listRecentEscalations(
    familyId: string,
    recipientUserId: string,
    limit = 10,
) {
    return EmergencyEscalationLog.find({ familyId, recipientUserId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
}
