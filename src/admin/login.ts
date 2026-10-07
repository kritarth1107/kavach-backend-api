/**
 * The console's own sign-in, independent of any cloud: a one-time code to the admin's @kavach.care inbox, then a
 * 6-digit authenticator code (TOTP, RFC 6238). Then a server-side session: the browser holds only a random token,
 * the database holds its hash, so sessions can be ended one by one, all at once, or when access is removed.
 *
 *  - codes: 6 digits, 10 minutes, hashed, 5 tries, tied to the browser that asked (a stranger's request can't
 *    cancel yours); at most 6 an hour and 20 a day per address, 10 an hour per IP, one every 30 s per browser;
 *  - every try is claimed atomically before the comparison, so parallel requests can't get extra guesses;
 *  - an authenticator can be set up only inside a window the owner opens (72 h when someone is added or reset);
 *  - authenticator secrets: AES-256-GCM with their own key (ADMIN_TOTP_KEY), bound to the address; codes are
 *    single-use (the last accepted step is claimed atomically);
 *  - sessions: 12 h at most, ended after 2 h without use.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "crypto";
import mongoose, { Schema } from "mongoose";
import { AdminError, type AdminConfig } from "./auth";

export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_TRIES = 5;
export const CODES_PER_HOUR = 6;
export const CODES_PER_DAY = 20;
export const CODES_PER_IP_HOUR = 10;
export const STARTS_PER_IP_HOUR = 30;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SETUP_WINDOW_MS = 72 * 3_600_000;
export const SESSION_MAX_MS = 12 * 3_600_000;
export const SESSION_IDLE_MS = 2 * 3_600_000;

/* ── storage ─────────────────────────────────────────────────────────────── */

const codeSchema = new Schema(
    {
        email: { type: String, required: true, index: true },
        nonceHash: { type: String, required: true },
        codeHash: { type: String, required: true },
        createdAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        tries: { type: Number, default: 0 },
        usedAt: { type: Date, default: null },
        failed: { type: Boolean, default: false }, // the email never went out: doesn't count towards the limits
        ip: String,
    },
    { collection: "admin_login_codes", versionKey: false },
);
export const AdminLoginCode = mongoose.models.AdminLoginCode || mongoose.model("AdminLoginCode", codeSchema);

const challengeSchema = new Schema(
    {
        tokenHash: { type: String, required: true, index: true },
        email: { type: String, required: true },
        stage: { type: String, enum: ["totp", "enroll"], required: true },
        pendingEnc: { type: String, default: null }, // enroll: the new authenticator secret, encrypted
        expiresAt: { type: Date, required: true },
        tries: { type: Number, default: 0 },
        usedAt: { type: Date, default: null },
    },
    { collection: "admin_login_challenges", versionKey: false },
);
export const AdminLoginChallenge = mongoose.models.AdminLoginChallenge || mongoose.model("AdminLoginChallenge", challengeSchema);

const sessionSchema = new Schema(
    {
        tokenHash: { type: String, required: true, index: true },
        email: { type: String, required: true, index: true },
        createdAt: { type: Date, required: true },
        lastSeenAt: { type: Date, required: true },
        expiresAt: { type: Date, required: true },
        revokedAt: { type: Date, default: null },
        revokedReason: String,
        ip: String,
        ua: String,
    },
    { collection: "admin_sessions", versionKey: false },
);
export const AdminSession = mongoose.models.AdminSession || mongoose.model("AdminSession", sessionSchema);

/** Pre-sign-in requests per IP (for throttling only; no personal data). */
const attemptSchema = new Schema({ ip: { type: String, required: true, index: true }, kind: String, at: Date }, { collection: "admin_login_attempts", versionKey: false });
export const AdminLoginAttempt = mongoose.models.AdminLoginAttempt || mongoose.model("AdminLoginAttempt", attemptSchema);

/** False when this IP made too many sign-in requests of this kind in the last hour. */
export async function throttle(ip: string | undefined, kind: string, limit: number, now = new Date()): Promise<boolean> {
    if (!ip) return true;
    const n = await AdminLoginAttempt.countDocuments({ ip, kind, at: { $gte: new Date(now.getTime() - 3_600_000) } });
    if (n >= limit) return false;
    await AdminLoginAttempt.create({ ip, kind, at: now });
    return true;
}

/* ── small crypto helpers ────────────────────────────────────────────────── */

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");

function key(cfg: AdminConfig, purpose: string): Buffer {
    return Buffer.from(hkdfSync("sha256", cfg.auditKey, "kavach-admin", purpose, 32));
}

export function hashCode(cfg: AdminConfig, email: string, code: string): string {
    return createHmac("sha256", key(cfg, "login-code")).update(`${email}:${code}`).digest("hex");
}

function sameHex(a: string, b: string): boolean {
    const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
    return x.length === y.length && timingSafeEqual(x, y);
}

/** Authenticator-secret keys: ADMIN_TOTP_KEY (and ADMIN_TOTP_KEY_PREVIOUS while rotating); locally, derived. */
function totpKeys(cfg: AdminConfig): Array<{ id: string; key: Buffer }> {
    const raw = [cfg.totpKey, cfg.totpKeyPrevious].filter((k): k is string => !!k);
    const keys = raw.length ? raw.map((k) => Buffer.from(hkdfSync("sha256", k, "kavach-admin", "totp-secret", 32))) : [key(cfg, "totp-secret")];
    return keys.map((k) => ({ id: sha256(k.toString("hex")).slice(0, 8), key: k }));
}

/** Packed as keyId.iv.tag.ciphertext; the address is authenticated data, so a secret can't be moved to another admin. */
export function encryptSecret(cfg: AdminConfig, plain: string, email: string): string {
    const { id, key: k } = totpKeys(cfg)[0];
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k, iv);
    c.setAAD(Buffer.from(email));
    const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return [id, ...[iv, c.getAuthTag(), enc].map((b) => b.toString("base64url"))].join(".");
}

export function decryptSecret(cfg: AdminConfig, packed: string, email: string): string {
    const [id, ...rest] = packed.split(".");
    const k = totpKeys(cfg).find((x) => x.id === id);
    if (!k || rest.length !== 3) throw new Error("unknown authenticator key");
    const [iv, tag, enc] = rest.map((p) => Buffer.from(p, "base64url"));
    const d = createDecipheriv("aes-256-gcm", k.key, iv);
    d.setAAD(Buffer.from(email));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

/** Whether this admin may set up an authenticator now. */
export const setupOpen = (a: { totpSecretEnc?: string | null; enrollUntil?: Date | null }, now = new Date()) =>
    !a.totpSecretEnc && !!a.enrollUntil && new Date(a.enrollUntil) > now;

/* ── TOTP (RFC 6238 / 4226, SHA-1, 30 s, 6 digits) ───────────────────────── */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
    let bits = 0, value = 0, out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

export function base32Decode(s: string): Buffer {
    const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
    let bits = 0, value = 0;
    const out: number[] = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) throw new Error("bad base32");
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number, digits = 6, algo: "sha1" | "sha256" | "sha512" = "sha1"): string {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const h = createHmac(algo, secret).update(msg).digest();
    const off = h[h.length - 1] & 0x0f;
    const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
    return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The time step a code matches (current ± 1 step), or null. */
export function totpMatch(secretB32: string, code: string, now = Date.now(), window = 1): number | null {
    if (!/^\d{6}$/.test(code)) return null;
    const secret = base32Decode(secretB32);
    const step = Math.floor(now / 1000 / 30);
    for (let d = -window; d <= window; d++) {
        const expected = hotp(secret, step + d);
        if (timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step + d;
    }
    return null;
}

export const newTotpSecret = () => base32Encode(randomBytes(20));
export const otpauthUrl = (email: string, secretB32: string) =>
    `otpauth://totp/${encodeURIComponent(`Kavach Admin:${email}`)}?secret=${secretB32}&issuer=${encodeURIComponent("Kavach Admin")}&algorithm=SHA1&digits=6&period=30`;

/* ── login codes ─────────────────────────────────────────────────────────── */

/** A new code for this address and browser (nonce), or null when a limit says no. */
export async function issueCode(cfg: AdminConfig, email: string, nonce: string, ip: string | undefined, now = new Date()): Promise<{ id: unknown; code: string } | null> {
    const hourAgo = now.getTime() - 3_600_000;
    const recent = await AdminLoginCode.find({ email, createdAt: { $gte: new Date(now.getTime() - 86_400_000) }, failed: { $ne: true } })
        .lean<Array<{ createdAt: Date; nonceHash: string }>>();
    if (recent.length >= CODES_PER_DAY) return null;
    if (recent.filter((r) => new Date(r.createdAt).getTime() >= hourAgo).length >= CODES_PER_HOUR) return null;
    const nonceHash = sha256(nonce);
    if (recent.some((r) => r.nonceHash === nonceHash && now.getTime() - new Date(r.createdAt).getTime() < 30_000)) return null;
    if (ip && (await AdminLoginCode.countDocuments({ ip, createdAt: { $gte: new Date(hourAgo) }, failed: { $ne: true } })) >= CODES_PER_IP_HOUR) return null;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    // A new code replaces this browser's earlier one; other browsers' codes are left alone.
    await AdminLoginCode.updateMany({ email, nonceHash, usedAt: null }, { $set: { usedAt: now } });
    const row = await AdminLoginCode.create({ email, nonceHash, codeHash: hashCode(cfg, email, code), createdAt: now, expiresAt: new Date(now.getTime() + CODE_TTL_MS), ip: ip?.slice(0, 120) });
    return { id: row._id, code };
}

/** The email didn't go out: the code is dead and doesn't count towards the limits. */
export async function markCodeFailed(id: unknown, now = new Date()) {
    await AdminLoginCode.updateOne({ _id: id }, { $set: { failed: true, usedAt: now } });
}

/** True once for the right code. Each try is claimed before comparing, so parallel guesses share the 5 tries. */
export async function checkCode(cfg: AdminConfig, email: string, nonce: string, code: string, now = new Date()): Promise<boolean> {
    const row = await AdminLoginCode.findOne({ email, nonceHash: sha256(nonce), usedAt: null }).sort({ createdAt: -1 }).lean<{ _id: unknown; codeHash: string; expiresAt: Date; tries: number }>();
    if (!row || new Date(row.expiresAt) <= now || row.tries >= CODE_MAX_TRIES) return false;
    const took = await AdminLoginCode.updateOne({ _id: row._id, usedAt: null, tries: { $lt: CODE_MAX_TRIES } }, { $inc: { tries: 1 } });
    if (took.modifiedCount !== 1) return false;
    if (!/^\d{6}$/.test(code) || !sameHex(row.codeHash, hashCode(cfg, email, code))) return false;
    const used = await AdminLoginCode.updateOne({ _id: row._id, usedAt: null }, { $set: { usedAt: now } });
    return used.modifiedCount === 1;
}

/* ── challenges (between the email code and the authenticator) ───────────── */

export async function openChallenge(email: string, stage: "totp" | "enroll", pendingEnc: string | null = null, now = new Date()): Promise<string> {
    const token = newToken();
    await AdminLoginChallenge.create({ tokenHash: sha256(token), email, stage, pendingEnc, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) });
    return token;
}

export type Challenge = { id: unknown; email: string; stage: "totp" | "enroll"; pendingEnc: string | null };

/** The challenge behind a token, with one of its 5 tries claimed atomically, or 401. */
export async function takeChallengeTry(token: string | undefined, now = new Date()): Promise<Challenge> {
    if (!token) throw new AdminError(401, "login_expired");
    const row = await AdminLoginChallenge.findOne({ tokenHash: sha256(token) }).lean<{ _id: unknown; email: string; stage: "totp" | "enroll"; pendingEnc?: string | null; expiresAt: Date; usedAt: Date | null; tries: number }>();
    if (!row || row.usedAt || new Date(row.expiresAt) <= now || row.tries >= CODE_MAX_TRIES) throw new AdminError(401, "login_expired");
    const took = await AdminLoginChallenge.updateOne({ _id: row._id, usedAt: null, tries: { $lt: CODE_MAX_TRIES } }, { $inc: { tries: 1 } });
    if (took.modifiedCount !== 1) throw new AdminError(401, "login_expired");
    return { id: row._id, email: row.email, stage: row.stage, pendingEnc: row.pendingEnc ?? null };
}

/** Uses the challenge up; true only for the one request that did. */
export async function closeChallenge(id: unknown, now = new Date()): Promise<boolean> {
    const r = await AdminLoginChallenge.updateOne({ _id: id, usedAt: null }, { $set: { usedAt: now } });
    return r.modifiedCount === 1;
}

/** Ends this address's open codes and challenges (access ended, authenticator reset). */
export async function endLogins(email: string, now = new Date()) {
    await AdminLoginCode.updateMany({ email, usedAt: null }, { $set: { usedAt: now } });
    await AdminLoginChallenge.updateMany({ email, usedAt: null }, { $set: { usedAt: now } });
}

/* ── sessions ────────────────────────────────────────────────────────────── */

export async function openSession(email: string, ip?: string, ua?: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    const token = newToken();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
    await AdminSession.create({ tokenHash: sha256(token), email, createdAt: now, lastSeenAt: now, expiresAt, ip: ip?.slice(0, 120), ua: ua?.slice(0, 200) });
    return { token, expiresAt };
}

export type SessionInfo = { id: string; email: string; createdAt: Date };

/** The session behind a token, or 401. Idle sessions end; lastSeenAt is refreshed at most once a minute. */
export async function loadSession(token: string | undefined, _cfg?: AdminConfig, now = new Date()): Promise<SessionInfo> {
    if (!token || token.length < 30) throw new AdminError(401, "not_signed_in");
    const row = await AdminSession.findOne({ tokenHash: sha256(token) }).lean<{ _id: unknown; email: string; createdAt: Date; lastSeenAt: Date; expiresAt: Date; revokedAt: Date | null }>();
    if (!row || row.revokedAt || new Date(row.expiresAt) <= now) throw new AdminError(401, "not_signed_in");
    if (now.getTime() - new Date(row.lastSeenAt).getTime() > SESSION_IDLE_MS) {
        await AdminSession.updateOne({ _id: row._id }, { $set: { revokedAt: now, revokedReason: "idle" } });
        throw new AdminError(401, "not_signed_in");
    }
    if (now.getTime() - new Date(row.lastSeenAt).getTime() > 60_000) void AdminSession.updateOne({ _id: row._id }, { $set: { lastSeenAt: now } }).catch(() => undefined);
    return { id: String(row._id), email: row.email, createdAt: row.createdAt };
}

export async function endSessions(filter: { token?: string; email?: string; exceptToken?: string }, reason: string, now = new Date()): Promise<number> {
    const q: Record<string, unknown> = { revokedAt: null };
    if (filter.token) q.tokenHash = sha256(filter.token);
    if (filter.email) q.email = filter.email;
    if (filter.exceptToken) q.tokenHash = { $ne: sha256(filter.exceptToken) };
    const r = await AdminSession.updateMany(q, { $set: { revokedAt: now, revokedReason: reason } });
    return r.modifiedCount ?? 0;
}

/* ── emails ────────────────────────────────────────────────────────────── */

const FONT = "-apple-system,Segoe UI,Roboto,Arial,sans-serif";
const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function frame(title: string, body: string): string {
    return `<!doctype html><html><body style="margin:0;background:#f1f2f3;padding:28px 12px;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:22px;border:1px solid #ebebed;">
<tr><td style="padding:24px 28px 4px;"><img src="https://cdn.kavach.care/brand/kavach-careos-logo.png" width="128" height="36" alt="Kavach CareOS" style="display:inline-block;vertical-align:middle;border:0;"> <span style="display:inline-block;vertical-align:middle;margin-left:6px;padding:2px 6px;border-radius:6px;background:#fbe7da;color:#9c3a10;font:600 10px/14px ${FONT};letter-spacing:0.06em;text-transform:uppercase;">Admin</span></td></tr>
<tr><td style="padding:10px 28px 0;font:600 24px/30px ${FONT};color:#142a22;">${esc(title)}</td></tr>
${body}
</table></td></tr></table></body></html>`;
}

/** The sign-in code email. The code is only in the body, never the subject. */
export function codeEmail(code: string): { subject: string; html: string; text: string } {
    const digits = code.split("").map((d) => `<span style="display:inline-block;width:40px;height:52px;line-height:52px;margin:0 3px;border-radius:12px;background:#fbe7da;color:#9c3a10;font:600 26px/52px ${FONT};text-align:center;">${d}</span>`).join("");
    return {
        subject: "Your Kavach Admin sign-in code",
        text: `Your Kavach Admin sign-in code is ${code}. It works for 10 minutes. If you didn't try to sign in, ignore this email and tell the team.`,
        html: frame("Your sign-in code", `<tr><td style="padding:16px 25px 6px;">${digits}</td></tr>
<tr><td style="padding:10px 28px 24px;font:400 13.5px/21px ${FONT};color:#59625e;">It works for 10 minutes, once. Then you'll be asked for your authenticator code.<br><br>If you didn't try to sign in, ignore this email and tell the team.</td></tr>`),
    };
}

/** A short security notice (authenticator set up or reset). */
export function noticeEmail(title: string, lines: string[]): { subject: string; html: string; text: string } {
    return {
        subject: `Kavach Admin: ${title.toLowerCase()}`,
        text: lines.join("\n\n"),
        html: frame(title, `<tr><td style="padding:12px 28px 24px;font:400 13.5px/21px ${FONT};color:#59625e;">${lines.map(esc).join("<br><br>")}</td></tr>`),
    };
}

export type Mailer = (to: string[], m: { subject: string; html: string; text: string }) => Promise<boolean>;

export const sendMail: Mailer = async (to, m) => {
    const keyStr = process.env.RESEND_API_KEY;
    if (!keyStr || !to.length) return false;
    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${keyStr}`, "Content-Type": "application/json" },
            body: JSON.stringify({ from: process.env.ADMIN_MAIL_FROM || "Kavach Admin <alerts@emails.kavach.care>", to, subject: m.subject, html: m.html, text: m.text }),
            signal: AbortSignal.timeout(10_000),
        });
        return res.ok;
    } catch {
        return false;
    }
};
