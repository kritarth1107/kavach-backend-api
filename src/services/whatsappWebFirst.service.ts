/**
 * Web first, then WhatsApp (founder 2026-10-13: "invite onboarding should not start with whatsapp. people can only access
 * saheli via whatsapp when they have completed the onboarding via web. so send saheli hi should appear at end of
 * onboarding. onboarding can not be done via sending hi with invite code on whatsapp.").
 *
 *  - WhatsApp never makes an account or a family, whatever the message says. A number Kavach can't place in a family
 *    gets one short line pointing to the web (answerUnknownNumber): a valid invite code → its join link (the invite stays
 *    unused); an approved waitlist number → the web sign-up; someone part-way through the web setup → finish it there;
 *    anyone else → the waitlist line and a waitlist entry (or the web sign-up, when invite-only is switched off).
 *  - A caregiver or self-care account that has not finished the web onboarding gets one line pointing to it, and their
 *    message goes no further (webSetupUnfinished). People cared for, and anyone a caregiver added to their family, are
 *    never asked: their accounts come from the family invitation and they talk to Saheli on WhatsApp straight away.
 *
 * (On 12-13 Oct 2026 a hi from a new number made an account and Saheli ran a setup chat on WhatsApp; that is retired.)
 */
import Family from "../models/family.model";
import { PhoneVerification } from "../models/onboarding.model";
import User from "../models/users.model";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import type { DenyReason } from "./invite.service";

export type UnknownNumberReply = {
    kind: "invite" | "approved" | "setup" | "family_setup" | "open" | "waitlist";
    reply: string;
};

const WAITLIST_REPLY: Record<DenyReason, string> = {
    invite_required: "Namaste 🙏 Kavach is invite-only for now, so I've added you to the waitlist. Once you're in, you'll sign up on the web and then we can talk here.",
    invite_used: "Namaste 🙏 That invite has already been used, and Kavach is invite-only for now, so I've added you to the waitlist.",
    invite_expired: "Namaste 🙏 That invite has expired, and Kavach is invite-only for now, so I've added you to the waitlist.",
    invite_revoked: "Namaste 🙏 That invite was cancelled, and Kavach is invite-only for now, so I've added you to the waitlist.",
    invite_invalid: "Namaste 🙏 I couldn't find that invite code, and Kavach is invite-only for now, so I've added you to the waitlist.",
};

async function links() {
    const { dashboardBaseUrl } = await import("./invite.service");
    const base = dashboardBaseUrl();
    return { signIn: `${base}/auth/login`, onboarding: `${base}/onboarding` };
}

/** The one line an account that hasn't finished the web setup gets on WhatsApp. */
export async function finishOnWebLine(): Promise<string> {
    return `Namaste 🙏 Finish setting up at ${(await links()).onboarding}, then say hi here.`;
}

/** completeOnboarding runs only in these states; any other (done, or no status on older accounts) is "already set up". */
const UNFINISHED = ["pending", "skipped"];
const unfinished = (u: { onboarding?: { status?: string } } | null) => UNFINISHED.includes(String(u?.onboarding?.status ?? ""));

/**
 * Has this WhatsApp sender not finished the web onboarding? The same rule the onboarding itself uses for "already set
 * up" (onboarding.status pending or skipped = not yet; done, or no status on accounts from before onboarding existed =
 * set up). Only for the primary caregiver of the family the sender resolved to (a self-care account is one too); never
 * for the person cared for, or for anyone who is a member of someone else's family (a caregiver added them; joining
 * marks their own onboarding "skipped").
 */
export async function webSetupUnfinished(identity: { userId: string; role: string }): Promise<boolean> {
    if (identity.role !== FamilyRole.PRIMARY_CAREGIVER) return false;
    const u = await User.findOne({ userId: identity.userId }).select("onboarding").lean<{ onboarding?: { status?: string } }>();
    if (!unfinished(u)) return false;
    const added = await Family.exists({
        status: "ACTIVE",
        members: {
            $elemMatch: {
                userId: identity.userId,
                role: { $ne: FamilyRole.PRIMARY_CAREGIVER },
                status: { $nin: [FamilyMemberStatus.REMOVED, FamilyMemberStatus.REJECTED] },
            },
        },
    });
    return !added;
}

/**
 * A message from a number that resolves to no one in a family. Null: answer with the usual "I don't recognise this
 * number" (a broken number, or one already given for someone in a family). Nothing is created here except a waitlist
 * entry for an uninvited stranger; an invite is only looked at, never used.
 */
export async function answerUnknownNumber(phone: string, opts: { profileName?: string; text?: string; now?: Date } = {}): Promise<UnknownNumberReply | null> {
    const digits = String(phone ?? "").replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    const { splitPhone } = await import("./onboarding.service");
    const { cc, number } = splitPhone(`+${digits}`);
    if (cc === "+99") return null; // the internal placeholder, never a real number
    const now = opts.now ?? new Date();

    const { findPhoneHolder, findPhoneOwner } = await import("./phoneOwner.service");
    // their account exists (made on the web) but has no family to answer from yet: the web setup gives it one. An
    // account a family invitation made (never set up by them) just gets the usual line.
    const owner = await findPhoneOwner(cc, number);
    if (owner) return unfinished(owner) ? { kind: "setup", reply: await finishOnWebLine() } : null;
    if (await findPhoneHolder(cc, number)) return null;

    // a number proven in a web setup that isn't finished yet: their own (finish it there), or someone they are adding
    const proven = await PhoneVerification.findOne({ phoneKey: digits.slice(-10), verifiedAt: { $ne: null } })
        .sort({ verifiedAt: -1 })
        .lean<{ userId: string; target: string }>();
    if (proven && unfinished(await User.findOne({ userId: proven.userId }).select("onboarding").lean<{ onboarding?: { status?: string } }>())) {
        return proven.target === "self"
            ? { kind: "setup", reply: await finishOnWebLine() }
            : { kind: "family_setup", reply: "Namaste 🙏 Your family is still setting me up on Kavach. I'll be right here as soon as they finish." };
    }

    const { checkSignupAccess, inviteCodeFromText, joinUrl } = await import("./invite.service");
    const inviteToken = inviteCodeFromText(opts.text);
    const access = await checkSignupAccess({ inviteToken, phoneDigits: digits }, now);
    const l = await links();
    if (access.ok && access.via === "invite" && inviteToken) {
        return { kind: "invite", reply: `Namaste 🙏 Please open your invite link to sign up on the web: ${joinUrl(inviteToken)}` };
    }
    if (access.ok && access.via === "waitlist") {
        return { kind: "approved", reply: `Namaste 🙏 You're off the waitlist! Sign up on the web with this number at ${l.signIn}, then say hi here once you've finished setting up.` };
    }
    if (access.ok) {
        return { kind: "open", reply: `Namaste 🙏 I'm Saheli from Kavach. Sign up at ${l.signIn}, finish setting up there, then say hi here.` };
    }
    const { waitlistFromWhatsApp } = await import("./waitlist.service");
    await waitlistFromWhatsApp(phone, opts.profileName, now).catch((err) =>
        console.warn("[web-first] waitlist entry failed:", err instanceof Error ? err.message : err),
    );
    return { kind: "waitlist", reply: WAITLIST_REPLY[access.reason] };
}
