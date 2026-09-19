import { randomUUID } from "crypto";
import ChannelIdentity from "../models/channelIdentity.model";
import Family from "../models/family.model";
import FamilyInvitation from "../models/familyInvitation.model";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import { ChannelType } from "../types/careRecord.types";
import {
    FamilyInvitationStatus,
    FamilyMemberStatus,
    FamilyRole,
} from "../types/family.types";
import { isInternalPhone, normalizePhoneInput } from "../utils/phone.util";

export function normalizeChannelIdentifier(channelType: ChannelType, raw: string): string {
    const trimmed = raw.trim();
    if (channelType === ChannelType.WHATSAPP || channelType === ChannelType.PHONE) {
        const digits = trimmed.replace(/\D/g, "");
        if (digits.startsWith("91") && digits.length === 12) return `+${digits}`;
        if (digits.length === 10) return `+91${digits}`;
        return trimmed.startsWith("+") ? trimmed : `+${digits}`;
    }
    return trimmed.toLowerCase();
}

export type ResolvedChannelIdentity = {
    familyId: string;
    userId: string;
    role: FamilyRole;
    channelIdentifier: string;
};

function phoneLookupVariants(normalized: string) {
    const digits = normalized.replace(/\D/g, "");
    const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
    const keys = new Set<string>();
    if (normalized) keys.add(normalized);
    if (digits) {
        keys.add(digits);
        keys.add(`+${digits}`);
    }
    if (last10.length === 10) {
        keys.add(`+91${last10}`);
        keys.add(`91${last10}`);
    }
    return { digits, last10, keys: [...keys] };
}

async function findUserByWhatsAppPhone(normalized: string) {
    const { last10, keys } = phoneLookupVariants(normalized);

    return User.findOne({
        $or: [
            ...keys.map((phoneKey) => ({ phoneKey })),
            ...(last10.length === 10
                ? [
                      { "phone.countryCode": "+91", "phone.number": last10 },
                      { "phone.number": last10 },
                  ]
                : []),
        ],
    }).lean();
}

async function backfillUserPhoneFromInvite(
    userId: string,
    countryCode: string,
    number: string,
): Promise<void> {
    try {
        const normalized = normalizePhoneInput(countryCode, number);
        const user = await User.findOne({ userId }).lean();
        if (!user) return;
        if (user.phone?.number && !isInternalPhone(user.phone.countryCode)) return;
        await User.updateOne(
            { userId },
            {
                phone: {
                    countryCode: normalized.countryCode,
                    number: normalized.number,
                },
                phoneKey: normalized.key,
            },
        );
    } catch {
        // best-effort backfill
    }
}

async function resolveCareRecipientFromInvitePhone(
    normalized: string,
): Promise<ResolvedChannelIdentity | null> {
    const { last10 } = phoneLookupVariants(normalized);
    if (last10.length !== 10) return null;

    const invites = await FamilyInvitation.find({
        role: FamilyRole.CARE_RECIPIENT,
        status: FamilyInvitationStatus.ACCEPTED,
        userId: { $exists: true, $nin: [null, ""] },
        phone: { $exists: true, $ne: "" },
    })
        .sort({ updatedAt: -1 })
        .lean();

    for (const invite of invites) {
        const cc = invite.phoneCountryCode?.trim() || "+91";
        let inviteLast10 = "";
        try {
            inviteLast10 = normalizePhoneInput(cc, invite.phone ?? "").number;
        } catch {
            inviteLast10 = String(invite.phone ?? "").replace(/\D/g, "").slice(-10);
        }
        if (inviteLast10 !== last10) continue;

        const membership = await resolveFamilyMembership(String(invite.userId));
        if (!membership) continue;

        void backfillUserPhoneFromInvite(String(invite.userId), cc, inviteLast10);
        return {
            ...membership,
            channelIdentifier: normalized,
        };
    }

    return null;
}

async function resolveFamilyMembership(userId: string) {
    const families = await Family.find({
        status: "ACTIVE",
        members: {
            $elemMatch: { userId, status: FamilyMemberStatus.JOINED },
        },
    }).lean();

    if (!families.length) return null;

    for (const family of families) {
        const recipient = family.members.find(
            (m) =>
                m.userId === userId &&
                m.status === FamilyMemberStatus.JOINED &&
                m.role === FamilyRole.CARE_RECIPIENT,
        );
        if (recipient) {
            return {
                familyId: family.familyId,
                userId,
                role: FamilyRole.CARE_RECIPIENT,
            };
        }
    }

    const family = families[0]!;
    const member = family.members.find(
        (m) => m.userId === userId && m.status === FamilyMemberStatus.JOINED,
    );
    if (!member) return null;

    return {
        familyId: family.familyId,
        userId,
        role: member.role as FamilyRole,
    };
}

/** Recognize a WhatsApp sender by profile phone (single Kavach line model). */
export async function resolveWhatsAppSender(senderPhone: string): Promise<ResolvedChannelIdentity> {
    const normalized = normalizeChannelIdentifier(ChannelType.WHATSAPP, senderPhone);

    const manual = await ChannelIdentity.findOne({
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: normalized,
        active: true,
    }).lean();

    if (manual) {
        return {
            familyId: manual.familyId,
            userId: manual.userId,
            role: manual.role as FamilyRole,
            channelIdentifier: normalized,
        };
    }

    const fromInvite = await resolveCareRecipientFromInvitePhone(normalized);
    if (fromInvite) {
        return fromInvite;
    }

    const user = await findUserByWhatsAppPhone(normalized);
    if (user) {
        const membership = await resolveFamilyMembership(user.userId);
        if (membership) {
            return {
                ...membership,
                channelIdentifier: normalized,
            };
        }
    }

    throw new AppError(
        "Phone not recognized — sign up at Kavach or ask your caregiver to invite you",
        404,
    );
}

export async function resolveUserWhatsAppPhone(userId: string): Promise<string | null> {
    const user = await User.findOne({ userId }).lean();
    if (!user?.phone?.countryCode || !user.phone.number) return null;
    if (isInternalPhone(user.phone.countryCode)) return null;
    return normalizeChannelIdentifier(
        ChannelType.WHATSAPP,
        `${user.phone.countryCode}${user.phone.number}`,
    );
}

export async function resolveChannelIdentity(
    channelType: ChannelType,
    channelIdentifier: string,
): Promise<ResolvedChannelIdentity> {
    if (channelType === ChannelType.WHATSAPP) {
        return resolveWhatsAppSender(channelIdentifier);
    }

    const normalized = normalizeChannelIdentifier(channelType, channelIdentifier);
    const row = await ChannelIdentity.findOne({
        channelType,
        channelIdentifier: normalized,
        active: true,
    }).lean();

    if (!row) {
        throw new AppError("Channel identity not linked to a family member", 404);
    }

    return {
        familyId: row.familyId,
        userId: row.userId,
        role: row.role as FamilyRole,
        channelIdentifier: normalized,
    };
}

export async function upsertChannelIdentity(input: {
    channelType: ChannelType;
    channelIdentifier: string;
    familyId: string;
    userId: string;
    role: FamilyRole;
    label?: string;
}) {
    const normalized = normalizeChannelIdentifier(input.channelType, input.channelIdentifier);
    return ChannelIdentity.findOneAndUpdate(
        { channelType: input.channelType, channelIdentifier: normalized },
        {
            $set: {
                familyId: input.familyId,
                userId: input.userId,
                role: input.role,
                label: input.label,
                active: true,
            },
            $setOnInsert: {
                identityId: randomUUID(),
            },
        },
        { upsert: true, new: true },
    );
}

export async function listChannelIdentities(familyId: string) {
    return ChannelIdentity.find({ familyId, active: true }).lean();
}
