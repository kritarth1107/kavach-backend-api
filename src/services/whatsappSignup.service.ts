/**
 * Sign-up on WhatsApp (founder 2026-10-12: "we should be able to onboard users from WhatsApp itself; if a new user sends
 * hi, start their onboarding directly"). A number Kavach does not know gets an account and a family on its first
 * message (the message itself proves they hold the number), then Saheli's setup chat takes over (brain v2 gets
 * onboarding: true until the setup is finished). Their name starts as the one on their WhatsApp profile.
 *
 * Limits keep a flood of strangers from making accounts: SIGNUPS_PER_HOUR and SIGNUPS_PER_DAY across everyone; over
 * them, the old "sign up on the website" answer goes out. WHATSAPP_SIGNUP=off (env or admin flag) turns it off.
 *
 * Invite-only (founder 2026-10-13: "registration through WhatsApp hi should be closed for now; only via invitation
 * link"): a new number needs a valid invite code in the message ("hi KAVACH-…", what the invite link's WhatsApp
 * button types in) or an approved waitlist entry. Anyone else gets no account: one friendly line and a waitlist entry.
 */
import User from "../models/users.model";
import { flaggedEnv } from "./featureFlags.service";
import type { DenyReason } from "./invite.service";

export const SIGNUPS_PER_HOUR = 30;
export const SIGNUPS_PER_DAY = 200;

export type SignupResult =
    | { ok: true; userId: string; familyId: string; created: boolean }
    | { ok: false; reason: "off" | "limit" | "taken" | "invalid" }
    | { ok: false; reason: "waitlist"; reply: string };

const WAITLIST_REPLY: Record<DenyReason, string> = {
    invite_required: "Namaste 🙏 Kavach is invite-only for now, so I've added you to the waitlist; once you're in, just say hi here again.",
    invite_used: "Namaste 🙏 That invite has already been used, and Kavach is invite-only for now, so I've added you to the waitlist.",
    invite_expired: "Namaste 🙏 That invite has expired, and Kavach is invite-only for now, so I've added you to the waitlist.",
    invite_revoked: "Namaste 🙏 That invite was cancelled, and Kavach is invite-only for now, so I've added you to the waitlist.",
    invite_invalid: "Namaste 🙏 I couldn't find that invite code, and Kavach is invite-only for now, so I've added you to the waitlist.",
};

async function toWaitlist(phone: string, reason: DenyReason, profileName?: string): Promise<SignupResult> {
    const { waitlistFromWhatsApp } = await import("./waitlist.service");
    await waitlistFromWhatsApp(phone, profileName).catch((err) =>
        console.warn("[whatsapp-signup] waitlist entry failed:", err instanceof Error ? err.message : err),
    );
    return { ok: false, reason: "waitlist", reply: WAITLIST_REPLY[reason] };
}

function cleanName(raw: string | undefined): string {
    const name = String(raw ?? "").replace(/[^\p{L}\p{M}\s.'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    return name.length >= 2 ? name : "Friend";
}

export async function startWhatsAppSignup(phone: string, opts: { profileName?: string; text?: string; now?: Date } = {}): Promise<SignupResult> {
    if (String(flaggedEnv().WHATSAPP_SIGNUP ?? "on").toLowerCase() === "off") return { ok: false, reason: "off" };
    const digits = String(phone ?? "").replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return { ok: false, reason: "invalid" };
    const { splitPhone } = await import("./onboarding.service");
    const { cc, number } = splitPhone(`+${digits}`);
    if (cc === "+99") return { ok: false, reason: "invalid" }; // the internal placeholder, never a real number

    // a number already given for someone in a family (an invited parent, say) never gets an account of its own here
    const { findPhoneHolder, findPhoneOwner } = await import("./phoneOwner.service");
    const owner = await findPhoneOwner(cc, number);
    if (!owner && (await findPhoneHolder(cc, number))) return { ok: false, reason: "taken" };

    const now = opts.now ?? new Date();
    if (owner) {
        // their account exists (made on the website, or on an earlier message) but had no family to answer from: give it one
        let fid = owner.activeFamilyId || owner.primaryFamilyId;
        if (!fid) {
            const { createDefaultFamilyForUser } = await import("./family.service");
            fid = (await createDefaultFamilyForUser(owner)).familyId;
        }
        return { ok: true, userId: owner.userId, familyId: fid!, created: false };
    }
    // invite-only: a valid code in the message, or an approved waitlist entry for this number; else the waitlist
    const { checkSignupAccess, inviteCodeFromText, isSignupDenied } = await import("./invite.service");
    const inviteToken = inviteCodeFromText(opts.text);
    const access = await checkSignupAccess({ inviteToken, phoneDigits: digits }, now);
    if (!access.ok) return toWaitlist(phone, access.reason, opts.profileName);

    const since = (ms: number) => new Date(now.getTime() - ms);
    const recent = async (ms: number) => User.countDocuments({ signupSource: "whatsapp", createdAt: { $gte: since(ms) } });
    if ((await recent(3_600_000)) >= SIGNUPS_PER_HOUR || (await recent(86_400_000)) >= SIGNUPS_PER_DAY) {
        console.warn(`[whatsapp-signup] limit reached; ${cc}…${number.slice(-2)} gets the website answer`);
        return { ok: false, reason: "limit" };
    }

    const { findOrCreatePhoneUser } = await import("./auth.service");
    let user: Awaited<ReturnType<typeof findOrCreatePhoneUser>>;
    try {
        user = await findOrCreatePhoneUser(cc, number, cleanName(opts.profileName), { inviteToken, via: "whatsapp" });
    } catch (err) {
        // the code was used by someone else a moment ago
        if (isSignupDenied(err)) return toWaitlist(phone, err.code as DenyReason, opts.profileName);
        throw err;
    }
    await User.updateOne({ userId: user.userId }, { $set: { phoneVerifiedAt: now, signupSource: "whatsapp", "onboarding.status": "pending" } });
    let familyId = user.activeFamilyId || user.primaryFamilyId;
    if (!familyId) {
        const { createDefaultFamilyForUser } = await import("./family.service");
        familyId = (await createDefaultFamilyForUser(user)).familyId;
    }
    void import("./activityLog.service")
        .then(({ logActivity }) =>
            logActivity({
                familyId: familyId!,
                recipientUserId: user.userId,
                actorUserId: user.userId,
                kind: "diag",
                title: "Signed up on WhatsApp",
                detail: "Saheli is setting the family up in the chat.",
                data: { source: "whatsapp" },
            }),
        )
        .catch(() => undefined);
    return { ok: true, userId: user.userId, familyId: familyId!, created: true };
}

/** Has this person not finished setting up (a new WhatsApp sign-up, or a dashboard account that never finished)? */
export async function setupPending(userId: string): Promise<boolean> {
    const u = await User.findOne({ userId }).select("onboarding").lean<{ onboarding?: { status?: string } }>();
    return u?.onboarding?.status === "pending";
}

/** Saheli's setup chat is done: the account counts as onboarded (the dashboard will not ask again). */
export async function finishSetup(userId: string, now: Date = new Date()): Promise<void> {
    await User.updateOne({ userId }, { $set: { "onboarding.status": "done", "onboarding.at": now } });
}
