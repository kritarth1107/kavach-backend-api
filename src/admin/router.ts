/**
 * Every admin route is declared here with its permission, its audit action and whether it needs a reason. The
 * wrapper checks the three locks, the permission and the reason, then:
 *  - for a change: writes an "attempt" audit entry BEFORE running it (no entry, no change), then the outcome;
 *  - for a read: runs it and writes the audit entry BEFORE answering (no entry, no data).
 * Search text travels in the x-admin-q header (base64url), never in a URL that ends up in request logs.
 */
import express, { type Request, type Response, type Router } from "express";
import { AdminError, loadAdmin, verifyAssertion, verifyCaller, type AdminConfig, type AdminCtx } from "./auth";
import { AdminAudit, auditSig, type IAdminAudit } from "./models";
import { can, validReason, type Permission } from "./permissions";

export type Ctx = { admin: AdminCtx; params: Record<string, string>; query: Record<string, string>; body: unknown };
export type Result = { data: unknown; target?: string; detail?: Record<string, unknown>; status?: number };

export type RouteDef = {
    method: "get" | "post" | "patch" | "delete";
    path: string;
    perm: Permission;
    action: string;
    /** Sensitive reads set "required"; every write needs a reason whatever this says. */
    reason?: "required";
    /** Only for GET /me (says who you are, nothing about anyone else). */
    noAudit?: true;
    handler: (ctx: Ctx) => Promise<Result>;
};

export type Deps = {
    /** Override for tests. */
    cfg: AdminConfig;
    verifyCaller?: typeof verifyCaller;
    loadAdmin?: typeof loadAdmin;
    writeAudit?: (entry: IAdminAudit) => Promise<unknown>;
};

export const needsReason = (r: RouteDef) => r.method !== "get" || r.reason === "required";

function flat(o: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries((o as Record<string, unknown>) || {})) if (typeof v === "string") out[k] = v;
    return out;
}

function headerQuery(req: Request): string | undefined {
    const raw = req.header("x-admin-q");
    if (!raw) return undefined;
    try {
        return Buffer.from(raw, "base64url").toString("utf8").slice(0, 120);
    } catch {
        return undefined;
    }
}

export function buildAdminRouter(defs: RouteDef[], deps: Deps): Router {
    const router = express.Router();
    const check = deps.verifyCaller ?? verifyCaller;
    const lookup = deps.loadAdmin ?? loadAdmin;
    const write = deps.writeAudit ?? ((e: IAdminAudit) => AdminAudit.create(e));

    for (const def of defs) {
        router[def.method](def.path, async (req: Request, res: Response) => {
            // Who is asking is recorded as soon as the signed assertion checks out, even if the role lookup refuses.
            let who: (Omit<AdminCtx, "role"> & { role?: string }) | undefined;
            let admin: AdminCtx | undefined;
            const path = req.originalUrl.split("?")[0].slice(0, 200);
            const audit = async (result: IAdminAudit["result"], status: number, extra: Partial<IAdminAudit> = {}) => {
                const entry = {
                    at: new Date(), admin: who?.email || "unknown", role: admin?.role || who?.role || "none", sessionId: who?.sessionId,
                    action: def.action, method: def.method.toUpperCase(), path,
                    reason: who?.reason, result, status, ip: who?.ip, ua: who?.ua, ...extra,
                } as Omit<IAdminAudit, "sig">;
                await write({ ...entry, sig: auditSig(entry, deps.cfg.auditKey) } as IAdminAudit);
            };
            try {
                await check(req.header("authorization"), deps.cfg);
                who = { ...verifyAssertion(req.header("x-admin-assertion"), deps.cfg, { method: req.method, path: req.baseUrl + req.path }), role: "unverified" };
                admin = { ...who, role: await lookup(who.email, deps.cfg) } as AdminCtx;
                if (!can(admin.role, def.perm)) throw new AdminError(403, "missing_permission", def.perm);
                if (needsReason(def) && !validReason(admin.reason)) throw new AdminError(400, "reason_required");
                const isWrite = def.method !== "get";
                if (isWrite) {
                    try {
                        await audit("attempt", 0, { target: req.params?.familyId || req.params?.userId || req.params?.email || undefined });
                    } catch (err) {
                        console.error("admin audit write failed, refusing the change", err);
                        return res.status(503).json({ error: "audit_unavailable" });
                    }
                }
                const q = headerQuery(req);
                const query = { ...flat(req.query), ...(q !== undefined ? { q } : {}) };
                const out = await def.handler({ admin, params: flat(req.params), query, body: req.body });
                const status = out.status ?? 200;
                if (!def.noAudit) {
                    try {
                        await audit("ok", status, { target: out.target, detail: out.detail });
                    } catch (err) {
                        console.error("admin audit write failed", err);
                        // A read never answers without its entry; a change already has its "attempt" entry.
                        if (!isWrite) return res.status(503).json({ error: "audit_unavailable" });
                    }
                }
                return res.status(status).json({ data: out.data });
            } catch (err) {
                const e = err instanceof AdminError ? err : new AdminError(500, "server_error");
                if (!(err instanceof AdminError)) console.error("admin route failed", def.action, err);
                // Refusals and failures are audited too (best effort), so probing shows up.
                await audit(e.status === 403 || e.status === 401 ? "denied" : "error", e.status, { detail: { code: e.code } }).catch(() => undefined);
                return res.status(e.status).json({ error: e.code, ...(e.status < 500 && e.message !== e.code ? { message: e.message } : {}) });
            }
        });
    }
    return router;
}
