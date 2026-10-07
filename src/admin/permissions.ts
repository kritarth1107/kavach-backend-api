/**
 * Who may do what in the admin console. The role lives in admin_users (never trusted from a token), and every admin
 * route names one permission. Sensitive reads and every change also need a typed reason, which is audited.
 */
export const PERMISSIONS = [
    "overview.read", // aggregates, no person
    "system.read", // jobs, backups, uptime, versions
    "users.read", // users and families, masked
    "pii.reveal", // unmask a phone or email (reason)
    "care.breakglass", // conversations and the full care record (reason)
    "users.manage", // suspend, sign out everywhere, invites, roles
    "saheli.manage", // pause Saheli, per-family settings
    "orders.manage", // cancel a task, stop a browser
    "flags.manage", // feature flags
    "spend.manage", // model spend caps
    "learning.manage", // approve or block playbooks and rules
    "data.requests", // a user's data export or erasure
    "admins.manage", // admin team
    "audit.read", // the full audit log
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "admin", "support", "analyst"] as const;
export type Role = (typeof ROLES)[number];

const ALL = new Set<Permission>(PERMISSIONS);
const ADMIN = new Set<Permission>([...PERMISSIONS].filter((p) => !["data.requests", "admins.manage", "audit.read"].includes(p)));
const SUPPORT = new Set<Permission>([
    "overview.read", "system.read", "users.read", "pii.reveal", "users.manage", "saheli.manage", "orders.manage",
]);
const ANALYST = new Set<Permission>(["overview.read", "system.read"]);

const BY_ROLE: Record<Role, ReadonlySet<Permission>> = { owner: ALL, admin: ADMIN, support: SUPPORT, analyst: ANALYST };

export function can(role: Role | string | undefined, perm: Permission): boolean {
    return !!role && (ROLES as readonly string[]).includes(role) && BY_ROLE[role as Role].has(perm);
}

export function permissionsOf(role: Role): Permission[] {
    return PERMISSIONS.filter((p) => BY_ROLE[role].has(p));
}

export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

/** A reason must say something: at least 8 characters with a letter, at most 300. */
export function validReason(reason: unknown): reason is string {
    return typeof reason === "string" && reason.trim().length >= 8 && reason.length <= 300 && /\p{L}/u.test(reason);
}
