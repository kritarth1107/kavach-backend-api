/**
 * Invite links and the invite-only gate (founder 2026-10-13: "only invited people can register, else they cannot;
 * registration through WhatsApp hi closed for now; one link for one registration, invalid after use; any registered
 * user can invite 5 people in a week; generate links in real time, not all at once").
 *
 *  - A link is made one at a time, on request: a random 26-character code (130 bits), valid 14 days, used once.
 *  - At most INVITES_PER_WEEK links per person in any 7 days (every link made counts, revoked ones too).
 *  - Every way a new account is made goes through gatedSignup(): a valid invite (consumed atomically: one
 *    findOneAndUpdate from "active" to "used", so two people racing for one link get one account between them), or an
 *    approved waitlist entry for that email or number, or invite-only switched off. Otherwise: 403 with a code the
 *    dashboard turns into the waitlist form.
 *  - Existing accounts never come here, and neither do family members a caregiver adds (their account is made by the
 *    family invitation itself).
 */
import { createHash, randomInt, randomUUID } from "crypto";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";
import Invite, { type IInvite } from "../models/invite.model";
import User from "../models/users.model";
import { inviteOnlyEnabled } from "./featureFlags.service";

export const INVITES_PER_WEEK = 5;
export const INVITE_TTL_DAYS = 14;
/** The personal link in a waitlist approval email lives longer: the email may sit unread for a while. */
export const APPROVAL_LINK_TTL_DAYS = 30;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/* ── the code ─────────────────────────────────────────────────────────────── */

/** Crockford base32: no I, L, O or U, so a code read aloud or retyped survives. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TOKEN_LENGTH = 26; // 26 × 5 = 130 random bits

export function newInviteToken(): string {
    let out = "";
    for (let i = 0; i < TOKEN_LENGTH; i++) out += ALPHABET[randomInt(32)];
    return out;
}

/** The code from a link or a message, upper-cased with look-alikes mapped (I/L → 1, O → 0); null if it can't be one. */
export function normalizeInviteToken(raw: unknown): string | null {
    const t = String(raw ?? "")
        .trim()
        .toUpperCase()
        .replace(/^KAVACH[-\s]?/, "")
        .replace(/[IL]/g, "1")
        .replace(/O/g, "0");
    return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(t) ? t : null;
}

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** "hi KAVACH-7Q…" (what the wa.me link pre-fills). Never a 6-digit number, so it can't be read as a phone-verify code. */
const CODE_IN_TEXT = /\bKAVACH[-\s]?([0-9A-Za-z]{26})\b/i;

export function inviteCodeFromText(text: unknown): string | null {
    const m = CODE_IN_TEXT.exec(String(text ?? ""));
    return m ? normalizeInviteToken(m[1]) : null;
}

/** The message without the code ("hi KAVACH-…" → "hi"), so Saheli's setup chat never sees it. */
export function stripInviteCode(text: string): string {
    return text.replace(CODE_IN_TEXT, "").replace(/\s+/g, " ").trim();
}

/* ── links ────────────────────────────────────────────────────────────────── */

export function dashboardBaseUrl(): string {
    return String(process.env.DASHBOARD_URL || process.env.LIVE_FRONTEND_URL || "https://app.kavach.care").replace(/\/+$/, "");
}

export const saheliNumber = () => config.whatsapp.kavachNumber;

export function joinUrl(token: string): string {
    return `${dashboardBaseUrl()}/join/${token}`;
}

/** wa.me link to Saheli with "hi" (and the invite code) typed in. */
export function saheliWhatsAppUrl(token?: string | null): string {
    const digits = String(saheliNumber()).replace(/\D/g, "");
    return `https://wa.me/${digits}?text=${encodeURIComponent(token ? `hi KAVACH-${token}` : "hi")}`;
}

/* ── states ───────────────────────────────────────────────────────────────── */

export type InviteState = "active" | "used" | "expired" | "revoked";

export function stateOf(inv: Pick<IInvite, "status" | "expiresAt">, now = new Date()): InviteState {
    if (inv.status === "used") return "used";
    if (inv.status === "revoked") return "revoked";
    return new Date(inv.expiresAt).getTime() <= now.getTime() ? "expired" : "active";
}

const iso = (d?: Date | string | null) => (d ? new Date(d).toISOString() : null);
const nameOf = (u?: { firstName?: string; lastName?: string } | null) => [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();

/* ── a person's links (dashboard: Invitations) ────────────────────────────── */

export type InviteQuota = { limit: number; used: number; left: number; nextSlotAt: string | null };

export async function inviteQuota(userId: string, now = new Date()): Promise<InviteQuota> {
    const since = new Date(now.getTime() - WEEK_MS);
    const recent = await Invite.find({ inviterUserId: userId, kind: "user", createdAt: { $gte: since } })
        .select("createdAt")
        .lean<Array<{ createdAt: Date }>>();
    const used = recent.length;
    const oldest = recent.map((r) => new Date(r.createdAt).getTime()).sort((a, b) => a - b)[0];
    return {
        limit: INVITES_PER_WEEK,
        used: Math.min(used, INVITES_PER_WEEK),
        left: Math.max(0, INVITES_PER_WEEK - used),
        // when a link made this week drops out of the 7 days, one more can be made
        nextSlotAt: used >= INVITES_PER_WEEK && oldest ? new Date(oldest + WEEK_MS).toISOString() : null,
    };
}

function limitError(q: InviteQuota): AppError {
    return new AppError(
        `You've made ${INVITES_PER_WEEK} invite links in the last 7 days. You can make another one soon.`,
        429,
        { code: "invite_limit", data: { nextSlotAt: q.nextSlotAt, limit: INVITES_PER_WEEK } },
    );
}

export type InviteView = {
    inviteId: string;
    state: InviteState;
    createdAt: string | null;
    expiresAt: string | null;
    usedAt: string | null;
    usedByName: string | null;
    revokedAt: string | null;
    /** Only while the link can still be used. */
    link: string | null;
    whatsappLink: string | null;
    code: string | null;
};

function viewOf(inv: IInvite & { token?: string | null }, now: Date, usedByName: string | null = null): InviteView {
    const state = stateOf(inv, now);
    const token = state === "active" ? inv.token ?? null : null;
    return {
        inviteId: inv.inviteId,
        state,
        createdAt: iso(inv.createdAt),
        expiresAt: iso(inv.expiresAt),
        usedAt: iso(inv.usedAt),
        usedByName,
        revokedAt: iso(inv.revokedAt),
        link: token ? joinUrl(token) : null,
        whatsappLink: token ? saheliWhatsAppUrl(token) : null,
        code: token ? `KAVACH-${token}` : null,
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A new link, made now (never in bulk). Two clicks at once may both pass the first count, so each new link counts the
 * week again after it is written and steps back (deletes itself) if that count is over the limit. The last survivor to
 * count saw every other survivor, so at most INVITES_PER_WEEK ever survive; one that stepped back tries again shortly.
 */
export async function createInvite(userId: string, now = new Date()): Promise<{ invite: InviteView; quota: InviteQuota }> {
    if (!(await User.exists({ userId }))) throw new AppError("User not found", 404);
    const since = new Date(now.getTime() - WEEK_MS);
    for (let attempt = 0; attempt < 5; attempt++) {
        const before = await inviteQuota(userId, now);
        if (before.left <= 0) throw limitError(before);

        const token = newInviteToken();
        const inviteId = randomUUID();
        const doc = await Invite.create({
            inviteId,
            kind: "user",
            tokenHash: hashInviteToken(token),
            token,
            inviterUserId: userId,
            status: "active",
            expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * DAY_MS),
            createdAt: now,
        });
        const count = await Invite.countDocuments({ inviterUserId: userId, kind: "user", createdAt: { $gte: since } });
        if (count <= INVITES_PER_WEEK) {
            return { invite: viewOf({ ...doc.toObject(), token }, now), quota: await inviteQuota(userId, now) };
        }
        await Invite.deleteOne({ inviteId });
        await sleep(20 + Math.random() * 60 * (attempt + 1));
    }
    throw limitError(await inviteQuota(userId, now));
}

export async function listInvites(userId: string, now = new Date()): Promise<{ quota: InviteQuota; invites: InviteView[]; perWeek: number; validDays: number }> {
    const rows = await Invite.find({ inviterUserId: userId, kind: "user" })
        .select("+token")
        .lean<Array<IInvite & { token?: string | null }>>();
    rows.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
    const shown = rows.slice(0, 100);

    // an expired link's code is of no use to anyone: wipe it (best effort)
    const stale = shown.filter((r) => r.token && stateOf(r, now) === "expired").map((r) => r.inviteId);
    if (stale.length) void Invite.updateMany({ inviteId: { $in: stale } }, { $set: { token: null } }).catch(() => undefined);

    const usedIds = shown.map((r) => r.usedByUserId).filter((x): x is string => Boolean(x));
    const people = usedIds.length
        ? await User.find({ userId: { $in: usedIds } }).select("userId firstName lastName").lean<Array<{ userId: string; firstName?: string; lastName?: string }>>()
        : [];
    const byId = new Map(people.map((p) => [p.userId, nameOf(p) || "Someone"]));
    return {
        quota: await inviteQuota(userId, now),
        invites: shown.map((r) => viewOf(r, now, r.usedByUserId ? byId.get(r.usedByUserId) ?? "Someone" : r.status === "used" ? "Someone" : null)),
        perWeek: INVITES_PER_WEEK,
        validDays: INVITE_TTL_DAYS,
    };
}

export async function revokeInvite(userId: string, inviteId: string, now = new Date()): Promise<InviteView> {
    const res = await Invite.updateOne(
        { inviteId, inviterUserId: userId, kind: "user", status: "active" },
        { $set: { status: "revoked", revokedAt: now, token: null } },
    );
    const inv = await Invite.findOne({ inviteId, inviterUserId: userId, kind: "user" }).lean<IInvite>();
    if (!inv) throw new AppError("Invite not found", 404);
    if (res.modifiedCount !== 1 && inv.status === "used") throw new AppError("This link was already used to join, so it can't be cancelled.", 409, { code: "invite_used" });
    return viewOf(inv, now);
}

/* ── the join page ────────────────────────────────────────────────────────── */

export type PublicInvite = {
    state: InviteState | "invalid";
    kind: "user" | "waitlist" | null;
    inviterName: string | null;
    expiresAt: string | null;
    saheliNumber: string;
    whatsappLink: string | null;
};

export async function lookupInvite(raw: unknown, now = new Date()): Promise<PublicInvite> {
    const token = normalizeInviteToken(raw);
    const none: PublicInvite = { state: "invalid", kind: null, inviterName: null, expiresAt: null, saheliNumber: saheliNumber(), whatsappLink: null };
    if (!token) return none;
    const inv = await Invite.findOne({ tokenHash: hashInviteToken(token) }).lean<IInvite>();
    if (!inv) return none;
    const state = stateOf(inv, now);
    let inviterName: string | null = null;
    if (inv.kind === "waitlist") inviterName = "The Kavach team";
    else if (inv.inviterUserId) {
        const u = await User.findOne({ userId: inv.inviterUserId }).select("firstName lastName").lean<{ firstName?: string; lastName?: string }>();
        inviterName = nameOf(u) || null;
    }
    return {
        state,
        kind: inv.kind,
        inviterName,
        expiresAt: iso(inv.expiresAt),
        saheliNumber: saheliNumber(),
        whatsappLink: state === "active" ? saheliWhatsAppUrl(token) : null,
    };
}

/* ── the gate ─────────────────────────────────────────────────────────────── */

export type DenyReason = "invite_required" | "invite_used" | "invite_expired" | "invite_revoked" | "invite_invalid";

export type SignupAccess =
    | { ok: true; via: "invite"; tokenHash: string }
    | { ok: true; via: "waitlist"; waitlistId: string }
    | { ok: true; via: "open" }
    | { ok: false; reason: DenyReason };

export type SignupContact = {
    inviteToken?: unknown;
    email?: string | null;
    /** Digits with the country code ("919000000101"). */
    phoneDigits?: string | null;
};

const DENY_COPY: Record<DenyReason, string> = {
    invite_required: "Kavach is invite-only for now. Join the waitlist and we'll let you in soon.",
    invite_used: "This invite link has already been used. Ask for a new one, or join the waitlist.",
    invite_expired: "This invite link has expired. Ask for a new one, or join the waitlist.",
    invite_revoked: "This invite link was cancelled. Ask for a new one, or join the waitlist.",
    invite_invalid: "This invite link isn't valid. Check the link, or join the waitlist.",
};

export function signupDenied(reason: DenyReason, data: Record<string, unknown> = {}): AppError {
    return new AppError(DENY_COPY[reason], 403, { code: reason, data: { waitlist: true, ...data } });
}

export const isSignupDenied = (err: unknown): err is AppError =>
    err instanceof AppError && err.statusCode === 403 && typeof err.code === "string" && err.code in DENY_COPY;

/** May this contact make a new account now? Reads only; nothing is consumed. */
export async function checkSignupAccess(input: SignupContact, now = new Date()): Promise<SignupAccess> {
    let tokenReason: DenyReason | null = null;
    if (input.inviteToken !== undefined && input.inviteToken !== null && String(input.inviteToken).trim()) {
        const token = normalizeInviteToken(input.inviteToken);
        const inv = token ? await Invite.findOne({ tokenHash: hashInviteToken(token) }).lean<IInvite>() : null;
        if (!inv) tokenReason = "invite_invalid";
        else {
            const state = stateOf(inv, now);
            if (state === "active") return { ok: true, via: "invite", tokenHash: inv.tokenHash };
            tokenReason = state === "used" ? "invite_used" : state === "expired" ? "invite_expired" : "invite_revoked";
        }
    }
    const { findApprovedWaitlist } = await import("./waitlist.service");
    const approved = await findApprovedWaitlist({ email: input.email, phoneDigits: input.phoneDigits });
    if (approved) return { ok: true, via: "waitlist", waitlistId: approved.waitlistId };
    if (!inviteOnlyEnabled()) return { ok: true, via: "open" };
    return { ok: false, reason: tokenReason ?? "invite_required" };
}

/**
 * Make a new account only if this contact may: `create` runs after the invite (if any) is consumed, and the invite is
 * given back if `create` fails. Throws signupDenied() otherwise.
 */
export async function gatedSignup<T extends { userId: string }>(
    input: SignupContact & { via: string },
    create: () => Promise<T>,
    now = new Date(),
): Promise<T> {
    const access = await checkSignupAccess(input, now);
    if (!access.ok) throw signupDenied(access.reason, { email: input.email || undefined });

    const { markRegistered } = await import("./waitlist.service");
    if (access.via !== "invite") {
        const user = await create();
        await markRegistered({ waitlistId: access.via === "waitlist" ? access.waitlistId : null, email: input.email, phoneDigits: input.phoneDigits }, user.userId, now);
        return user;
    }

    // The one atomic step: whoever moves the invite from "active" to "used" first gets it.
    const claimed = await Invite.findOneAndUpdate(
        { tokenHash: access.tokenHash, status: "active", expiresAt: { $gt: now } },
        { $set: { status: "used", usedAt: now, usedVia: input.via } },
        { new: true },
    ).lean<IInvite>();
    if (!claimed) {
        // someone else used it a moment ago; they may still be allowed another way (approved, or sign-up open)
        const again = await checkSignupAccess({ email: input.email, phoneDigits: input.phoneDigits }, now);
        if (!again.ok) throw signupDenied("invite_used", { email: input.email || undefined });
        return gatedSignup({ email: input.email, phoneDigits: input.phoneDigits, via: input.via }, create, now);
    }

    let user: T;
    try {
        user = await create();
    } catch (err) {
        // no account was made: the link can still be used
        await Invite.updateOne(
            { inviteId: claimed.inviteId, status: "used", usedByUserId: null },
            { $set: { status: "active", usedAt: null, usedVia: null } },
        ).catch(() => undefined);
        throw err;
    }
    await Invite.updateOne({ inviteId: claimed.inviteId }, { $set: { usedByUserId: user.userId, token: null } });
    await markRegistered({ waitlistId: claimed.waitlistId ?? null, email: input.email, phoneDigits: input.phoneDigits }, user.userId, now);
    return user;
}

/** A personal link for an approved waitlist entry (the one in the approval email). Earlier unused ones stop working. */
export async function createWaitlistInvite(waitlistId: string, now = new Date()): Promise<{ token: string; link: string; whatsappLink: string; expiresAt: Date }> {
    await Invite.updateMany(
        { waitlistId, kind: "waitlist", status: "active" },
        { $set: { status: "revoked", revokedAt: now, token: null } },
    );
    const token = newInviteToken();
    const expiresAt = new Date(now.getTime() + APPROVAL_LINK_TTL_DAYS * DAY_MS);
    await Invite.create({
        inviteId: randomUUID(),
        kind: "waitlist",
        tokenHash: hashInviteToken(token),
        token,
        waitlistId,
        status: "active",
        expiresAt,
        createdAt: now,
    });
    return { token, link: joinUrl(token), whatsappLink: saheliWhatsAppUrl(token), expiresAt };
}

export async function revokeWaitlistInvites(waitlistId: string, now = new Date()): Promise<void> {
    await Invite.updateMany({ waitlistId, kind: "waitlist", status: "active" }, { $set: { status: "revoked", revokedAt: now, token: null } });
}
