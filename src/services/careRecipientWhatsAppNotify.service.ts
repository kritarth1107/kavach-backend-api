import User from "../models/users.model";
import { isMetaWhatsAppEnabled, sendViaMetaWhatsApp } from "../clients/metaWhatsApp.client";
import { isInternalPhone, normalizePhoneInput } from "../utils/phone.util";

function caregiverRelationPhrase(recipientRelationship?: string): string {
    const key = (recipientRelationship ?? "").trim().toLowerCase();
    const map: Record<string, string> = {
        mother: "son/daughter",
        father: "son/daughter",
        son: "parent",
        daughter: "parent",
        spouse: "spouse",
        brother: "sibling",
        sister: "sibling",
        grandmother: "grandchild",
        grandfather: "grandchild",
        uncle: "n nephew/niece",
        aunt: "n nephew/niece",
        other: "family member",
    };
    return map[key] ?? "family member";
}

function formatRecipientName(prefix?: string, name?: string): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "there";
    if (prefix?.trim()) return `${prefix.trim()} ${trimmed}`;
    return trimmed;
}

export function buildCareRecipientWelcomeMessage(input: {
    recipientPrefix?: string;
    recipientName: string;
    caregiverName: string;
    relationship?: string;
    isPhoneUpdate?: boolean;
}): string {
    const recipient = formatRecipientName(input.recipientPrefix, input.recipientName);
    const relation = caregiverRelationPhrase(input.relationship);

    const intro = input.isPhoneUpdate
        ? `*${input.caregiverName}* (your ${relation}) updated your mobile on *Kavach*.`
        : `*${input.caregiverName}* (your ${relation}) has added you on *Kavach* — your family's care companion on WhatsApp.`;

    return `👋 Hi *${recipient}*!

${intro}

Saheli can help with daily check-ins, medicines, and staying connected with your family — right here on WhatsApp.

Just reply *HI* anytime to get started. 💚`;
}

async function getCaregiverDisplayName(userId: string): Promise<string> {
    const user = await User.findOne({ userId }).lean();
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
    if (name) return name;
    const email = user?.email?.split("@")[0]?.trim();
    return email || "Your caregiver";
}

export function phoneToWhatsAppRecipient(
    countryCode?: string,
    phone?: string,
): string | null {
    if (!countryCode || !phone || isInternalPhone(countryCode)) return null;
    try {
        return normalizePhoneInput(countryCode, phone).key;
    } catch {
        return null;
    }
}

export async function notifyCareRecipientWhatsApp(input: {
    phoneCountryCode?: string;
    phone?: string;
    recipientPrefix?: string;
    recipientName: string;
    caregiverUserId: string;
    relationship?: string;
    isPhoneUpdate?: boolean;
}): Promise<void> {
    if (!isMetaWhatsAppEnabled()) return;

    const to = phoneToWhatsAppRecipient(input.phoneCountryCode, input.phone);
    if (!to) return;

    try {
        const caregiverName = await getCaregiverDisplayName(input.caregiverUserId);
        const text = buildCareRecipientWelcomeMessage({
            recipientPrefix: input.recipientPrefix,
            recipientName: input.recipientName,
            caregiverName,
            relationship: input.relationship,
            isPhoneUpdate: input.isPhoneUpdate,
        });
        await sendViaMetaWhatsApp(to, text);
    } catch (err) {
        console.warn("Care recipient WhatsApp welcome failed:", err);
    }
}
