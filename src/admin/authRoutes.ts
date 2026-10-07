/**
 * Sign-in routes (/admin/v1/auth): email code → authenticator → session; sign out; sign out everywhere.
 * Same caller check and request-bound assertion as every admin route, but no session is needed to start.
 * Every step is audited (before sign-in, the address is only what the caller typed: marked as claimed).
 * Answers never reveal whether an address belongs to an admin, in content or in timing.
 */
import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { AdminError, loadAdmin, verifyAssertion, verifyCaller, type AdminConfig } from "./auth";
import {
    checkCode, closeChallenge, codeEmail, decryptSecret, encryptSecret, endSessions, issueCode, loadSession, markCodeFailed, newTotpSecret,
    noticeEmail, openChallenge, openSession, otpauthUrl, sendMail, setupOpen, STARTS_PER_IP_HOUR, takeChallengeTry, throttle, totpMatch,
    type Mailer,
} from "./login";
import { AdminAudit, AdminUser, auditSig, type IAdminAudit, type IAdminUser } from "./models";

type Audit = (action: string, result: IAdminAudit["result"], who?: string, detail?: Record<string, unknown>) => Promise<void>;
type Step = (ctx: { req: Request; body: unknown; ip?: string; ua?: string; audit: Audit }) => Promise<unknown>;

const START_FLOOR_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildAuthRouter(cfg: AdminConfig, deps: { write?: (e: IAdminAudit) => Promise<unknown>; mail?: Mailer; startFloorMs?: number } = {}): Router {
    const router = express.Router();
    const write = deps.write ?? ((e: IAdminAudit) => AdminAudit.create(e));
    const mail = deps.mail ?? sendMail;
    const floor = deps.startFloorMs ?? START_FLOOR_MS;

    const step = (path: string, fn: Step) =>
        router.post(path, async (req: Request, res: Response) => {
            let ip: string | undefined, ua: string | undefined;
            const audit: Audit = async (action, result, who = "unknown", detail) => {
                const entry = { at: new Date(), admin: who, role: "none", action, method: "POST", path: `/admin/v1/auth${path}`, result, status: result === "ok" ? 200 : 401, ip, ua, detail } as Omit<IAdminAudit, "sig">;
                await write({ ...entry, sig: auditSig(entry, cfg.auditKey) } as IAdminAudit).catch((err) => console.error("auth audit failed", err));
            };
            try {
                await verifyCaller(req.header("authorization"), cfg);
                const a = verifyAssertion(req.header("x-admin-assertion"), cfg, { method: req.method, path: req.baseUrl + req.path });
                ip = a.ip;
                ua = a.ua;
                return res.json({ data: await fn({ req, body: req.body, ip, ua, audit }) });
            } catch (err) {
                const e = err instanceof AdminError ? err : new AdminError(500, "server_error");
                if (!(err instanceof AdminError)) console.error("auth step failed", path, err);
                return res.status(e.status).json({ error: e.code, ...(e.status < 500 && e.message !== e.code ? { message: e.message } : {}) });
            }
        });

    const emailOf = z.string().trim().toLowerCase().email().max(200);
    const nonceOf = z.string().min(20).max(100);
    const claimed = { claimed: true };

    /** 1. Send a code. Same answer, in about the same time, for everyone. */
    step("/start", async ({ body, ip, audit }) => {
        const p = z.object({ email: emailOf, nonce: nonceOf }).safeParse(body);
        if (!p.success) throw new AdminError(400, "bad_input", "Enter your @kavach.care email.");
        const { email, nonce } = p.data;
        const started = Date.now();
        if (await throttle(ip, "start", STARTS_PER_IP_HOUR)) {
            const admin = await loadAdmin(email, cfg, new Date(), false).then(() => true, () => false);
            if (!admin) await audit("auth.code_refused", "denied", email, claimed);
            else {
                const issued = await issueCode(cfg, email, nonce, ip);
                if (!issued) await audit("auth.code_limited", "denied", email, claimed);
                else if (cfg.printCodes) {
                    console.log(`[local] sign-in code for ${email}: ${issued.code}`);
                    await audit("auth.code_sent", "ok", email, claimed);
                } else if (await mail([email], codeEmail(issued.code))) await audit("auth.code_sent", "ok", email, claimed);
                else {
                    await markCodeFailed(issued.id);
                    await audit("auth.code_email_failed", "error", email, claimed);
                }
            }
        }
        await sleep(Math.max(0, floor - (Date.now() - started)));
        return { sent: true };
    });

    /** 2. Check the code. Next: the authenticator, or setting one up (only inside the window an owner opened). */
    step("/verify-code", async ({ body, ip, audit }) => {
        const p = z.object({ email: emailOf, nonce: nonceOf, code: z.string().trim() }).safeParse(body);
        if (!p.success) throw new AdminError(400, "bad_input");
        const { email, nonce, code } = p.data;
        if (!(await throttle(ip, "verify", STARTS_PER_IP_HOUR))) throw new AdminError(429, "too_many", "Too many tries. Wait an hour.");
        if (!(await checkCode(cfg, email, nonce, code))) {
            await audit("auth.code_failed", "denied", email, claimed);
            throw new AdminError(401, "wrong_code", "That code is wrong or has expired.");
        }
        await loadAdmin(email, cfg, new Date(), false); // still an admin?
        const admin = await AdminUser.findOne({ email }).lean<IAdminUser>();
        if (admin?.totpSecretEnc) {
            await audit("auth.code_ok", "ok", email);
            return { next: "totp", challenge: await openChallenge(email, "totp") };
        }
        if (!admin || !setupOpen(admin)) {
            await audit("auth.setup_closed", "denied", email);
            throw new AdminError(403, "setup_closed", "Your authenticator setup window has ended. Ask an owner to reopen it on the Admin team page.");
        }
        const secret = newTotpSecret();
        await audit("auth.code_ok", "ok", email, { enroll: true });
        return { next: "enroll", challenge: await openChallenge(email, "enroll", encryptSecret(cfg, secret, email)), secret, otpauth: otpauthUrl(email, secret) };
    });

    /** 3. Check the authenticator code and open a session. */
    step("/verify-totp", async ({ body, ip, ua, audit }) => {
        const p = z.object({ challenge: z.string().min(20).max(200), code: z.string().trim() }).safeParse(body);
        if (!p.success) throw new AdminError(400, "bad_input");
        const ch = await takeChallengeTry(p.data.challenge);
        await loadAdmin(ch.email, cfg, new Date(), false);
        const admin = await AdminUser.findOne({ email: ch.email }).lean<IAdminUser>();
        if (!admin) throw new AdminError(401, "login_expired");
        const enrolling = ch.stage === "enroll";
        if (enrolling && !setupOpen(admin)) throw new AdminError(401, "login_expired"); // set up meanwhile, or window closed
        const packed = enrolling ? ch.pendingEnc : admin.totpSecretEnc;
        if (!packed) throw new AdminError(401, "login_expired");
        let secret: string;
        try {
            secret = decryptSecret(cfg, packed, ch.email);
        } catch {
            await audit("auth.authenticator_unreadable", "error", ch.email);
            throw new AdminError(401, "authenticator_unreadable", "Your authenticator can't be checked. Ask an owner to reset it.");
        }
        const at = totpMatch(secret, p.data.code);
        if (at === null || (admin.totpLastStep != null && at <= admin.totpLastStep)) {
            await audit("auth.totp_failed", "denied", ch.email);
            throw new AdminError(401, "wrong_code", "That authenticator code didn't match. Check the time on your phone and try the next one.");
        }
        if (!(await closeChallenge(ch.id))) throw new AdminError(401, "login_expired");
        // Claim the step (and, the first time, the authenticator) atomically: a code works once, and a setup can
        // never replace an authenticator someone finished in the meantime.
        const now = new Date();
        const filter: Record<string, unknown> = { email: ch.email, $or: [{ totpLastStep: null }, { totpLastStep: { $lt: at } }] };
        const set: Record<string, unknown> = { totpLastStep: at };
        if (enrolling) {
            Object.assign(filter, { totpSecretEnc: null, enrollUntil: { $gt: now } });
            Object.assign(set, { totpSecretEnc: packed, totpEnrolledAt: now, enrollUntil: null });
        }
        const claim = await AdminUser.updateMany(filter, { $set: set });
        if (claim.modifiedCount < 1) {
            await audit("auth.totp_failed", "denied", ch.email, { race: true });
            throw new AdminError(401, "wrong_code", "That authenticator code was already used. Wait for the next one.");
        }
        const s = await openSession(ch.email, ip, ua);
        await loadAdmin(ch.email, cfg); // signed in: counts as seen
        await audit(enrolling ? "auth.enrolled_and_signed_in" : "auth.signed_in", "ok", ch.email);
        if (enrolling) {
            const owners = (await AdminUser.find({ role: "owner", active: true }).lean<IAdminUser[]>()).map((o) => o.email);
            const when = now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
            await mail([...new Set([ch.email, ...owners])], noticeEmail("Authenticator set up", [
                `An authenticator app was set up for ${ch.email} at ${when}${ip ? ` from ${ip}` : ""}.`,
                "If that wasn't you, end this person's access on the Admin team page at once.",
            ]));
        }
        return { session: s.token, expiresAt: s.expiresAt.toISOString() };
    });

    /** Sign out this browser, or every browser. */
    step("/logout", async ({ req, body, audit }) => {
        const token = req.header("x-admin-session");
        const all = (body as { all?: boolean } | undefined)?.all === true;
        const sess = await loadSession(token).catch(() => null);
        if (!sess) return { signedOut: true };
        const n = all ? await endSessions({ email: sess.email }, "signed_out_everywhere") : await endSessions({ token }, "signed_out");
        await audit(all ? "auth.signed_out_everywhere" : "auth.signed_out", "ok", sess.email, { sessions: n });
        return { signedOut: true, sessions: n };
    });

    return router;
}
