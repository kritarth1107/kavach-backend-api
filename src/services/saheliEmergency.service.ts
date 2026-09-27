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

/**
 * Keyword net for UNAMBIGUOUS emergencies only (fires before the model, zero latency).
 * Ambiguous phrases ("bahut dard hai", "help me", "fallen") are left to the Gemini router
 * (intent=emergency, confidence ≥ 0.75) and the red-flag screener — a sore knee must never
 * get the "call 112, I've alerted your family" reply.
 */
const EMERGENCY_PATTERNS =
    /\b(chest pain|seene\s+(?:mein|me)\s+dard|can'?t breathe|cannot breathe|unable to breathe|heart attack|i (?:have )?fell|i have fallen|fell down|unconscious|behosh|stroke|seizure|bleeding heavily|khoon\s+(?:beh|nikal)\s*raha|suffocating|saans\s+nahi|saans\s+(?:lene\s+)?(?:mein|me)\s+(?:dikkat|takleef)|gir\s*gay(?:a|i)|call\s+(?:an\s+)?ambulance|ambulance\s+(?:bulao|bhejo|chahiye)|call\s+112|call\s+108)\b/i;

export function messageLooksLikeEmergency(text: string): boolean {
    return EMERGENCY_PATTERNS.test(text.trim());
}

/** Hindi / Hinglish sender? (reply language only — never used for intent). */
function looksHindi(text: string): boolean {
    if (/[\u0900-\u097F]/.test(text)) return true;
    const w = text.toLowerCase().match(/[a-z]+/g) || [];
    const hi = new Set(["hai", "hain", "nahi", "nahin", "mujhe", "mera", "meri", "mere", "gir", "gaya", "gayi", "dard", "saans", "madad", "karo", "raha", "rahi", "ho", "seene", "behosh", "bulao", "jaldi", "bahut", "bohot", "chakkar", "aa"]);
    return w.filter((x) => hi.has(x)).length >= 2;
}

export function elderEmergencyReply(displayName: string, text = "", language?: string | null): string {
    const first = (displayName || "").trim().split(/\s+/)[0] || "";
    const hindi = language ? /^(hi|hinglish|hindi)/i.test(language) : looksHindi(text);
    if (hindi) {
        return [
            `${first ? `${first} ji, ` : ""}main yahin hoon aapke saath 🙏`,
            "Agar zyada takleef hai to abhi *112* par call kijiye.",
            "Aaram se baith jaiye, akele mat rahiye — kisi ko paas bula lijiye.",
            "Maine aapke parivaar ko WhatsApp par bata diya hai.",
        ].join("\n\n");
    }
    return [
        `${first ? `${first}, ` : ""}I'm right here with you 🙏`,
        "If this is urgent, please call *112* right away.",
        "Sit down, stay calm, and try not to be alone.",
        "I've told your family on WhatsApp.",
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
