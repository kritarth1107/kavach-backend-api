import { randomUUID } from "crypto";
import ChannelIdentity from "../models/channelIdentity.model";
import Family from "../models/family.model";
import User from "../models/users.model";
import { AppError } from "../middleware/error.middleware";
import { ChannelType } from "../types/careRecord.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { isInternalPhone } from "../utils/phone.util";

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

async function findUserByWhatsAppPhone(normalized: string) {
    const digits = normalized.replace(/\D/g, "");
    const last10 = digits.slice(-10);

    return User.findOne({
        $or: [
            { phoneKey: normalized },
            { phoneKey: `+${digits}` },
            ...(last10.length === 10
                ? [{ "phone.countryCode": "+91", "phone.number": last10 }]
                : []),
        ],
    }).lean();
}

async function resolveFamilyMembership(userId: string) {
    const families = await Family.find({
        status: "ACTIVE",
        members: {
            $elemMatch: { userId, status: FamilyMemberStatus.JOINED },
        },
    }).lean();

    if (!families.length) return null;

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

    const user = await findUserByWhatsAppPhone(normalized);
    if (!user) {
        throw new AppError("Phone not recognized — sign up at Kavach or ask your caregiver to invite you", 404);
    }

    const membership = await resolveFamilyMembership(user.userId);
    if (!membership) {
        throw new AppError("No active Kavach family found for this phone", 404);
    }

    return {
        ...membership,
        channelIdentifier: normalized,
    };
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
