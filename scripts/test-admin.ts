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
import { sigv4 } from "../src/admin/infra/aws";
import { istDay, istMidnight, lastDays, parseCpu, parseGib, runCostUsd, totals } from "../src/admin/infra/pricing";
import { base32Decode, base32Encode, codeEmail, decryptSecret, encryptSecret, hashCode, hotp, noticeEmail, otpauthUrl, setupOpen, totpMatch } from "../src/admin/login";
import { brainV2Mode } from "../src/services/brainV2.service";
import { flaggedEnv, isSaheliPaused, validFlagValue } from "../src/services/featureFlags.service";

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
ok("analyst sees numbers only", permissionsOf("analyst").join() === "overview.read,system.read,infra.read");
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
ok("expired assertion refused", throwsCode(() => verifyAssertion(assertion({}, { expiresIn: 60 }), cfg, undefined, Date.now() + 120_000), "bad_admin_assertion"));
ok("assertion for another request refused", throwsCode(() => verifyAssertion(assertion({ m: "GET", p: "/admin/v1/me" }), cfg, { method: "POST", path: "/admin/v1/users/u1/status" }), "assertion_not_for_this_request"));
ok("assertion for this request accepted", verifyAssertion(assertion({ m: "POST", p: "/admin/v1/users/u1/status" }), cfg, { method: "POST", path: "/admin/v1/users/u1/status" }).email === "kritarth@kavach.care");
ok("'none' algorithm refused", throwsCode(() => verifyAssertion(jwt.sign({ sub: "x@kavach.care", jti: "j2" }, "", { algorithm: "none", audience: "kavach-admin-api", issuer: "kavach-admin-web", expiresIn: 60 } as jwt.SignOptions), cfg), "bad_admin_assertion"));
const once = assertion();
verifyAssertion(once, cfg);
ok("replayed assertion refused", throwsCode(() => verifyAssertion(once, cfg), "replayed_admin_assertion"));

// config
const throwsAny = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
ok("config refuses short keys", throwsAny(() => loadAdminConfig({ ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ADMIN_ASSERTION_KEY: "short", ADMIN_AUDIT_KEY: "a".repeat(40) } as NodeJS.ProcessEnv)));
const keys = { ADMIN_ASSERTION_KEY: "k".repeat(40), ADMIN_AUDIT_KEY: "a".repeat(40), ADMIN_TOTP_KEY: "t".repeat(40) };
ok("local bypass impossible in production or on Cloud Run", !loadAdminConfig({ ADMIN_INSECURE_LOCAL: "1", NODE_ENV: "production", ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ...keys } as NodeJS.ProcessEnv).insecureLocal
    && !loadAdminConfig({ ADMIN_INSECURE_LOCAL: "1", K_SERVICE: "kavach-admin-api", ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ...keys } as NodeJS.ProcessEnv).insecureLocal);
ok("authenticator key required outside local", throwsAny(() => loadAdminConfig({ ADMIN_API_AUDIENCE: "x", ADMIN_WEB_SA: "y", ADMIN_ASSERTION_KEY: "k".repeat(40), ADMIN_AUDIT_KEY: "a".repeat(40) } as NodeJS.ProcessEnv)));
ok("caller check can't be turned off on Cloud Run by accident", throwsAny(() => loadAdminConfig({ ADMIN_CALLER_CHECK: "off", K_SERVICE: "kavach-admin-api", ...keys } as NodeJS.ProcessEnv))
    && loadAdminConfig({ ADMIN_CALLER_CHECK: "off", ...keys } as NodeJS.ProcessEnv).callerCheck === "off");

// audit signature
const entry = { at: new Date("2026-10-07T10:00:00Z"), admin: "kritarth@kavach.care", role: "owner", action: "family.view", method: "GET", path: "/admin/v1/families/f1", result: "ok", status: 200 } as Omit<IAdminAudit, "sig">;
ok("audit signature changes when an entry is edited", auditSig(entry, cfg.auditKey) !== auditSig({ ...entry, admin: "someone@kavach.care" }, cfg.auditKey));
ok("audit signature ignores key order of the detail", auditSig({ ...entry, detail: { a: 1, b: { c: 2, d: 3 } } }, cfg.auditKey) === auditSig({ ...entry, detail: { b: { d: 3, c: 2 }, a: 1 } }, cfg.auditKey));

// feature flags from the console override env; pause holds back proactive sends only
ok("flag overrides env", flaggedEnv({ BRAIN_V2: "off" } as NodeJS.ProcessEnv, { "brain.mode": "live" }).BRAIN_V2 === "live");
ok("unset flag leaves env", flaggedEnv({ BRAIN_V2: "shadow" } as NodeJS.ProcessEnv, {}).BRAIN_V2 === "shadow");
ok("live families list joins", flaggedEnv({} as NodeJS.ProcessEnv, { "brain.liveFamilies": ["a", "b"] }).BRAIN_V2_LIVE_FAMILIES === "a,b");
ok("connector flag maps to on/off", flaggedEnv({} as NodeJS.ProcessEnv, { "connectors.mcpFirst": true }).MCP_AGENT_CONNECTOR === "on");
ok("brain mode reads the console's live list", brainV2Mode("fam1", flaggedEnv({ BRAIN_V2: "off" } as NodeJS.ProcessEnv, { "brain.liveFamilies": ["fam1"] })) === "live"
    && brainV2Mode("fam2", flaggedEnv({ BRAIN_V2: "off" } as NodeJS.ProcessEnv, { "brain.liveFamilies": ["fam1"] })) === "off");
ok("paused family detected", isSaheliPaused("f1", { "saheli.pausedFamilies": ["f1"] }) && !isSaheliPaused("f2", { "saheli.pausedFamilies": ["f1"] }));
ok("flag values validated", validFlagValue("brain.mode", "live") && !validFlagValue("brain.mode", "on") && validFlagValue("saheli.pausedFamilies", ["abc-1"])
    && !validFlagValue("saheli.pausedFamilies", ["bad id!"]) && validFlagValue("connectors.mcpFirst", false) && validFlagValue("brain.mode", null));

// sign-in: authenticator codes (RFC 6238 test vectors), secrets encrypted at rest, codes hashed
const rfc = Buffer.from("12345678901234567890");
ok("TOTP matches RFC 6238 vectors (SHA-1)", hotp(rfc, Math.floor(59 / 30), 8) === "94287082" && hotp(rfc, Math.floor(1111111109 / 30), 8) === "07081804" && hotp(rfc, Math.floor(20000000000 / 30), 8) === "65353130");
ok("base32 round trip", base32Decode(base32Encode(rfc)).equals(rfc) && base32Encode(Buffer.from("foobar")) === "MZXW6YTBOI");
const sec = base32Encode(rfc);
const nowMs = 1_791_000_000_000;
const cur = hotp(rfc, Math.floor(nowMs / 30_000));
ok("current code accepted, ±30 s allowed", totpMatch(sec, cur, nowMs) === Math.floor(nowMs / 30_000) && totpMatch(sec, hotp(rfc, Math.floor(nowMs / 30_000) - 1), nowMs) !== null);
ok("old code (2 min) refused", totpMatch(sec, hotp(rfc, Math.floor(nowMs / 30_000) - 4), nowMs) === null && totpMatch(sec, "12345", nowMs) === null);
const enc = encryptSecret(cfg, sec, "k@kavach.care");
ok("authenticator secret encrypted at rest", !enc.includes(sec) && decryptSecret(cfg, enc, "k@kavach.care") === sec);
const refused = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
ok("tampered secret refused", refused(() => decryptSecret(cfg, enc.slice(0, -2) + (enc.endsWith("A") ? "BB" : "AA"), "k@kavach.care")));
ok("a secret can't be moved to another admin", refused(() => decryptSecret(cfg, enc, "x@kavach.care")));
const withKey = { ...cfg, totpKey: "t".repeat(40) };
const encK = encryptSecret(withKey, sec, "k@kavach.care");
ok("own authenticator key (not the audit key)", refused(() => decryptSecret(cfg, encK, "k@kavach.care")) && decryptSecret(withKey, encK, "k@kavach.care") === sec);
ok("old key still reads secrets while rotating", decryptSecret({ ...cfg, totpKey: "n".repeat(40), totpKeyPrevious: "t".repeat(40) }, encK, "k@kavach.care") === sec
    && refused(() => decryptSecret({ ...cfg, totpKey: "n".repeat(40) }, encK, "k@kavach.care")));
const soon = new Date(Date.now() + 3_600_000), past = new Date(Date.now() - 1000);
ok("setup only inside the window, never over an existing authenticator", setupOpen({ enrollUntil: soon }) && !setupOpen({ enrollUntil: past }) && !setupOpen({ enrollUntil: null })
    && !setupOpen({}) && !setupOpen({ enrollUntil: soon, totpSecretEnc: "x" }));
ok("login codes stored only as keyed hashes", hashCode(cfg, "a@kavach.care", "123456") !== hashCode(cfg, "b@kavach.care", "123456") && !hashCode(cfg, "a@kavach.care", "123456").includes("123456"));
ok("otpauth link for authenticator apps", otpauthUrl("k@kavach.care", sec).startsWith("otpauth://totp/Kavach%20Admin%3Ak%40kavach.care?secret=") && otpauthUrl("k@kavach.care", sec).includes("issuer=Kavach%20Admin"));
ok("code email: code in the body only, never the subject", codeEmail("042917").html.includes(">0<") && codeEmail("042917").text.includes("042917") && !codeEmail("042917").subject.includes("042917"));
ok("notice email escapes what it shows", noticeEmail("Authenticator set up", ["<b>x</b>"]).html.includes("&lt;b&gt;x&lt;/b&gt;"));

// infrastructure: days, money, forecast, AWS signing
ok("IST day boundaries", istDay(Date.parse("2026-10-07T18:29:00Z")) === "2026-10-07" && istDay(Date.parse("2026-10-07T18:31:00Z")) === "2026-10-08"
    && istMidnight("2026-10-08").toISOString() === "2026-10-07T18:30:00.000Z");
const ld = lastDays(30, Date.parse("2026-10-07T12:00:00Z"));
ok("last 30 IST days end today", ld.length === 30 && ld[29] === "2026-10-07" && ld[0] === "2026-09-08");
ok("Cloud Run sizes parsed", parseCpu("2") === 2 && parseCpu("1000m") === 1 && parseGib("4Gi") === 4 && parseGib("512Mi") === 0.5);
ok("Cloud Run cost: always-on 2 vCPU / 4 GiB for a day ≈ $4.56", Math.abs(runCostUsd(86_400, 2, 4, true) - 4.5619) < 0.01 && runCostUsd(100, 1, 1, false, 1e6) > 0.4);
const fNow = Date.parse("2026-10-10T06:00:00Z"); // 10 Oct, 11:30 IST
const series: Record<string, number> = { "2026-10-01": 100, "2026-10-02": 100, "2026-10-03": 100, "2026-10-04": 100, "2026-10-05": 100, "2026-10-06": 100, "2026-10-07": 100, "2026-10-08": 100, "2026-10-09": 100, "2026-10-10": 30, "2026-09-30": 999 };
const ft = totals(series, fNow);
ok("today / yesterday / month so far", ft.today === 30 && ft.yesterday === 100 && ft.mtd === 930, ft);
ok("forecast = done days + 7-day average × rest of month", ft.avg7 === 100 && ft.forecast === 900 + 100 * 22, ft);
ok("no data → no numbers (never a guess)", totals({}, fNow).forecast === null && totals({}, fNow).today === null);
// AWS Signature V4 test vector (AWS docs: IAM ListUsers, 2015-08-30)
ok("AWS signing matches the published test vector", sigv4({
    method: "GET", host: "iam.amazonaws.com", path: "/", query: "Action=ListUsers&Version=2010-05-08",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" }, body: "", region: "us-east-1", service: "iam",
    accessKey: "AKIDEXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", amzDate: "20150830T123600Z",
}).endsWith("Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"));
ok("infrastructure: owner, admin, analyst yes; support no", can("owner", "infra.read") && can("admin", "infra.read") && can("analyst", "infra.read") && !can("support", "infra.read"));

// every real route is declared properly
const routes = adminRoutes(cfg);
ok("every route has a permission and an audit action", routes.every((r) => PERMISSIONS.includes(r.perm) && /^[a-z_]+\.[a-z_.]+$/.test(r.action)), routes.map((r) => r.action));
ok("only GET /me skips the audit", routes.filter((r) => r.noAudit).map((r) => `${r.method} ${r.path}`).join() === "get /me");
ok("every write needs a reason", routes.filter((r) => r.method !== "get").every(needsReason));
ok("health data needs break-glass + reason", routes.filter((r) => ["family.activity_full", "family.conversation", "family.care_record"].includes(r.action)).every((r) => r.perm === "care.breakglass" && needsReason(r)));
ok("reveal needs pii.reveal + reason", routes.filter((r) => r.action === "user.reveal").every((r) => r.perm === "pii.reveal" && needsReason(r)));
ok("data requests are owner-only", routes.filter((r) => r.action.startsWith("data_request")).every((r) => r.perm === "data.requests"));
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
let handlerRuns = 0;
const fakeDefs: RouteDef[] = [
    { method: "get", path: "/x", perm: "users.read", action: "x.read", handler: async () => ({ data: { hello: 1 }, target: "family:f1" }) },
    { method: "get", path: "/secret", perm: "care.breakglass", action: "care.read", reason: "required", handler: async () => ({ data: { chat: "…" }, target: "family:f1" }) },
    { method: "post", path: "/w", perm: "users.manage", action: "user.suspend", handler: async () => { handlerRuns++; return { data: { done: true }, target: "user:u1" }; } },
    { method: "get", path: "/q", perm: "users.read", action: "q.read", handler: async ({ query }) => ({ data: { q: query.q ?? null } }) },
    { method: "get", path: "/boom", perm: "users.read", action: "x.boom", handler: async () => { throw new Error("db down"); } },
];
const sessions: Record<string, string> = { "sess-owner-000000000000000000000000": "kritarth@kavach.care", "sess-help-0000000000000000000000000": "help@kavach.care", "sess-stranger-000000000000000000000": "stranger@kavach.care" };
const app = express().use(express.json()).use("/admin/v1", buildAdminRouter(fakeDefs, {
    cfg,
    loadSession: async (t) => { const email = sessions[t || ""]; if (!email) throw new AdminError(401, "not_signed_in"); return { id: `id-${email}`, email, createdAt: new Date() }; },
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
    const call = (path: string, init: { method?: string; caller?: string; who?: string; reason?: string; boundTo?: string; headers?: Record<string, string> } = {}) =>
        fetch(base + path, {
            method: init.method || "GET",
            headers: { authorization: init.caller ?? "Bearer good", "content-type": "application/json", ...(init.headers || {}),
                ...(init.who !== "" ? { "x-admin-assertion": assertion({ sub: "session", reason: init.reason, m: init.method || "GET", p: `/admin/v1${init.boundTo ?? path.split("?")[0]}` }) } : {}),
                ...(init.who !== "" ? { "x-admin-session": init.who === "help@kavach.care" ? "sess-help-0000000000000000000000000" : init.who === "stranger@kavach.care" ? "sess-stranger-000000000000000000000" : init.who === "nobody" ? "" : "sess-owner-000000000000000000000000" } : {}) },
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
    ok("refusal names who tried", audits.at(-1)?.admin === "stranger@kavach.care" && audits.at(-1)?.result === "denied", audits.at(-1));
    r = await call("/x", { who: "nobody" });
    ok("no session → not signed in", r.status === 401 && (await r.json()).error === "not_signed_in");
    r = await call("/x", { boundTo: "/secret" });
    ok("assertion signed for another path refused", r.status === 401 && (await r.json()).error === "assertion_not_for_this_request");
    r = await call("/secret", { who: "help@kavach.care", reason: "looking at chat" });
    ok("support can't break glass", r.status === 403 && audits.at(-1)?.detail?.code === "missing_permission");
    r = await call("/secret");
    ok("break-glass without a reason refused", r.status === 400 && (await r.json()).error === "reason_required");
    r = await call("/secret", { reason: "fixing a missed reminder" });
    ok("break-glass with a reason works, reason audited", r.status === 200 && audits.at(-1)?.reason === "fixing a missed reminder");
    r = await call("/w", { method: "POST" });
    ok("a change without a reason refused", r.status === 400);
    const before = audits.length;
    r = await call("/w", { method: "POST", who: "help@kavach.care", reason: "user asked to pause" });
    ok("support can make account changes with a reason", r.status === 200 && audits.at(-1)?.action === "user.suspend");
    ok("a change is logged as an attempt before it runs, then its outcome", audits[before]?.result === "attempt" && audits[before + 1]?.result === "ok", audits.slice(before).map((a) => a.result));
    auditDown = true;
    r = await call("/x");
    ok("audit store down → no data returned (fail closed)", r.status === 503 && !JSON.stringify(await r.json()).includes("hello"));
    const runs = handlerRuns;
    r = await call("/w", { method: "POST", reason: "trying while the log is down" });
    ok("audit store down → the change is not made", r.status === 503 && handlerRuns === runs);
    auditDown = false;
    r = await call("/q", { headers: { "x-admin-q": Buffer.from("Kamla Sharma").toString("base64url") } });
    ok("search text arrives through the header, not the URL", r.status === 200 && (await r.json()).data.q === "Kamla Sharma");
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
