import { isInternalPhone } from "../utils/phone.util";
import { getFamilyMembersList } from "./familyMember.service";
import { FamilyRole } from "../types/family.types";

type FamilyMemberRow = Awaited<
    ReturnType<typeof getFamilyMembersList>
>["members"][number];

export function messageAsksForMemberPhone(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (!/\b(phone|mobile|number|contact|whatsapp)\b/.test(t)) return false;
    return (
        /\b(on file|do you have|have you got|is there|saved|stored|know her|know his|got her|got his)\b/.test(
            t,
        ) ||
        /\b(her|his|their|mom'?s?|mother'?s?|dad'?s?|father'?s?) (phone|mobile|number)\b/.test(t) ||
        /\bnumber on file\b/.test(t)
    );
}

function formatMemberPhone(member: FamilyMemberRow): string | null {
    const phone = member.phone?.trim();
    if (!phone) return null;
    const cc = member.phoneCountryCode?.trim() ?? "";
    if (cc && isInternalPhone(cc)) return null;
    const digits = phone.replace(/\D/g, "");
    if (!digits) return null;
    return cc ? `${cc} ${digits}` : digits;
}

function memberDisplayName(member: FamilyMemberRow): string {
    return member.fullName?.trim() || member.name?.trim() || "Care recipient";
}

function resolveTargetMember(
    members: FamilyMemberRow[],
    recipientUserId: string,
    message: string,
): FamilyMemberRow | undefined {
    const recipient = members.find((m) => m.userId === recipientUserId);
    if (recipient) return recipient;

    const t = message.toLowerCase();
    const byRole = members.find((m) => m.role === FamilyRole.CARE_RECIPIENT);
    if (byRole) return byRole;

    if (/\b(mom|mother|mummy|maa|mama)\b/.test(t)) {
        return members.find(
            (m) =>
                m.role === FamilyRole.CARE_RECIPIENT ||
                /\b(mom|mother|mummy|maa|parent)\b/i.test(m.relationship ?? ""),
        );
    }

    return byRole ?? members[0];
}

export function formatFamilyRosterForAi(members: FamilyMemberRow[]): string {
    const lines = members
        .filter((m) => m.userId)
        .map((m) => {
            const phone = formatMemberPhone(m);
            const parts = [
                memberDisplayName(m),
                m.roleLabel ? `(${m.roleLabel})` : "",
                phone ? `phone: ${phone}` : "phone: not saved",
                m.relationship ? `relationship: ${m.relationship}` : "",
            ].filter(Boolean);
            return `- ${parts.join(" · ")}`;
        });
    return lines.length
        ? `Family roster (from Kavach — share phone when caregiver asks):\n${lines.join("\n")}`
        : "";
}

export async function tryHandleCaregiverContactQuery(input: {
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    message: string;
    displayName: string;
}): Promise<string | null> {
    if (!messageAsksForMemberPhone(input.message)) return null;

    const { members } = await getFamilyMembersList(input.familyId, input.actorUserId);
    const target =
        resolveTargetMember(members, input.recipientUserId, input.message) ??
        members.find((m) => m.userId === input.recipientUserId);

    const name = target ? memberDisplayName(target) : input.displayName;
    const phone = target ? formatMemberPhone(target) : null;

    if (phone) {
        return `Yes — ${name}'s number on file is ${phone}.`;
    }

    return `${name} doesn't have a mobile number saved in Kavach yet. Add it under Family → ${name}'s profile.`;
}
