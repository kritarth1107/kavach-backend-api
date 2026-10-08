/**
 * Who a phone number belongs to on Kavach. One number, one person: the user with it on their account, or else someone
 * Saheli already talks to on it (their family invitation, or a WhatsApp link set by hand). Parents added before phones
 * were saved on accounts are known only that way, so sign-in, sign-up and adding a person must all look here, never
 * at the account field alone; otherwise a parent's number could sign up as a new caregiver.
 *
 * When the owner is found through an invitation or link, the number is written onto their account, so the unique
 * index and every other lookup see it from then on.
 */
import { randomBytes } from "crypto";
import ChannelIdentity from "../models/channelIdentity.model";
import FamilyInvitation from "../models/familyInvitation.model";
import User from "../models/users.model";
import { ChannelType } from "../types/careRecord.types";
import { FamilyInvitationStatus } from "../types/family.types";
import type { IUserDocument } from "../models/users.model";
import { isInternalPhone, normalizePhoneInput } from "../utils/phone.util";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every way the same number may have been written down ("+919876543210", "919876543210", "9876543210"). */
export function phoneVariants(countryCode: string, number: string): string[] {
    const cc = countryCode.trim().startsWith("+") ? countryCode.trim() : `+${countryCode.trim()}`;
    const digits = number.replace(/\D/g, "");
    const ccDigits = cc.replace(/\D/g, "");
    return [...new Set([`${cc}${digits}`, `${ccDigits}${digits}`, ...(cc === "+91" ? [digits] : [])])];
}

/** Write the number onto the owner's account when it has none (or only the internal placeholder). Best effort. */
async function claimNumber(userId: string, countryCode: string, number: string): Promise<void> {
    try {
        const p = normalizePhoneInput(countryCode, number);
        const user = await User.findOne({ userId }).lean<{ phone?: { countryCode?: string; number?: string } }>();
        if (!user || (user.phone?.number && !isInternalPhone(user.phone.countryCode))) return;
        if (await User.exists({ phoneKey: p.key, userId: { $ne: userId } })) return;
        await User.updateOne({ userId }, { $set: { phone: { countryCode: p.countryCode, number: p.number }, phoneKey: p.key } });
    } catch {
        /* the lookup still answered; the next one will try again */
    }
}

/**
 * Who holds this number besides an account: a WhatsApp link, or a family invitation (accepted first). Returns the
 * person's id even when their account record is missing, plus what the invitation knows about them.
 */
export async function findPhoneHolder(countryCode: string, number: string): Promise<{ userId: string; email?: string; name?: string; namePrefix?: string } | null> {
    const digits = number.replace(/\D/g, "");
    if (digits.length < 6) return null;
    const cc = countryCode.trim().startsWith("+") ? countryCode.trim() : `+${countryCode.trim()}`;
    const link = await ChannelIdentity.findOne({
        channelType: ChannelType.WHATSAPP,
        channelIdentifier: { $in: phoneVariants(cc, digits) },
        active: true,
    }).lean<{ userId?: string }>();
    const invites = await FamilyInvitation.find({
        phone: { $regex: `${escape(digits)}$` },
        status: { $in: [FamilyInvitationStatus.ACCEPTED, FamilyInvitationStatus.PENDING] },
        userId: { $exists: true, $nin: [null, ""] },
    })
        .sort({ updatedAt: -1 })
        .lean<Array<{ userId?: string; phone?: string; phoneCountryCode?: string; status?: string; email?: string; inviteeName?: string; namePrefix?: string }>>();
    const same = invites.filter((i) => {
        const theirCc = `+${(i.phoneCountryCode?.trim() || "+91").replace(/\D/g, "")}`;
        let theirs = String(i.phone ?? "").replace(/\D/g, "");
        const ccDigits = theirCc.slice(1);
        if (theirs.length > digits.length && theirs.startsWith(ccDigits)) theirs = theirs.slice(ccDigits.length);
        return theirs === digits && theirCc === cc;
    });
    const invite = same.find((i) => i.status === FamilyInvitationStatus.ACCEPTED) ?? same[0];
    const userId = link?.userId || invite?.userId;
    if (!userId) return null;
    const about = invite && invite.userId === userId ? invite : undefined;
    return { userId: String(userId), email: about?.email, name: about?.inviteeName, namePrefix: about?.namePrefix };
}

/**
 * The person this number belongs to, or null when nobody on Kavach has it. A person Saheli knows only through an
 * invitation or link whose account record is missing gets it recreated (same id, the invitation's name), so the
 * number stays theirs: it can never become somebody else's new account.
 */
export async function findPhoneOwner(countryCode: string, number: string): Promise<IUserDocument | null> {
    const direct = await User.findByPhone(countryCode, number);
    if (direct) return direct;
    const holder = await findPhoneHolder(countryCode, number);
    if (!holder) return null;
    const cc = countryCode.trim().startsWith("+") ? countryCode.trim() : `+${countryCode.trim()}`;
    const digits = number.replace(/\D/g, "");
    if (!(await User.exists({ userId: holder.userId }))) {
        try {
            const { ensureMemberUserAccount } = await import("./familyMember.service");
            await ensureMemberUserAccount({
                userId: holder.userId,
                email: holder.email || `${randomBytes(16).toString("hex")}@pending.kavach`,
                memberName: holder.name || "Family member",
                namePrefix: holder.namePrefix,
                phone: digits,
                phoneCountryCode: cc,
            });
            console.warn(`[phone owner] recreated the missing account record of ${holder.userId.slice(0, 8)} from their invitation`);
        } catch (err) {
            console.error("[phone owner] could not recreate account record:", err instanceof Error ? err.message : err);
        }
    }
    await claimNumber(holder.userId, cc, digits);
    return User.findOne({ userId: holder.userId });
}
