/**
 * Every admin route is declared here with its permission, its audit action and whether it needs a reason. The
 * wrapper checks the three locks, the permission and the reason, runs the handler, then writes the audit entry
 * BEFORE answering: if the audit can't be written, the data is not returned (fail closed).
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

export function buildAdminRouter(defs: RouteDef[], deps: Deps): Router {
    const router = express.Router();
    const check = deps.verifyCaller ?? verifyCaller;
    const lookup = deps.loadAdmin ?? loadAdmin;
    const write = deps.writeAudit ?? ((e: IAdminAudit) => AdminAudit.create(e));

    for (const def of defs) {
        router[def.method](def.path, async (req: Request, res: Response) => {
            let admin: AdminCtx | undefined;
            const audit = async (result: IAdminAudit["result"], status: number, extra: Partial<IAdminAudit> = {}) => {
                const entry = {
                    at: new Date(), admin: admin?.email || "unknown", role: admin?.role || "none", sessionId: admin?.sessionId,
                    action: def.action, method: def.method.toUpperCase(), path: req.originalUrl.split("?")[0].slice(0, 200),
                    reason: admin?.reason, result, status, ip: admin?.ip, ua: admin?.ua, ...extra,
                } as Omit<IAdminAudit, "sig">;
                await write({ ...entry, sig: auditSig(entry, deps.cfg.auditKey) } as IAdminAudit);
            };
            try {
                await check(req.header("authorization"), deps.cfg);
                const who = verifyAssertion(req.header("x-admin-assertion"), deps.cfg);
                admin = { ...who, role: await lookup(who.email, deps.cfg) };
                if (!can(admin.role, def.perm)) throw new AdminError(403, "missing_permission", def.perm);
                if (needsReason(def) && !validReason(admin.reason)) throw new AdminError(400, "reason_required");
                const out = await def.handler({ admin, params: flat(req.params), query: flat(req.query), body: req.body });
                const status = out.status ?? 200;
                if (!def.noAudit) {
                    try {
                        await audit("ok", status, { target: out.target, detail: out.detail });
                    } catch (err) {
                        console.error("admin audit write failed, refusing to answer", err);
                        return res.status(503).json({ error: "audit_unavailable" });
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
