/**
 * The waitlist (founder 2026-10-13: "normal new users will be shown on waitlist; admin can approve the waitlist users;
 * send email to user when admin approves"). People land here from the dashboard (signing up without an invite) or from
 * WhatsApp ("hi" to Saheli from an unknown number). One entry per email or number: asking again only bumps it.
 * An approved entry lets that email or number register; the approval email carries a personal one-time link too.
 */
import { randomUUID } from "crypto";
import { AppError } from "../middleware/error.middleware";
import WaitlistEntry, { type IWaitlistEntry, type WaitlistStatus } from "../models/waitlist.model";
import { normalizePhoneInput } from "../utils/phone.util";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clip = (s: unknown, n: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const isPlaceholderEmail = (e?: string | null) => !e || /@pending\.kavach$/i.test(e) || /@smoke\.kavach\.test$/i.test(e);

/** "+91 90000 00101" / "9000000101" → "919000000101" (a bare 10-digit number is Indian). */
export function phoneDigitsOf(raw?: string | null): string | null {
    const d = String(raw ?? "").replace(/\D/g, "");
    if (!d) return null;
    if (d.length === 10) return `91${d}`;
    return d.length >= 8 && d.length <= 15 ? d : null;
}

export type WaitlistInput = {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    phoneCountryCode?: unknown;
    note?: unknown;
    source: "dashboard" | "whatsapp";
};

async function findByContact(email?: string | null, phoneDigits?: string | null) {
    if (email) {
        const byEmail = await WaitlistEntry.findOne({ email });
        if (byEmail) return byEmail;
    }
    if (phoneDigits) {
        const byPhone = await WaitlistEntry.findOne({ phoneDigits });
        if (byPhone) return byPhone;
    }
    return null;
}

/** Add someone to the waitlist (or bump their entry). Never changes an entry's status. */
export async function joinWaitlist(input: WaitlistInput, now = new Date()): Promise<{ waitlistId: string; created: boolean; status: WaitlistStatus }> {
    const name = clip(input.name, 80);
    const email = clip(input.email, 200).toLowerCase() || null;
    const note = clip(input.note, 300) || null;
    let phone: string | null = null;
    let phoneDigits: string | null = null;
    const rawPhone = clip(input.phone, 24);
    if (rawPhone) {
        const cc = clip(input.phoneCountryCode, 5) || (rawPhone.startsWith("+") ? "" : "+91");
        if (cc) {
            const p = normalizePhoneInput(cc.startsWith("+") ? cc : `+${cc}`, rawPhone);
            phone = p.key;
            phoneDigits = p.key.replace(/\D/g, "");
        } else {
            phoneDigits = phoneDigitsOf(rawPhone);
            if (!phoneDigits) throw new AppError("A valid mobile number is required", 400);
            phone = `+${phoneDigits}`;
        }
    }
    if (input.source === "dashboard") {
        if (name.length < 2) throw new AppError("Please tell us your name", 400);
        if (!email || !EMAIL_RE.test(email)) throw new AppError("A valid email address is required", 400);
    }
    if (email && (!EMAIL_RE.test(email) || isPlaceholderEmail(email))) throw new AppError("A valid email address is required", 400);
    if (!email && !phoneDigits) throw new AppError("An email or a mobile number is required", 400);

    const existing = await findByContact(email, phoneDigits);
    if (existing) {
        const set: Record<string, unknown> = { lastSeenAt: now };
        if (name.length >= 2 && (input.source === "dashboard" || !existing.name)) set.name = name;
        if (email && !existing.email) set.email = email;
        if (phoneDigits && !existing.phoneDigits) Object.assign(set, { phone, phoneDigits });
        if (note) set.note = note;
        await WaitlistEntry.updateOne({ waitlistId: existing.waitlistId }, { $set: set, $inc: { attempts: 1 } });
        return { waitlistId: existing.waitlistId, created: false, status: existing.status };
    }
    const waitlistId = randomUUID();
    await WaitlistEntry.create({
        waitlistId,
        name: name.length >= 2 ? name : null,
        email,
        phone,
        phoneDigits,
        source: input.source,
        note,
        status: "pending",
        attempts: 1,
        lastSeenAt: now,
    });
    return { waitlistId, created: true, status: "pending" };
}

/** An unknown number wrote to Saheli without a valid invite: onto the waitlist, with their WhatsApp profile name. */
export async function waitlistFromWhatsApp(phone: string, profileName?: string, now = new Date()) {
    const digits = phoneDigitsOf(phone);
    if (!digits) return null;
    const name = clip(profileName, 80).replace(/[^\p{L}\p{M}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
    return joinWaitlist({ name, phone: `+${digits}`, source: "whatsapp" }, now);
}

/** The approved, not yet registered entry for this email or number, if any. */
export async function findApprovedWaitlist(input: { email?: string | null; phoneDigits?: string | null }): Promise<IWaitlistEntry | null> {
    const email = String(input.email ?? "").trim().toLowerCase();
    const digits = phoneDigitsOf(input.phoneDigits);
    if (email && !isPlaceholderEmail(email)) {
        const e = await WaitlistEntry.findOne({ email, status: "approved" }).lean<IWaitlistEntry>();
        if (e) return e;
    }
    if (digits) {
        const p = await WaitlistEntry.findOne({ phoneDigits: digits, status: "approved" }).lean<IWaitlistEntry>();
        if (p) return p;
    }
    return null;
}

/** They have an account now: their waitlist entry (the one that let them in, or any with their email or number) says so. */
export async function markRegistered(input: { waitlistId?: string | null; email?: string | null; phoneDigits?: string | null }, userId: string, now = new Date()) {
    try {
        const ids = new Set<string>();
        if (input.waitlistId) ids.add(input.waitlistId);
        const email = String(input.email ?? "").trim().toLowerCase();
        if (email && !isPlaceholderEmail(email)) for (const e of await WaitlistEntry.find({ email }).select("waitlistId").lean<Array<{ waitlistId: string }>>()) ids.add(e.waitlistId);
        const digits = phoneDigitsOf(input.phoneDigits);
        if (digits) for (const e of await WaitlistEntry.find({ phoneDigits: digits }).select("waitlistId").lean<Array<{ waitlistId: string }>>()) ids.add(e.waitlistId);
        if (!ids.size) return;
        await WaitlistEntry.updateMany({ waitlistId: { $in: [...ids] }, registeredUserId: null }, { $set: { registeredUserId: userId, registeredAt: now } });
        const { revokeWaitlistInvites } = await import("./invite.service");
        for (const id of ids) await revokeWaitlistInvites(id, now);
    } catch (err) {
        console.warn("[waitlist] could not mark registered:", err instanceof Error ? err.message : err);
    }
}

/* ── admin ────────────────────────────────────────────────────────────────── */

export async function waitlistCounts(): Promise<Record<WaitlistStatus, number>> {
    const [pending, approved, rejected] = await Promise.all(
        (["pending", "approved", "rejected"] as const).map((status) => WaitlistEntry.countDocuments({ status })),
    );
    return { pending, approved, rejected };
}

export type WaitlistView = "pending" | "approved" | "rejected" | "waiting" | "joined";
export type WaitlistSort = "priority" | "newest" | "oldest" | "asks";

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The list with filters (founder 21 Oct: better waitlist management). View: a status, "waiting" (approved, not signed up
 * yet) or "joined". q: part of a name, email or number. source: dashboard or whatsapp. Sort: pending first (default),
 * newest, oldest, or most asks.
 */
export async function listWaitlist(opts: { status?: string; q?: string; source?: string; sort?: string; page?: number; pageSize?: number } = {}) {
    const filter: Record<string, unknown> = {};
    const view = (["pending", "approved", "rejected", "waiting", "joined"] as const).find((s) => s === opts.status);
    if (view === "waiting") Object.assign(filter, { status: "approved", registeredUserId: null });
    else if (view === "joined") filter.registeredUserId = { $ne: null };
    else if (view) filter.status = view;
    if (opts.source === "dashboard" || opts.source === "whatsapp") filter.source = opts.source;
    const q = (opts.q || "").trim().slice(0, 80);
    if (q) {
        const digits = q.replace(/\D/g, "");
        const re = new RegExp(escapeRe(q), "i");
        filter.$or = [{ name: re }, { email: re }, { note: re }, ...(digits.length >= 4 ? [{ phoneDigits: new RegExp(escapeRe(digits)) }] : [])];
    }
    const rows = await WaitlistEntry.find(filter).lean<IWaitlistEntry[]>();
    const rank = (e: IWaitlistEntry) => (e.status === "pending" && !e.registeredUserId ? 0 : e.status === "approved" && !e.registeredUserId ? 1 : 2);
    const at = (e: IWaitlistEntry) => new Date(e.createdAt ?? 0).getTime();
    const sort = (["priority", "newest", "oldest", "asks"] as const).find((s) => s === opts.sort) || "priority";
    rows.sort((a, b) => sort === "newest" ? at(b) - at(a) : sort === "oldest" ? at(a) - at(b)
        : sort === "asks" ? (b.attempts ?? 1) - (a.attempts ?? 1) || at(b) - at(a) : rank(a) - rank(b) || at(b) - at(a));
    const size = Math.max(1, Math.min(opts.pageSize ?? 25, 100));
    const page = Math.max(1, opts.page ?? 1);
    return { total: rows.length, entries: rows.slice((page - 1) * size, page * size) };
}

/** The numbers above the list: how many wait, how fast they are let in, how many of those sign up, where they come from. */
export async function waitlistStats(now = Date.now()) {
    const rows = await WaitlistEntry.find({}, { status: 1, source: 1, createdAt: 1, approvedAt: 1, registeredAt: 1, registeredUserId: 1, attempts: 1 })
        .lean<Array<Pick<IWaitlistEntry, "status" | "source" | "createdAt" | "approvedAt" | "registeredAt" | "registeredUserId" | "attempts">>>();
    const week = now - 7 * 86_400_000;
    const approved = rows.filter((r) => r.approvedAt);
    const joined = rows.filter((r) => r.registeredUserId);
    const waits = approved.map((r) => new Date(r.approvedAt!).getTime() - new Date(r.createdAt ?? 0).getTime()).filter((x) => x >= 0).sort((a, b) => a - b);
    const pendingAges = rows.filter((r) => r.status === "pending" && !r.registeredUserId).map((r) => now - new Date(r.createdAt ?? 0).getTime());
    const daily: Record<string, number> = {};
    for (let i = 13; i >= 0; i--) daily[new Date(now - i * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10)] = 0;
    for (const r of rows) {
        const d = new Date(new Date(r.createdAt ?? 0).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
        if (d in daily) daily[d]++;
    }
    return {
        total: rows.length,
        pending: rows.filter((r) => r.status === "pending" && !r.registeredUserId).length,
        waitingToJoin: rows.filter((r) => r.status === "approved" && !r.registeredUserId).length,
        joined: joined.length,
        rejected: rows.filter((r) => r.status === "rejected").length,
        newThisWeek: rows.filter((r) => new Date(r.createdAt ?? 0).getTime() >= week).length,
        bySource: { dashboard: rows.filter((r) => r.source === "dashboard").length, whatsapp: rows.filter((r) => r.source === "whatsapp").length },
        medianWaitHours: waits.length ? Math.round(waits[Math.floor(waits.length / 2)] / 3_600_000) : null,
        oldestPendingHours: pendingAges.length ? Math.round(Math.max(...pendingAges) / 3_600_000) : null,
        signUpRate: approved.length ? Math.round((joined.filter((r) => r.approvedAt).length / approved.length) * 100) : null,
        askedMoreThanOnce: rows.filter((r) => (r.attempts ?? 1) > 1 && r.status === "pending").length,
        daily: Object.entries(daily).map(([day, n]) => ({ day, n })),
    };
}

export async function getWaitlistEntry(waitlistId: string): Promise<IWaitlistEntry | null> {
    return WaitlistEntry.findOne({ waitlistId }).lean<IWaitlistEntry>();
}

export type ApprovalResult = {
    entry: IWaitlistEntry;
    emailSent: boolean;
    emailError: string | null;
    link: string;
};

/**
 * Approve: their email/number may register from now on, a fresh personal link is made (any earlier one stops), and the
 * approval email goes out when we have an email. Approving an approved entry again re-sends the email with a new link.
 */
export async function approveWaitlist(waitlistId: string, approvedBy: string, now = new Date()): Promise<ApprovalResult> {
    const entry = await WaitlistEntry.findOne({ waitlistId }).lean<IWaitlistEntry>();
    if (!entry) throw new AppError("Waitlist entry not found", 404, { code: "no_such_entry" });
    if (entry.registeredUserId) throw new AppError("This person already has an account", 409, { code: "already_registered" });
    await WaitlistEntry.updateOne(
        { waitlistId },
        { $set: { status: "approved", approvedAt: now, approvedBy, rejectedAt: null, rejectedBy: null, approvalEmailError: null } },
    );
    const { createWaitlistInvite } = await import("./invite.service");
    const link = await createWaitlistInvite(waitlistId, now);

    let emailSent = false;
    let emailError: string | null = null;
    if (entry.email) {
        try {
            const { sendWaitlistApprovedEmail } = await import("./email.service");
            await sendWaitlistApprovedEmail({ to: entry.email, name: entry.name || "", registerUrl: link.link });
            emailSent = true;
        } catch (err) {
            emailError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        }
    } else {
        emailError = "no_email";
    }
    await WaitlistEntry.updateOne(
        { waitlistId },
        { $set: emailSent ? { approvalEmailSentAt: now, approvalEmailError: null } : { approvalEmailError: emailError } },
    );
    const fresh = (await WaitlistEntry.findOne({ waitlistId }).lean<IWaitlistEntry>())!;
    return { entry: fresh, emailSent, emailError, link: link.link };
}

export async function rejectWaitlist(waitlistId: string, rejectedBy: string, now = new Date()): Promise<IWaitlistEntry> {
    const entry = await WaitlistEntry.findOne({ waitlistId }).lean<IWaitlistEntry>();
    if (!entry) throw new AppError("Waitlist entry not found", 404, { code: "no_such_entry" });
    if (entry.registeredUserId) throw new AppError("This person already has an account", 409, { code: "already_registered" });
    await WaitlistEntry.updateOne({ waitlistId }, { $set: { status: "rejected", rejectedAt: now, rejectedBy } });
    const { revokeWaitlistInvites } = await import("./invite.service");
    await revokeWaitlistInvites(waitlistId, now);
    return (await WaitlistEntry.findOne({ waitlistId }).lean<IWaitlistEntry>())!;
}
