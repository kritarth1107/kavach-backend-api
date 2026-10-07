/** Who am I, the admin team, and the audit log. */
import { z } from "zod";
import { AdminError, type AdminConfig } from "../auth";
import { AdminAudit, AdminUser, auditSig, type IAdminAudit, type IAdminUser } from "../models";
import { permissionsOf, ROLES } from "../permissions";
import type { RouteDef } from "../router";

const emailOf = (domain: string) =>
    z.string().trim().toLowerCase().email().refine((e) => e.endsWith(`@${domain}`), `must be an @${domain} account`);

const publicAdmin = (a: IAdminUser) => ({
    email: a.email, role: a.role, active: a.active, expiresAt: a.expiresAt ?? null, addedBy: a.addedBy, addedAt: a.addedAt,
    lastSeenAt: a.lastSeenAt ?? null, note: a.note ?? null,
});

async function activeOwners(): Promise<number> {
    const owners = await AdminUser.find({ role: "owner", active: true }).lean<IAdminUser[]>();
    return owners.filter((o) => !o.expiresAt || new Date(o.expiresAt) > new Date()).length;
}

export function teamRoutes(cfg: AdminConfig): RouteDef[] {
    return [
        {
            method: "get", path: "/me", perm: "overview.read", action: "me.read", noAudit: true,
            handler: async ({ admin }) => ({ data: { email: admin.email, role: admin.role, permissions: permissionsOf(admin.role) } }),
        },
        {
            method: "get", path: "/admins", perm: "admins.manage", action: "admins.list",
            handler: async () => {
                const rows = await AdminUser.find({}).lean<IAdminUser[]>();
                rows.sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || a.email.localeCompare(b.email));
                return { data: { admins: rows.map(publicAdmin), roles: ROLES } };
            },
        },
        {
            method: "post", path: "/admins", perm: "admins.manage", action: "admins.add",
            handler: async ({ admin, body }) => {
                const input = z.object({
                    email: emailOf(cfg.allowedDomain), role: z.enum(ROLES), note: z.string().max(200).optional(),
                    expiresAt: z.coerce.date().optional(),
                }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input", input.error.issues[0]?.message);
                const { email, role, note, expiresAt } = input.data;
                if (await AdminUser.findOne({ email }).lean()) throw new AdminError(409, "already_admin");
                if (expiresAt && expiresAt <= new Date()) throw new AdminError(400, "bad_input", "expiry is in the past");
                return {
                    status: 201, target: `admin:${email}`, detail: { role },
                    data: publicAdmin((await AdminUser.create({ email, role, note, expiresAt: expiresAt ?? null, active: true, addedBy: admin.email, addedAt: new Date() })).toObject()),
                };
            },
        },
        {
            method: "patch", path: "/admins/:email", perm: "admins.manage", action: "admins.change",
            handler: async ({ admin, params, body }) => {
                const email = String(params.email || "").toLowerCase();
                const input = z.object({
                    role: z.enum(ROLES).optional(), active: z.boolean().optional(), expiresAt: z.coerce.date().nullable().optional(),
                    note: z.string().max(200).optional(),
                }).strict().safeParse(body);
                if (!input.success || !Object.keys(input.data).length) throw new AdminError(400, "bad_input", input.success ? "nothing to change" : input.error.issues[0]?.message);
                const current = await AdminUser.findOne({ email }).lean<IAdminUser>();
                if (!current) throw new AdminError(404, "no_such_admin");
                if (email === admin.email && (input.data.role || input.data.active === false || input.data.expiresAt)) {
                    throw new AdminError(400, "cannot_change_self", "Ask another owner to change your own access.");
                }
                const losesOwner = current.role === "owner" && current.active
                    && ((input.data.role && input.data.role !== "owner") || input.data.active === false || input.data.expiresAt);
                if (losesOwner && (await activeOwners()) <= 1) throw new AdminError(400, "last_owner", "There must always be one active owner.");
                await AdminUser.updateOne({ email }, { $set: input.data });
                const after = await AdminUser.findOne({ email }).lean<IAdminUser>();
                return { target: `admin:${email}`, detail: { changed: Object.keys(input.data), role: after?.role, active: after?.active }, data: publicAdmin(after!) };
            },
        },
        {
            method: "get", path: "/audit", perm: "audit.read", action: "audit.list",
            handler: async ({ query }) => {
                const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
                const filter: Record<string, unknown> = {};
                if (query.admin) filter.admin = query.admin.toLowerCase();
                if (query.action) filter.action = query.action;
                if (query.target) filter.target = query.target;
                if (query.result && ["ok", "denied", "error"].includes(query.result)) filter.result = query.result;
                if (query.before && !Number.isNaN(Date.parse(query.before))) filter.at = { $lt: new Date(query.before) };
                const rows = await AdminAudit.find(filter).sort({ at: -1 }).limit(limit).lean<IAdminAudit[]>();
                return {
                    detail: { filter: Object.keys(filter), n: rows.length },
                    data: {
                        entries: rows.map(({ sig, ...e }) => ({ ...e, _id: undefined, sigOk: sig === auditSig(e, cfg.auditKey) })),
                        next: rows.length === limit ? new Date(rows[rows.length - 1].at).toISOString() : null,
                    },
                };
            },
        },
    ];
}

