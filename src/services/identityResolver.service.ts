import { randomUUID } from "crypto";
import { isPlaceholderWhatsAppNumber } from "./whatsappRecipientGuard.service";
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
import { INTERNAL_PHONE_COUNTRY_CODE, isInternalPhone, normalizePhoneInput } from "../utils/phone.util";

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

type PhoneFields = { userId: string; phone?: { countryCode?: string; number?: string } | null; phoneKey?: string };

/** The random internal placeholder an account gets when it has no phone ("+99" + the same digits as its key). */
export function isRandomPlaceholder(u: Omit<PhoneFields, "userId">): boolean {
    return isInternalPhone(u.phone?.countryCode) && u.phoneKey === `${INTERNAL_PHONE_COUNTRY_CODE}${u.phone?.number ?? ""}`;
}

/** Accounts whose number is this sender's; exact number matches first. A random placeholder that happens to share
 *  the digits is nobody's number and never matches (most accounts carry one: 17 of 22 on 2026-10-11). */
async function findUsersByWhatsAppPhone(normalized: string) {
    const { last10, keys } = phoneLookupVariants(normalized);

    const rows = await User.find({
        $or: [
            ...keys.map((phoneKey) => ({ phoneKey })),
            ...(last10.length === 10
                ? [
                      { "phone.countryCode": "+91", "phone.number": last10 },
                      { "phone.number": last10 },
                  ]
                : []),
        ],
    })
        .limit(5)
        .lean();
    const people = rows.filter((u) => !isRandomPlaceholder(u));
    const exact = people.filter((u) => u.phoneKey && keys.includes(u.phoneKey));
    return exact.length ? exact : people;
}

/**
 * The real number for an account whose 10 digits were saved under the internal "+99" code (the settings page showed
 * the placeholder's code until 2026-10-11, so a typed number kept it), taken from the number WhatsApp shows for the
 * sender. Null when the account's number is not of that kind or does not end the sender's number.
 */
export function realNumberFromSender(u: Omit<PhoneFields, "userId">, normalizedSender: string) {
    const number = String(u.phone?.number ?? "");
    const digits = normalizedSender.replace(/\D/g, "");
    if (!isInternalPhone(u.phone?.countryCode) || isRandomPlaceholder(u)) return null;
    if (number.length !== 10 || digits.length <= 10 || !digits.endsWith(number)) return null;
    const countryCode = `+${digits.slice(0, -10)}`;
    if (isInternalPhone(countryCode)) return null;
    return { countryCode, number, phoneKey: `${countryCode}${number}` };
}

/** Outbound messages and store logins skip "+99" numbers, so such a person could write to Saheli but never hear from
 *  her first. WhatsApp has just shown their real number: put it on the account. Best effort. */
async function claimSenderNumber(u: PhoneFields, normalizedSender: string): Promise<void> {
    try {
        const real = realNumberFromSender(u, normalizedSender);
        if (!real) return;
        if (await User.exists({ phoneKey: real.phoneKey, userId: { $ne: u.userId } })) return;
        await User.updateOne(
            { userId: u.userId, "phone.countryCode": INTERNAL_PHONE_COUNTRY_CODE, "phone.number": real.number },
            { $set: { phone: { countryCode: real.countryCode, number: real.number }, phoneKey: real.phoneKey } },
        );
    } catch {
        // the sender was still recognised; their next message tries again
    }
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

    const users = await findUsersByWhatsAppPhone(normalized);
    const user = users[0];
    if (user) {
        const membership = await resolveFamilyMembership(user.userId);
        if (membership) {
            if (users.length === 1) await claimSenderNumber(user, normalized);
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
    return resolveRecipientWhatsAppPhone(userId);
}

/** Best-effort WhatsApp number for outbound nudges and care messages. */
export async function resolveRecipientWhatsAppPhone(
    userId: string,
    familyId?: string,
): Promise<string | null> {
    const user = await User.findOne({ userId }).lean();
    if (user?.phone?.countryCode && user.phone.number && !isInternalPhone(user.phone.countryCode)) {
        return normalizeChannelIdentifier(
            ChannelType.WHATSAPP,
            `${user.phone.countryCode}${user.phone.number}`,
        );
    }

    const channelRow = await ChannelIdentity.findOne({
        userId,
        channelType: ChannelType.WHATSAPP,
        active: true,
        ...(familyId ? { familyId } : {}),
    })
        .sort({ updatedAt: -1 })
        .lean();
    if (channelRow?.channelIdentifier) {
        const candidate = normalizeChannelIdentifier(ChannelType.WHATSAPP, channelRow.channelIdentifier);
        const userPlaceholderKey =
            user?.phone?.countryCode && isInternalPhone(user.phone.countryCode)
                ? `${user.phone.countryCode}${user.phone.number ?? ""}`.replace(/\D/g, "")
                : "";
        // Smoke +999 fixtures resolve (deliverOutboundMessage simulates their sends; never Meta).
        const { isSmokeFixturePhone } = await import("./smokeFixtures.service");
        if (isSmokeFixturePhone(candidate)) return candidate;
        if (
            candidate.replace(/\D/g, "") !== userPlaceholderKey &&
            !(await isPlaceholderWhatsAppNumber(candidate))
        ) {
            return candidate;
        }
        console.warn(`resolveRecipientWhatsAppPhone: skipping placeholder channel identity for user ${userId}`);
    }

    const invite = await FamilyInvitation.findOne({
        userId,
        role: FamilyRole.CARE_RECIPIENT,
        status: FamilyInvitationStatus.ACCEPTED,
        phone: { $exists: true, $ne: "" },
        ...(familyId ? { familyId } : {}),
    })
        .sort({ updatedAt: -1 })
        .lean();
    if (invite?.phone && invite.phoneCountryCode && !isInternalPhone(invite.phoneCountryCode)) {
        try {
            const normalized = normalizePhoneInput(invite.phoneCountryCode, invite.phone);
            const candidate = normalizeChannelIdentifier(
                ChannelType.WHATSAPP,
                `${normalized.countryCode}${normalized.number}`,
            );
            if (!isInternalPhone(normalized.countryCode) && !(await isPlaceholderWhatsAppNumber(candidate))) {
                return candidate;
            }
        } catch {
            // fall through
        }
    }

    if (familyId) {
        const { getFamilyMembersList } = await import("./familyMember.service");
        try {
            const list = await getFamilyMembersList(familyId, userId);
            const member = list.members.find((m) => m.userId === userId);
            if (member?.phone && member.phoneCountryCode && !isInternalPhone(member.phoneCountryCode)) {
                const normalized = normalizePhoneInput(member.phoneCountryCode, member.phone);
                const candidate = normalizeChannelIdentifier(
                    ChannelType.WHATSAPP,
                    `${normalized.countryCode}${normalized.number}`,
                );
                if (!isInternalPhone(normalized.countryCode) && !(await isPlaceholderWhatsAppNumber(candidate))) {
                    return candidate;
                }
            }
        } catch {
            // access denied or missing family
        }
    }

    return null;
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
