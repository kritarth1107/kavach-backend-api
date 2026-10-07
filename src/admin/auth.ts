/**
 * The admin API's locks, checked on every request in this order:
 *  1. caller: on Google Cloud, a Google ID token of the admin web app's own service account (Cloud Run IAM already
 *     refuses anyone else). Elsewhere (ADMIN_CALLER_CHECK=off) the API must sit on a private network;
 *  2. a 60-second admin assertion signed with a key only the two admin services hold, bound to the request;
 *  3. a signed-in session (login.ts: email code + authenticator), and the person is an active admin in admin_users
 *     (role read from here, never trusted from a token).
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
    /** Encrypts authenticator secrets (ADMIN_TOTP_KEY; the previous one while rotating). Locally, derived from auditKey. */
    totpKey?: string;
    totpKeyPrevious?: string;
    ownerEmail?: string;
    allowedDomain: string;
    insecureLocal: boolean; // local development only: skips lock 1
    /** "google": Cloud Run IAM + the web app's Google identity (on GCP). "off": rely on a private network and the
     *  signed assertion (for hosts without Google identities, e.g. AWS behind a private load balancer). */
    callerCheck: "google" | "off";
    /** Local development only: print sign-in codes to the console instead of emailing them. */
    printCodes: boolean;
};

export function loadAdminConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
    const cfg: AdminConfig = {
        audience: (env.ADMIN_API_AUDIENCE || "").replace(/\/$/, ""),
        webServiceAccount: (env.ADMIN_WEB_SA || "").toLowerCase(),
        assertionKey: env.ADMIN_ASSERTION_KEY || "",
        auditKey: env.ADMIN_AUDIT_KEY || "",
        totpKey: env.ADMIN_TOTP_KEY || undefined,
        totpKeyPrevious: env.ADMIN_TOTP_KEY_PREVIOUS || undefined,
        ownerEmail: env.ADMIN_OWNER_EMAIL?.toLowerCase().trim() || undefined,
        allowedDomain: (env.ADMIN_ALLOWED_DOMAIN || "kavach.care").toLowerCase(),
        insecureLocal: env.ADMIN_INSECURE_LOCAL === "1" && env.NODE_ENV !== "production" && !env.K_SERVICE,
        callerCheck: env.ADMIN_CALLER_CHECK === "off" ? "off" : "google",
        printCodes: false,
    };
    cfg.printCodes = cfg.insecureLocal && env.ADMIN_PRINT_CODES === "1";
    const google = cfg.callerCheck === "google" && !cfg.insecureLocal;
    const missing = [
        google && !cfg.audience && "ADMIN_API_AUDIENCE",
        google && !cfg.webServiceAccount && "ADMIN_WEB_SA",
        cfg.assertionKey.length < 32 && "ADMIN_ASSERTION_KEY (32+ chars)",
        cfg.auditKey.length < 32 && "ADMIN_AUDIT_KEY (32+ chars)",
        !cfg.insecureLocal && (cfg.totpKey ?? "").length < 32 && "ADMIN_TOTP_KEY (32+ chars)",
    ].filter(Boolean);
    if (missing.length) throw new Error(`Admin API not configured: ${missing.join(", ")}`);
    if (cfg.callerCheck === "off" && !cfg.insecureLocal) {
        // On Cloud Run the Google check is the outer wall; turning it off there is almost certainly a mistake.
        if (env.K_SERVICE && env.ADMIN_ALLOW_UNCHECKED_CALLER !== "1") throw new Error("ADMIN_CALLER_CHECK=off on Cloud Run: refused (set ADMIN_ALLOW_UNCHECKED_CALLER=1 if you really mean it)");
        console.warn("Admin API: caller check is OFF. Keep this API on a private network; only the signed assertion protects it.");
    }
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
    if (cfg.callerCheck === "off") return "unchecked"; // private network + signed assertion (non-Google hosts)
    const token = /^Bearer\s+(.+)$/i.exec(authorization || "")?.[1]?.trim();
    if (!token) throw new AdminError(401, "no_caller_token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new AdminError(401, "bad_caller_token");
    let payload: Record<string, unknown>;
    const stripped = parts[2] === "" || parts[2] === "SIGNATURE_REMOVED_BY_GOOGLE"; // Cloud Run checked and removed it
    if (!stripped) {
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

/** Lock 2. The admin web app's short-lived statement of who is acting and why, bound to this method and path. */
export function verifyAssertion(token: string | undefined, cfg: AdminConfig, bind?: { method: string; path: string }, now = Date.now()): Omit<AdminCtx, "role"> {
    if (!token) throw new AdminError(401, "no_admin_assertion");
    let claims: jwt.JwtPayload;
    try {
        claims = jwt.verify(token, cfg.assertionKey, {
            algorithms: ["HS256"], audience: "kavach-admin-api", issuer: "kavach-admin-web", clockTimestamp: Math.floor(now / 1000),
        }) as jwt.JwtPayload;
    } catch {
        throw new AdminError(401, "bad_admin_assertion");
    }
    if (!claims.iat || !claims.exp || claims.exp - claims.iat > 70 || !claims.jti || !claims.sub) throw new AdminError(401, "bad_admin_assertion");
    if (bind && (String(claims.m || "").toUpperCase() !== bind.method.toUpperCase() || claims.p !== bind.path)) {
        throw new AdminError(401, "assertion_not_for_this_request");
    }
    for (const [k, until] of seenJti) if (until < now) seenJti.delete(k);
    if (seenJti.has(claims.jti)) throw new AdminError(401, "replayed_admin_assertion");
    seenJti.set(claims.jti, claims.exp * 1000 + 60_000);
    return {
        email: String(claims.sub).toLowerCase(),
        sessionId: typeof claims.sid === "string" ? claims.sid : undefined,
        reason: typeof claims.reason === "string" ? claims.reason : undefined,
        ip: typeof claims.ip === "string" ? claims.ip.slice(0, 120) : undefined,
        ua: typeof claims.ua === "string" ? claims.ua.slice(0, 200) : undefined,
    };
}

const lastSeenWrite = new Map<string, number>();

/** Lock 3. The admin record decides the role. */
export async function loadAdmin(email: string, cfg: AdminConfig, now = new Date(), touch = true): Promise<Role> {
    if (!email.endsWith(`@${cfg.allowedDomain}`)) throw new AdminError(403, "not_an_admin");
    // Every record for this email must allow access (a duplicate can never keep an ended admin in).
    const rows = await AdminUser.find({ email }).lean<IAdminUser[]>();
    const admin = rows[0];
    if (!admin || rows.some((r) => !r.active || !isRole(r.role) || (r.expiresAt && new Date(r.expiresAt) <= now)) || new Set(rows.map((r) => r.role)).size > 1) {
        throw new AdminError(403, "not_an_admin");
    }
    if (touch && (lastSeenWrite.get(email) ?? 0) < now.getTime() - 10 * 60_000) {
        lastSeenWrite.set(email, now.getTime());
        void AdminUser.updateOne({ email }, { $set: { lastSeenAt: now } }).catch(() => undefined);
    }
    return admin.role;
}

/**
 * First start: the owner from ADMIN_OWNER_EMAIL, only when there are no admins at all, with a 72 h window to set up
 * an authenticator. An owner record from before authenticators existed gets that window once.
 */
export async function seedOwner(cfg: AdminConfig, now = new Date()): Promise<void> {
    if (!cfg.ownerEmail) return;
    const until = new Date(now.getTime() + 72 * 3_600_000);
    if ((await AdminUser.countDocuments({})) === 0) {
        await AdminUser.create({ email: cfg.ownerEmail, role: "owner", active: true, addedBy: "bootstrap", addedAt: now, enrollUntil: until });
        console.log("Admin owner created from ADMIN_OWNER_EMAIL");
        return;
    }
    const rows = await AdminUser.find({ email: cfg.ownerEmail }).lean<Array<IAdminUser & { _id: unknown }>>();
    for (const r of rows) {
        if (r.role !== "owner" || r.totpSecretEnc || r.enrollUntil !== undefined) continue;
        await AdminUser.updateOne({ _id: r._id }, { $set: { enrollUntil: until, totpSecretEnc: null, totpLastStep: null, totpEnrolledAt: null } });
        console.log("Owner authenticator setup window opened (72 h)");
    }
}
