/**
 * Admin API: the locks, permissions, reasons, fail-closed audit, masking, and isolation from the public backend.
 * Runs without a database (fake admin lookup and audit store) and without Google (fake caller check).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import { AdminError, loadAdminConfig, verifyAssertion, verifyCaller, type AdminConfig } from "../src/admin/auth";
import { maskEmail, maskName, maskPhone } from "../src/admin/mask";
import { auditSig, type IAdminAudit } from "../src/admin/models";
import { can, permissionsOf, PERMISSIONS, validReason } from "../src/admin/permissions";
import { buildAdminRouter, needsReason, type RouteDef } from "../src/admin/router";
import { adminRoutes } from "../src/admin/routes";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const cfg: AdminConfig = {
    audience: "https://admin-api.test", webServiceAccount: "kavach-admin-web@kavach-care.iam.gserviceaccount.com",
    assertionKey: "k".repeat(40), auditKey: "a".repeat(40), allowedDomain: "kavach.care", insecureLocal: false,
};
const assertion = (claims: Record<string, unknown> = {}, opts: jwt.SignOptions = {}) =>
    jwt.sign({ sub: "kritarth@kavach.care", sid: "s1", jti: Math.random().toString(36).slice(2), ...claims }, cfg.assertionKey,
        { algorithm: "HS256", audience: "kavach-admin-api", issuer: "kavach-admin-web", expiresIn: 60, ...opts });

// permissions
ok("owner can do everything", PERMISSIONS.every((p) => can("owner", p)));
ok("admin can't manage admins, read the audit or handle data requests", !can("admin", "admins.manage") && !can("admin", "audit.read") && !can("admin", "data.requests") && can("admin", "care.breakglass"));
ok("support can't open conversations or change flags", !can("support", "care.breakglass") && !can("support", "flags.manage") && can("support", "users.manage"));
ok("analyst sees numbers only", permissionsOf("analyst").join() === "overview.read,system.read");
ok("unknown role can do nothing", !can("root", "overview.read") && !can(undefined, "overview.read"));
ok("reasons must say something", validReason("fixing a missed reminder") && !validReason("x") && !validReason("12345678") && !validReason("a".repeat(301)));

// masking
ok("phone masked", maskPhone("+917694829888") === "+91 ••••• •9888", maskPhone("+917694829888"));
ok("email masked", maskEmail("kritarth@kavach.care") === "k••••••h@kavach.care", maskEmail("kritarth@kavach.care"));
ok("name masked to first name + initial", maskName("Vasundara Devi") === "Vasundara D." && maskName("Amma") === "Amma");
ok("nothing → null", maskPhone(undefined) === null && maskEmail("") === null);

// lock 2: the signed admin assertion
ok("valid assertion read", verifyAssertion(assertion({ reason: "checking a family" }), cfg).reason === "checking a family");
const throwsCode = (fn: () => unknown, code: string) => { try { fn(); return false; } catch (e) { return e instanceof AdminError && e.code === code; } };
ok("missing assertion refused", throwsCode(() => verifyAssertion(undefined, cfg), "no_admin_assertion"));
ok("wrong key refused", throwsCode(() => verifyAssertion(jwt.sign({ sub: "x@kavach.care", jti: "j" }, "z".repeat(40), { algorithm: "HS256", audience: "kavach-admin-api", issuer: "kavach-admin-web", expiresIn: 60 }), cfg), "bad_admin_assertion"));
ok("wrong audience refused", throwsCode(() => verifyAssertion(assertion({}, { audience: "kavach-backend" }), cfg), "bad_admin_assertion"));
ok("long-lived assertion refused", throwsCode(() => verifyAssertion(assertion({}, { expiresIn: 3600 }), cfg), "bad_admin_assertion"));
ok("expired assertion refused", throwsCode(() => verifyAssertion(assertion({}, { expiresIn: 60 }), cfg, Date.now() + 120_000), "bad_admin_assertion"));
ok("'none' algorithm refused", throwsCode(() => verifyAssertion(jwt.sign({ sub: "x@kavach.care", jti: "j2" }, "", { algorithm: "none", audience: "kavach-admin-api", issuer: "kavach-admin-web", expiresIn: 60 } as jwt.SignOptions), cfg), "bad_admin_assertion"));
const once = assertion();
verifyAssertion(once, cfg);
ok("replayed assertion refused", throwsCode(() => verifyAssertion(once, cfg), "replayed_admin_assertion"));

// config
const throwsAny = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
ok("config refuses short keys", throwsAny(() => loadAdminConfig({ ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ADMIN_ASSERTION_KEY: "short", ADMIN_AUDIT_KEY: "a".repeat(40) } as NodeJS.ProcessEnv)));
ok("local bypass impossible in production or on Cloud Run", !loadAdminConfig({ ADMIN_INSECURE_LOCAL: "1", NODE_ENV: "production", ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ADMIN_ASSERTION_KEY: "k".repeat(40), ADMIN_AUDIT_KEY: "a".repeat(40) } as NodeJS.ProcessEnv).insecureLocal
    && !loadAdminConfig({ ADMIN_INSECURE_LOCAL: "1", K_SERVICE: "kavach-admin-api", ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ADMIN_ASSERTION_KEY: "k".repeat(40), ADMIN_AUDIT_KEY: "a".repeat(40) } as NodeJS.ProcessEnv).insecureLocal);

// audit signature
const entry = { at: new Date("2026-10-07T10:00:00Z"), admin: "kritarth@kavach.care", role: "owner", action: "family.view", method: "GET", path: "/admin/v1/families/f1", result: "ok", status: 200 } as Omit<IAdminAudit, "sig">;
ok("audit signature changes when an entry is edited", auditSig(entry, cfg.auditKey) !== auditSig({ ...entry, admin: "someone@kavach.care" }, cfg.auditKey));

// every real route is declared properly
const routes = adminRoutes(cfg);
ok("every route has a permission and an audit action", routes.every((r) => PERMISSIONS.includes(r.perm) && /^[a-z]+\.[a-z_.]+$/.test(r.action)), routes.map((r) => r.action));
ok("only GET /me skips the audit", routes.filter((r) => r.noAudit).map((r) => `${r.method} ${r.path}`).join() === "get /me");
ok("every write needs a reason", routes.filter((r) => r.method !== "get").every(needsReason));
ok("no duplicate routes", new Set(routes.map((r) => `${r.method} ${r.path}`)).size === routes.length);

// isolation: the public backend never loads admin code, the admin service never loads public routes
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const src = join(__dirname, "..", "src");
const outside = walk(src).filter((f) => f.endsWith(".ts") && !f.includes(`${join("src", "admin")}`));
const leaks = outside.filter((f) => /from\s+["'][./]*(\.\.\/)*admin\//.test(readFileSync(f, "utf8")) || /["']\.\/admin\//.test(readFileSync(f, "utf8")));
ok("public backend imports nothing from src/admin", leaks.length === 0, leaks);
ok("public app mounts no new admin routes", !/app\.use\(\s*["']\/admin/.test(readFileSync(join(src, "app.ts"), "utf8")));
const adminFiles = walk(join(src, "admin")).filter((f) => f.endsWith(".ts"));
const badImports = adminFiles.filter((f) => /from\s+["']\.\.\/(\.\.\/)?(routes|controllers|middleware\/auth)/.test(readFileSync(f, "utf8")));
ok("admin service doesn't load public routes, controllers or the public auth", badImports.length === 0, badImports);

// the wrapper, over HTTP with fakes
const audits: IAdminAudit[] = [];
let auditDown = false;
const roles: Record<string, string> = { "kritarth@kavach.care": "owner", "help@kavach.care": "support" };
const fakeDefs: RouteDef[] = [
    { method: "get", path: "/x", perm: "users.read", action: "x.read", handler: async () => ({ data: { hello: 1 }, target: "family:f1" }) },
    { method: "get", path: "/secret", perm: "care.breakglass", action: "care.read", reason: "required", handler: async () => ({ data: { chat: "…" }, target: "family:f1" }) },
    { method: "post", path: "/w", perm: "users.manage", action: "user.suspend", handler: async () => ({ data: { done: true }, target: "user:u1" }) },
    { method: "get", path: "/boom", perm: "users.read", action: "x.boom", handler: async () => { throw new Error("db down"); } },
];
const app = express().use(express.json()).use("/admin/v1", buildAdminRouter(fakeDefs, {
    cfg,
    verifyCaller: async (h) => { if (h !== "Bearer good") throw new AdminError(403, "caller_not_allowed"); return cfg.webServiceAccount; },
    loadAdmin: async (email) => { const r = roles[email]; if (!r) throw new AdminError(403, "not_an_admin"); return r as never; },
    writeAudit: async (e) => { if (auditDown) throw new Error("audit store down"); audits.push(e); },
}));

void (async () => {
    // lock 1 with a fake Google verifier
    const fakeGoogle = (email: string, aud = cfg.audience) => ({ verifyIdToken: async (o: { audience: string }) => { if (o.audience !== aud) throw new Error("aud"); return { getPayload: () => ({ email, email_verified: true, aud }) }; } });
    ok("caller: the admin web account passes", (await verifyCaller("Bearer a.b.c", cfg, fakeGoogle(cfg.webServiceAccount) as never, false)) === cfg.webServiceAccount);
    ok("caller: the public backend's account is refused", await verifyCaller("Bearer a.b.c", cfg, fakeGoogle("303943038694-compute@developer.gserviceaccount.com") as never, false).then(() => false, (e) => e.code === "caller_not_allowed"));
    ok("caller: unsigned token refused off Cloud Run", await verifyCaller("Bearer a.b.", cfg, fakeGoogle(cfg.webServiceAccount) as never, false).then(() => false, (e) => e.code === "bad_caller_token"));
    const unsigned = `x.${Buffer.from(JSON.stringify({ email: cfg.webServiceAccount, aud: cfg.audience, exp: Date.now() / 1000 + 60 })).toString("base64url")}.`;
    ok("caller: on Cloud Run, the IAM-checked token's identity is still checked", (await verifyCaller(`Bearer ${unsigned}`, cfg, fakeGoogle("x") as never, true)) === cfg.webServiceAccount);
    ok("caller: no token refused", await verifyCaller(undefined, cfg).then(() => false, (e) => e.code === "no_caller_token"));

    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/v1`;
    const call = (path: string, init: { method?: string; caller?: string; who?: string; reason?: string } = {}) =>
        fetch(base + path, {
            method: init.method || "GET",
            headers: { authorization: init.caller ?? "Bearer good", "content-type": "application/json",
                ...(init.who !== "" ? { "x-admin-assertion": assertion({ sub: init.who || "kritarth@kavach.care", reason: init.reason }) } : {}) },
            body: init.method && init.method !== "GET" ? "{}" : undefined,
        });

    let r = await call("/x");
    ok("owner reads, audited with target", r.status === 200 && audits.at(-1)?.action === "x.read" && audits.at(-1)?.target === "family:f1" && audits.at(-1)?.result === "ok");
    ok("audit entry is signed", audits.at(-1)?.sig === auditSig((({ sig, ...e }) => e)(audits.at(-1)!), cfg.auditKey));
    r = await call("/x", { caller: "Bearer public-backend" });
    ok("wrong caller refused and audited as denied", r.status === 403 && audits.at(-1)?.result === "denied");
    r = await call("/x", { who: "" });
    ok("no assertion refused", r.status === 401);
    r = await call("/x", { who: "stranger@kavach.care" });
    ok("not an admin refused", r.status === 403 && (await r.json()).error === "not_an_admin");
    r = await call("/secret", { who: "help@kavach.care", reason: "looking at chat" });
    ok("support can't break glass", r.status === 403 && audits.at(-1)?.detail?.code === "missing_permission");
    r = await call("/secret");
    ok("break-glass without a reason refused", r.status === 400 && (await r.json()).error === "reason_required");
    r = await call("/secret", { reason: "fixing a missed reminder" });
    ok("break-glass with a reason works, reason audited", r.status === 200 && audits.at(-1)?.reason === "fixing a missed reminder");
    r = await call("/w", { method: "POST" });
    ok("a change without a reason refused", r.status === 400);
    r = await call("/w", { method: "POST", who: "help@kavach.care", reason: "user asked to pause" });
    ok("support can make account changes with a reason", r.status === 200 && audits.at(-1)?.action === "user.suspend");
    auditDown = true;
    r = await call("/x");
    ok("audit store down → no data returned (fail closed)", r.status === 503 && !JSON.stringify(await r.json()).includes("hello"));
    auditDown = false;
    r = await call("/boom");
    const body = await r.json();
    ok("server error hides details", r.status === 500 && body.error === "server_error" && !JSON.stringify(body).includes("db down"));
    server.close();

    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log("all passed");
})();
