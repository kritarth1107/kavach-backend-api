/**
 * The admin API's locks, checked on every request in this order:
 *  1. caller: a Google ID token of the admin web app's own service account (Cloud Run IAM already refuses anyone
 *     else; this re-checks the identity inside the app);
 *  2. a 60-second admin assertion signed with a key only the two admin services hold (who, session, reason);
 *  3. the person is an active admin in admin_users, on the allowed Workspace domain (role read from here, never trusted
 *     from the token).
 */
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { AdminUser, type IAdminUser } from "./models";
import { isRole, type Role } from "./permissions";

export type AdminConfig = {
    audience: string; // this service's URL (ID token audience)
    webServiceAccount: string; // the only caller allowed
    assertionKey: string;
    auditKey: string;
    ownerEmail?: string;
    allowedDomain: string;
    insecureLocal: boolean; // local development only: skips lock 1
};

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
    const cfg: AdminConfig = {
        audience: (env.ADMIN_API_AUDIENCE || "").replace(/\/$/, ""),
        webServiceAccount: (env.ADMIN_WEB_SA || "").toLowerCase(),
        assertionKey: env.ADMIN_ASSERTION_KEY || "",
        auditKey: env.ADMIN_AUDIT_KEY || "",
        ownerEmail: env.ADMIN_OWNER_EMAIL?.toLowerCase().trim() || undefined,
        allowedDomain: (env.ADMIN_ALLOWED_DOMAIN || "kavach.care").toLowerCase(),
        insecureLocal: env.ADMIN_INSECURE_LOCAL === "1" && env.NODE_ENV !== "production" && !env.K_SERVICE,
    };
    const missing = [
        !cfg.insecureLocal && !cfg.audience && "ADMIN_API_AUDIENCE",
        !cfg.insecureLocal && !cfg.webServiceAccount && "ADMIN_WEB_SA",
        cfg.assertionKey.length < 32 && "ADMIN_ASSERTION_KEY (32+ chars)",
        cfg.auditKey.length < 32 && "ADMIN_AUDIT_KEY (32+ chars)",
    ].filter(Boolean);
    if (missing.length) throw new Error(`Admin API not configured: ${missing.join(", ")}`);
    return cfg;
}

export class AdminError extends Error {
    constructor(public status: number, public code: string, message?: string) {
        super(message || code);
    }
}

export type AdminCtx = { email: string; role: Role; sessionId?: string; reason?: string; ip?: string; ua?: string };

type IdTokenVerifier = { verifyIdToken(opts: { idToken: string; audience: string }): Promise<{ getPayload(): Record<string, unknown> | undefined }> };
const google = new OAuth2Client();

function decodePart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

/** Lock 1. Returns the caller's service account email. */
export async function verifyCaller(
    authorization: string | undefined,
    cfg: AdminConfig,
    verifier: IdTokenVerifier = google as unknown as IdTokenVerifier,
    onCloudRun = !!process.env.K_SERVICE,
): Promise<string> {
    if (cfg.insecureLocal) return cfg.webServiceAccount || "local";
    const token = /^Bearer\s+(.+)$/i.exec(authorization || "")?.[1]?.trim();
    if (!token) throw new AdminError(401, "no_caller_token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AdminError(401, "bad_caller_token");
    let payload: Record<string, unknown>;
    if (parts[2]) {
        try {
            payload = (await verifier.verifyIdToken({ idToken: token, audience: cfg.audience })).getPayload() || {};
        } catch {
            throw new AdminError(401, "bad_caller_token");
        }
    } else if (onCloudRun) {
        // Cloud Run IAM verified the token and passed it on without its signature.
        payload = decodePart(parts[1]);
        if (payload.aud !== cfg.audience || Number(payload.exp) * 1000 < Date.now()) throw new AdminError(401, "bad_caller_token");
    } else {
        throw new AdminError(401, "bad_caller_token");
    }
    const email = String(payload.email || "").toLowerCase();
    if (!email || payload.email_verified === false || email !== cfg.webServiceAccount) throw new AdminError(403, "caller_not_allowed");
    return email;
}

const seenJti = new Map<string, number>();

/** Lock 2. The admin web app's short-lived statement of who is acting and why. */
export function verifyAssertion(token: string | undefined, cfg: AdminConfig, now = Date.now()): Omit<AdminCtx, "role"> {
    if (!token) throw new AdminError(401, "no_admin_assertion");
    let claims: jwt.JwtPayload;
    try {
        claims = jwt.verify(token, cfg.assertionKey, {
            algorithms: ["HS256"], audience: "kavach-admin-api", issuer: "kavach-admin-web", clockTimestamp: Math.floor(now / 1000),
        }) as jwt.JwtPayload;
    } catch {
        throw new AdminError(401, "bad_admin_assertion");
    }
    if (!claims.iat || !claims.exp || claims.exp - claims.iat > 120 || !claims.jti || !claims.sub) throw new AdminError(401, "bad_admin_assertion");
    for (const [k, until] of seenJti) if (until < now) seenJti.delete(k);
    if (seenJti.has(claims.jti)) throw new AdminError(401, "replayed_admin_assertion");
    seenJti.set(claims.jti, claims.exp * 1000 + 60_000);
    return {
        email: String(claims.sub).toLowerCase(),
        sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
        reason: typeof claims.reason === "string" ? claims.reason : undefined,
        ip: typeof claims.ip === "string" ? claims.ip.slice(0, 64) : undefined,
        ua: typeof claims.ua === "string" ? claims.ua.slice(0, 200) : undefined,
    };
}

const lastSeenWrite = new Map<string, number>();

/** Lock 3. The admin record decides the role. */
export async function loadAdmin(email: string, cfg: AdminConfig, now = new Date()): Promise<Role> {
    if (!email.endsWith(`@${cfg.allowedDomain}`)) throw new AdminError(403, "not_an_admin");
    const admin = await AdminUser.findOne({ email }).lean<IAdminUser>();
    if (!admin || !admin.active || !isRole(admin.role) || (admin.expiresAt && new Date(admin.expiresAt) <= now)) {
        throw new AdminError(403, "not_an_admin");
    }
    if ((lastSeenWrite.get(email) ?? 0) < now.getTime() - 10 * 60_000) {
        lastSeenWrite.set(email, now.getTime());
        void AdminUser.updateOne({ email }, { $set: { lastSeenAt: now } }).catch(() => undefined);
    }
    return admin.role;
}

/** First start: the owner from ADMIN_OWNER_EMAIL, only when there are no admins at all. */
export async function seedOwner(cfg: AdminConfig): Promise<void> {
    if (!cfg.ownerEmail || (await AdminUser.countDocuments({})) > 0) return;
    await AdminUser.create({ email: cfg.ownerEmail, role: "owner", active: true, addedBy: "bootstrap", addedAt: new Date() });
    console.log("Admin owner created from ADMIN_OWNER_EMAIL");
}
