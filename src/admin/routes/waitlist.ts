/**
 * The waitlist (invite-only sign-up, 2026-10-13): who asked to join, pending first; approve (they may register, and get
 * the approval email with a personal link) or reject. Names and contacts are masked like everywhere in the console;
 * revealing one needs pii.reveal and a reason.
 */
import { AdminError } from "../auth";
import { maskEmail, maskName, maskPhone } from "../mask";
import { can } from "../permissions";
import type { RouteDef } from "../router";
import type { IWaitlistEntry } from "../../models/waitlist.model";
import { AppError } from "../../middleware/error.middleware";
import {
    approveWaitlist, getWaitlistEntry, listWaitlist, rejectWaitlist, waitlistCounts, waitlistStats,
} from "../../services/waitlist.service";
import { iso, PAGE, pageOf } from "./shared";

const entryOut = (e: IWaitlistEntry) => ({
    waitlistId: e.waitlistId,
    name: maskName(e.name ?? null),
    email: maskEmail(e.email ?? null),
    phone: maskPhone(e.phone ?? null),
    hasEmail: !!e.email,
    hasPhone: !!e.phoneDigits,
    source: e.source,
    note: e.note ?? null,
    status: e.status,
    attempts: e.attempts ?? 1,
    createdAt: iso(e.createdAt),
    lastSeenAt: iso(e.lastSeenAt),
    approvedAt: iso(e.approvedAt),
    approvedBy: e.approvedBy ?? null,
    rejectedAt: iso(e.rejectedAt),
    rejectedBy: e.rejectedBy ?? null,
    approvalEmailSentAt: iso(e.approvalEmailSentAt),
    approvalEmailError: e.approvalEmailError ?? null,
    registered: !!e.registeredUserId,
    registeredAt: iso(e.registeredAt),
});

/** Service errors (404 / 409) keep their status and say why; anything else stays a 500. */
async function adminSafe<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof AppError && err.statusCode < 500) throw new AdminError(err.statusCode, err.code || "bad_input", err.message);
        throw err;
    }
}

const idOk = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export function waitlistRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/waitlist", perm: "users.read", action: "waitlist.list",
            handler: async ({ query }) => {
                const page = pageOf(query);
                const [{ total, entries }, counts, stats] = await Promise.all([
                    listWaitlist({ status: query.status, q: query.q, source: query.source, sort: query.sort, page, pageSize: PAGE }),
                    waitlistCounts(),
                    waitlistStats(),
                ]);
                return { data: { total, page, pageSize: PAGE, counts, stats, entries: entries.map(entryOut) } };
            },
        },
        {
            method: "post", path: "/waitlist/:waitlistId/reveal", perm: "pii.reveal", action: "waitlist.reveal",
            handler: async ({ params }) => {
                if (!idOk(params.waitlistId)) throw new AdminError(400, "bad_input");
                const e = await getWaitlistEntry(params.waitlistId);
                if (!e) throw new AdminError(404, "no_such_entry");
                return { target: `waitlist:${e.waitlistId}`, data: { name: e.name ?? null, email: e.email ?? null, phone: e.phone ?? null } };
            },
        },
        {
            method: "post", path: "/waitlist/:waitlistId/approve", perm: "users.manage", action: "waitlist.approve",
            handler: async ({ admin, params }) => {
                if (!idOk(params.waitlistId)) throw new AdminError(400, "bad_input");
                const r = await adminSafe(() => approveWaitlist(params.waitlistId, admin.email));
                return {
                    target: `waitlist:${params.waitlistId}`,
                    detail: { emailSent: r.emailSent, emailError: r.emailError },
                    // the personal sign-up link goes to whoever may reveal contacts (to pass on by hand when there is no
                    // email); they sign up on the web with it, then meet Saheli on WhatsApp
                    data: {
                        entry: entryOut(r.entry), emailSent: r.emailSent, emailError: r.emailError,
                        link: can(admin.role, "pii.reveal") ? r.link : null,
                    },
                };
            },
        },
        {
            // Several at once (one reason for all, each audited in the result). Approve sends each its email; at most 50.
            method: "post", path: "/waitlist/bulk", perm: "users.manage", action: "waitlist.bulk",
            handler: async ({ admin, body }) => {
                const b = (body || {}) as { ids?: unknown; action?: unknown };
                const ids = Array.isArray(b.ids) ? [...new Set(b.ids.filter((x): x is string => typeof x === "string" && idOk(x)))].slice(0, 50) : [];
                if (!ids.length || (b.action !== "approve" && b.action !== "reject")) throw new AdminError(400, "bad_input");
                const done: Array<{ waitlistId: string; ok: boolean; emailSent?: boolean; error?: string }> = [];
                for (const id of ids) {
                    try {
                        if (b.action === "approve") {
                            const r = await approveWaitlist(id, admin.email);
                            done.push({ waitlistId: id, ok: true, emailSent: r.emailSent, error: r.emailError || undefined });
                        } else {
                            await rejectWaitlist(id, admin.email);
                            done.push({ waitlistId: id, ok: true });
                        }
                    } catch (err) {
                        done.push({ waitlistId: id, ok: false, error: err instanceof AppError ? err.message : "failed" });
                    }
                }
                return { target: `waitlist:bulk:${b.action}`, detail: { n: ids.length, ok: done.filter((x) => x.ok).length }, data: { action: b.action, results: done } };
            },
        },
        {
            method: "post", path: "/waitlist/:waitlistId/reject", perm: "users.manage", action: "waitlist.reject",
            handler: async ({ admin, params }) => {
                if (!idOk(params.waitlistId)) throw new AdminError(400, "bad_input");
                const e = await adminSafe(() => rejectWaitlist(params.waitlistId, admin.email));
                return { target: `waitlist:${params.waitlistId}`, data: { entry: entryOut(e) } };
            },
        },
    ];
}
