import { randomUUID } from "crypto";
import ChannelIdentity from "../models/channelIdentity.model";
import { AppError } from "../middleware/error.middleware";
import { ChannelType } from "../types/careRecord.types";
import { FamilyRole } from "../types/family.types";

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

export async function resolveChannelIdentity(
    channelType: ChannelType,
    channelIdentifier: string,
) {
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
