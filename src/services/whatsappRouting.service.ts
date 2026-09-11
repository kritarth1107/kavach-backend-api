import type { OutboundMessage } from "../channels/types";
import { whatsAppMockAdapter } from "../channels/whatsappMock.adapter";
import { ChannelType, CareRecordSource } from "../types/careRecord.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import WhatsappSession from "../models/whatsappSession.model";
import {
    normalizeChannelIdentifier,
    resolveChannelIdentity,
} from "./identityResolver.service";
import { tryHandleCaregiverWhatsAppOrderCommand } from "./whatsappOrder.service";
import { getFamilyMembersList } from "./familyMember.service";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const GUEST_WELCOME = `Namaste! 🙏 I'm *Saheli* — Kavach's caring companion on WhatsApp.

*Kavach* helps families look after their loved ones — gentle check-ins, reminders, family memories, and ordering groceries or food through Swiggy, Instamart, or Zepto when your caregiver connects them.

*What Saheli does:*
• Talks with care recipients like a warm, respectful companion
• Helps caregivers stay updated on mood, meals, and daily life
• Suggests orders that your family approves before checkout

If you're already on Kavach, ask your family caregiver to link this WhatsApp number in the dashboard under *Integrations → WhatsApp*.

How can I help you today?`;

const GUEST_FOLLOWUP = `Thanks for reaching out! If you're part of a Kavach family, your caregiver can link this number at app.kavach.care → Integrations.

If you're exploring Kavach for your family, visit kavach.care or ask your caregiver to invite you.

I'm here whenever your number is linked — Saheli will remember your family and chat naturally.`;

function isCaregiver(role: FamilyRole): boolean {
    return role === FamilyRole.PRIMARY_CAREGIVER || role === FamilyRole.CO_CAREGIVER;
}

function outbound(phone: string, text: string): OutboundMessage {
    return {
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: phone,
        modality: "text",
        content: text,
    };
}

async function touchGuestSession(phone: string) {
    const existing = await WhatsappSession.findOne({ phone }).lean();
    const guestTurns = (existing?.guestTurns ?? 0) + 1;
    await WhatsappSession.findOneAndUpdate(
        { phone },
        {
            $set: {
                guestTurns,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
            $unset: { familyId: "", userId: "", pendingRecipientUserId: "", awaitingRecipientPick: "", recipientOptions: "" },
        },
        { upsert: true },
    );
    return guestTurns;
}

async function handleGuestMessage(phone: string): Promise<OutboundMessage> {
    const turns = await touchGuestSession(phone);
    return outbound(phone, turns <= 1 ? GUEST_WELCOME : GUEST_FOLLOWUP);
}

async function listFamilyRecipients(familyId: string, actorUserId: string) {
    const payload = await getFamilyMembersList(familyId, actorUserId);
    return payload.members
        .filter(
            (m) =>
                m.userId &&
                m.role === FamilyRole.CARE_RECIPIENT &&
                m.status === FamilyMemberStatus.JOINED,
        )
        .map((m) => ({ userId: m.userId as string, name: m.name?.trim() || "Care recipient" }));
}

function matchRecipientByText(
    text: string,
    recipients: Array<{ userId: string; name: string }>,
): string | null {
    const lower = text.toLowerCase();
    const numbered = lower.match(/^\s*([1-9])\s*$/);
    if (numbered) {
        const idx = Number(numbered[1]) - 1;
        return recipients[idx]?.userId ?? null;
    }
    for (const r of recipients) {
        const name = r.name.toLowerCase();
        if (name.length >= 2 && lower.includes(name)) return r.userId;
    }
    return null;
}

async function resolveCaregiverSubject(input: {
    phone: string;
    familyId: string;
    userId: string;
    text: string;
}): Promise<{ subjectUserId: string } | { prompt: string }> {
    const recipients = await listFamilyRecipients(input.familyId, input.userId);
    if (!recipients.length) {
        return { prompt: "Your family doesn't have a care recipient profile yet. Add one in the Kavach dashboard first." };
    }
    if (recipients.length === 1) {
        return { subjectUserId: recipients[0]!.userId };
    }

    const session = await WhatsappSession.findOne({ phone: input.phone }).lean();
    const options = recipients;

    const matched = matchRecipientByText(input.text, options);
    if (matched) {
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $set: {
                    familyId: input.familyId,
                    userId: input.userId,
                    pendingRecipientUserId: matched,
                    awaitingRecipientPick: false,
                    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
                },
            },
            { upsert: true },
        );
        return { subjectUserId: matched };
    }

    if (session?.pendingRecipientUserId && !session.awaitingRecipientPick) {
        return { subjectUserId: session.pendingRecipientUserId };
    }

    const lines = options.map((r, i) => `${i + 1}. ${r.name}`).join("\n");
    await WhatsappSession.findOneAndUpdate(
        { phone: input.phone },
        {
            $set: {
                familyId: input.familyId,
                userId: input.userId,
                awaitingRecipientPick: true,
                recipientOptions: options,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
        },
        { upsert: true },
    );

    return {
        prompt: `Who are you asking about?\n${lines}\n\nReply with a number or name, and I'll answer about them.`,
    };
}

export async function handleWhatsAppInbound(body: {
    from?: string;
    text?: string;
    modality?: "text" | "voice";
    audioBase64?: string;
}): Promise<OutboundMessage> {
    const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(body.from ?? ""));
    const text = String(body.text ?? "").trim();

    let identity: Awaited<ReturnType<typeof resolveChannelIdentity>> | null = null;
    try {
        identity = await resolveChannelIdentity(ChannelType.WHATSAPP, phone);
    } catch {
        return handleGuestMessage(phone);
    }

    if (isCaregiver(identity.role)) {
        const orderReply = await tryHandleCaregiverWhatsAppOrderCommand({
            familyId: identity.familyId,
            actorUserId: identity.userId,
            role: identity.role,
            text,
        });
        if (orderReply) {
            return outbound(phone, orderReply);
        }
    }

    let subjectUserId = identity.userId;
    if (isCaregiver(identity.role)) {
        const subject = await resolveCaregiverSubject({
            phone,
            familyId: identity.familyId,
            userId: identity.userId,
            text,
        });
        if ("prompt" in subject) {
            return outbound(phone, subject.prompt);
        }
        subjectUserId = subject.subjectUserId;
    }

    const { reply } = await whatsAppMockAdapter.receive({
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: phone,
        modality: body.modality ?? "text",
        content: text,
        audioBase64: body.audioBase64,
        timestamp: new Date(),
        _routing: {
            familyId: identity.familyId,
            userId: identity.userId,
            role: identity.role,
            subjectUserId,
        },
    });

    return reply;
}
