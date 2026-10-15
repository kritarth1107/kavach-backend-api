/**
 * Invite links, invite-only sign-up and the waitlist (founder 2026-10-13): links made one at a time, 5 per person in any
 * 7 days, one registration each (also under a race), 14-day expiry and revoke; every way a new account is made (email,
 * mobile, Google) refuses anyone without an invite or an approved waitlist entry and puts them on the waitlist; admin
 * approval sends the email (faked) and lets them register; family members a caregiver adds and existing accounts work
 * exactly as before.
 * Web first, then WhatsApp (founder 2026-10-13: "people can only access saheli via whatsapp when they have completed the
 * onboarding via web"): a WhatsApp hi never makes an account or a family (with a valid invite code it gets the join link
 * and the invite stays unused; an approved number is pointed to the web; anyone else goes on the waitlist), and a
 * caregiver who hasn't finished the web onboarding gets one line pointing there while the brain is never called. People
 * cared for, family members a caregiver added and families already set up reach Saheli as before.
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod). No real email or WhatsApp is sent:
 * the email client, Meta's Graph API and the AI engine are faked, WhatsApp runs on the mock provider, and any other
 * outside request is refused.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-invites.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { testDbUri } from "./test-db";

// throwaway test values (CI has no .env); set before config is first imported
process.env.JWT_SECRET = process.env.JWT_SECRET || "invite-test-secret";
process.env.AES_SECRET = process.env.AES_SECRET || "invite-test-aes-secret";
process.env.WHATSAPP_PROVIDER = "mock";
process.env.PHONE_OTP_ENABLED = "true";
process.env.DASHBOARD_URL = "https://app.example.com";
process.env.AI_ENGINE_URL = "http://ai-engine.test";
process.env.BRAIN_V2 = "live"; // every family on Saheli's brain, so "reaches Saheli" means "the brain was called"
delete process.env.BRAIN_V2_LIVE_FAMILIES;
delete process.env.INVITE_ONLY; // the default: invite-only on

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
    Promise.resolve()
        .then(fn)
        .then(
            () => {
                passed++;
                console.log(`  ✓ ${name}`);
            },
            (err) => {
                console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack || err.message : err}`);
                process.exitCode = 1;
            },
        );

/**
 * Meta's Graph API, faked: nothing may go out from these paths, and anything that tries is recorded. The AI engine,
 * faked: every brain turn (/v2/turn) is recorded and answered with BRAIN_REPLY. Any other outside request is refused.
 */
const metaSent: Array<{ url: string; body: unknown }> = [];
const brainTurns: Array<{ speaker: { id: string; role: string }; text: string }> = [];
const BRAIN_REPLY = "Namaste, Saheli's brain here.";
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("graph.facebook.com")) {
        metaSent.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : {} });
        return json({ messages: [{ id: `wamid.T${metaSent.length}` }] });
    }
    if (u.startsWith("http://ai-engine.test")) {
        if (u.endsWith("/v2/turn")) {
            const body = JSON.parse(String(init?.body ?? "{}"));
            brainTurns.push({ speaker: body.speaker, text: body.text });
            return json({ reply: BRAIN_REPLY, actions: [], alerts: [], model: "fake" });
        }
        return json({}, 404);
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url as string, init);
    return json({ error: "no outside requests in this test" }, 503);
}) as typeof fetch;

/** The email client, faked: every message is kept; failNext makes the next send fail like Resend would. */
const mails: Array<Record<string, any>> = [];
let failNext = false;

async function pure() {
    console.log("pure");
    const I = await import("../src/services/invite.service");
    const { VERIFY_RE } = await import("../src/services/onboarding.service");
    const { renderWaitlistApprovedEmail } = await import("../src/services/waitlistEmail.template");
    const { inviteOnlyEnabled } = await import("../src/services/featureFlags.service");

    await ok("a code is 26 Crockford characters (130 random bits), never repeats, and survives retyping", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 2000; i++) {
            const t = I.newInviteToken();
            assert.match(t, /^[0-9A-HJKMNP-TV-Z]{26}$/);
            seen.add(t);
        }
        assert.equal(seen.size, 2000);
        const t = I.newInviteToken();
        assert.equal(I.normalizeInviteToken(t.toLowerCase()), t);
        assert.equal(I.normalizeInviteToken(`KAVACH-${t}`), t);
        assert.equal(I.normalizeInviteToken("0".repeat(25) + "I"), "0".repeat(25) + "1");
        assert.equal(I.normalizeInviteToken("short"), null);
        assert.equal(I.normalizeInviteToken("U".repeat(26)), null);
        assert.equal(I.normalizeInviteToken(undefined), null);
    });

    await ok("a code sent on WhatsApp is recognised (to answer with its join link); never read as a phone-verify code", () => {
        const t = I.newInviteToken();
        assert.equal(I.inviteCodeFromText(`hi KAVACH-${t}`), t);
        assert.equal(I.inviteCodeFromText(`Hi kavach-${t.toLowerCase()} 🙏`), t);
        assert.equal(I.inviteCodeFromText("hi"), null);
        assert.equal(I.inviteCodeFromText("KAVACH 123456"), null);
        assert.equal(VERIFY_RE.test(`hi KAVACH-${t}`), false);
        assert.equal(VERIFY_RE.test(`KAVACH-${t}`), false);
        assert.equal(I.joinUrl(t), `https://app.example.com/join/${t}`);
    });

    await ok("invite-only is on unless switched off (admin flag first, then INVITE_ONLY)", () => {
        assert.equal(inviteOnlyEnabled({}, {}), true);
        assert.equal(inviteOnlyEnabled({ INVITE_ONLY: "off" }, {}), false);
        assert.equal(inviteOnlyEnabled({ INVITE_ONLY: "on" }, {}), true);
        assert.equal(inviteOnlyEnabled({ INVITE_ONLY: "off" }, { "signup.inviteOnly": true }), true);
        assert.equal(inviteOnlyEnabled({}, { "signup.inviteOnly": false }), false);
    });

    await ok("the approval email: one big 'Complete your sign-up' button (the web link), the Send hi button promised at the end of setup, no WhatsApp-first button", () => {
        const mail = renderWaitlistApprovedEmail({ name: "Asha <script>alert(1)</script> Rao", registerUrl: "https://app.example.com/join/ABC" });
        assert.match(mail.subject, /^Asha, your place on Kavach is ready$/);
        const button = /<a href="([^"]+)"[^>]*>\s*Complete your sign-up &rarr;\s*<\/a>/.exec(mail.html);
        assert.ok(button, "the primary button");
        assert.equal(button![1], "https://app.example.com/join/ABC");
        assert.ok(/At the end of setup you'll get a .*Send&nbsp;hi&nbsp;to&nbsp;Saheli.* button/.test(mail.html), "says the Send hi button comes at the end of setup");
        assert.ok(!mail.html.includes("wa.me"), "no WhatsApp link");
        assert.ok(!/already typed|personal code|Send hi to Saheli on WhatsApp &rarr;/i.test(mail.html), "no WhatsApp-first button or its note");
        assert.ok(!mail.html.includes("<script>"), "the name is escaped");
        assert.ok(!/gradient/i.test(mail.html), "flat: no gradients");
        assert.ok(mail.html.includes("#165246"), "jade pine button");
        // marigold fills carry the dark ink, never white
        for (const m of mail.html.matchAll(/background:#ec9a2f;[^"]*color:([^;"]+)/g)) assert.equal(m[1], "#2a1804");
        assert.ok(mail.text.includes("Complete your sign-up:\nhttps://app.example.com/join/ABC"));
        assert.ok(mail.text.includes('"Send hi to Saheli" button'));
        assert.ok(!mail.text.includes("wa.me"));
        const anon = renderWaitlistApprovedEmail({ name: "", registerUrl: "https://x/j" });
        assert.equal(anon.subject, "Your place on Kavach is ready");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();

    const { setEmailClientForTests } = await import("../src/services/email.service");
    setEmailClientForTests({
        emails: {
            send: async (msg) => {
                mails.push(msg);
                if (failNext) {
                    failNext = false;
                    return { error: { message: "simulated send failure" } };
                }
                return { error: null };
            },
        },
    });
    const { setFlagSnapshot } = await import("../src/services/featureFlags.service");
    setFlagSnapshot({});

    const I = await import("../src/services/invite.service");
    const W = await import("../src/services/waitlist.service");
    const A = await import("../src/services/auth.service");
    const WF = await import("../src/services/whatsappWebFirst.service");
    const { handleWhatsAppInbound } = await import("../src/services/whatsappRouting.service");
    const { startVerification } = await import("../src/services/onboarding.service");
    const Family = (await import("../src/models/family.model")).default;
    const { OnboardingDraft } = await import("../src/models/onboarding.model");
    const { FamilyMemberStatus, FamilyRole } = await import("../src/types/family.types");
    const { createOtpToken } = await import("../src/services/otp.service");
    const { inviteFamilyMember } = await import("../src/services/familyMember.service");
    const { createDefaultFamilyForUser, ensureDefaultFamily } = await import("../src/services/family.service");
    const { resolveWhatsAppSender } = await import("../src/services/identityResolver.service");
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");
    const { waitlistRoutes } = await import("../src/admin/routes/waitlist");
    const User = (await import("../src/models/users.model")).default;
    const Invite = (await import("../src/models/invite.model")).default;
    const WaitlistEntry = (await import("../src/models/waitlist.model")).default;
    const Session = (await import("../src/models/session.model")).default;
    const config = (await import("../src/config/app.config")).default;
    const app = (await import("../src/app")).default as unknown as http.RequestListener;

    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, token?: string) => {
        const res = await realFetch(`${base}${path}`, {
            method,
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    const sessionFor = async (userId: string, email: string) => {
        const sessionId = randomUUID();
        const token = jwt.sign({ userId, email, sessionId, authProvider: "EMAIL" }, config.jwt.secret, { expiresIn: "2h" });
        await Session.create({ sessionId, userId, tokenHash: Session.hashToken(token), fingerprint: "N/A", authProvider: "EMAIL",
                               expiresAt: new Date(Date.now() + 2 * 3600_000), lastActiveAt: new Date() });
        return token;
    };
    /** A registered caregiver, made the way an existing account already is. */
    const caregiver = async (email: string, first: string) => {
        const u = await User.create({ email, firstName: first, lastName: "Tester", passwordHash: "x", emailVerified: true,
                                      phone: { countryCode: "+99", number: String(1_000_000_000 + Math.floor(Math.random() * 8e9)) } });
        const fam = await createDefaultFamilyForUser(u);
        return { user: u, familyId: fam.familyId, token: await sessionFor(u.userId, email) };
    };
    /** Register on the dashboard with an email code (the code is made directly; the send step is tested separately). */
    const register = async (email: string, name: string, inviteToken?: string) => {
        const code = "123456";
        const otpToken = await createOtpToken("email", email, code);
        return call("POST", "/api/auth/otp/register", { channel: "email", email, code, otpToken, name, ...(inviteToken ? { inviteToken } : {}) });
    };
    const tokenOf = (link: string | null) => link!.split("/join/")[1];
    /** A WhatsApp message to Saheli, through the real router, and whether it reached the brain. */
    const whatsapp = async (from: string, text: string, profileName?: string) => {
        const turns = brainTurns.length;
        const out = await handleWhatsAppInbound({ from, text, messageId: `wamid.${randomUUID()}`, ...(profileName ? { profileName } : {}) } as never);
        return { content: String(out.content ?? ""), brain: brainTurns.length > turns };
    };
    const familyCount = () => Family.countDocuments({});
    /** A WhatsApp number of their own on an account (what a mobile sign-in or the finished web setup leaves). */
    const givePhone = (userId: string, number: string) =>
        User.updateOne({ userId }, { $set: { phone: { countryCode: "+91", number }, phoneKey: `+91${number}`, phoneVerifiedAt: new Date() } });

    const inviter = await caregiver("inviter@example.com", "Meera");

    /* ── links: made on request, 5 per 7 days ─────────────────────────────── */

    await ok("links are made one at a time on request, 5 in any 7 days; the 6th is refused; a week later there's room again", async () => {
        const before = await call("GET", "/api/invites", undefined, inviter.token);
        assert.equal(before.status, 200);
        assert.equal(before.json.data.quota.left, 5);
        assert.equal(before.json.data.invites.length, 0, "nothing is made in advance");
        for (let i = 0; i < 5; i++) {
            const r = await call("POST", "/api/invites", {}, inviter.token);
            assert.equal(r.status, 201, JSON.stringify(r.json));
            assert.equal(r.json.data.quota.left, 4 - i);
            assert.match(r.json.data.invite.link, /^https:\/\/app\.example\.com\/join\/[0-9A-HJKMNP-TV-Z]{26}$/);
            assert.ok(!("whatsappLink" in r.json.data.invite) && !("code" in r.json.data.invite), "only the web link: no WhatsApp-first link or code");
        }
        const sixth = await call("POST", "/api/invites", {}, inviter.token);
        assert.equal(sixth.status, 429);
        assert.equal(sixth.json.code, "invite_limit");
        assert.ok(sixth.json.data.nextSlotAt);
        assert.equal(await Invite.countDocuments({ inviterUserId: inviter.user.userId }), 5);
        // rolling: 7 days and a minute on, the week's links are out of the window
        const later = new Date(Date.now() + 7 * 86_400_000 + 60_000);
        assert.equal((await I.inviteQuota(inviter.user.userId, later)).left, 5);
        const r = await I.createInvite(inviter.user.userId, later);
        assert.equal(r.quota.left, 4);
        assert.equal(r.invite.state, "active");
        await Invite.deleteOne({ inviteId: r.invite.inviteId });
        assert.equal((await call("GET", "/api/invites", undefined)).status, 401, "only a signed-in person");
    });

    await ok("eight clicks at once never make more than five links (repeated 5 times)", async () => {
        for (let round = 0; round < 5; round++) {
            const racer = await caregiver(`racer${round}@example.com`, "Ravi");
            const results = await Promise.allSettled(Array.from({ length: 8 }, () => I.createInvite(racer.user.userId)));
            const made = results.filter((r) => r.status === "fulfilled").length;
            assert.ok(made <= 5 && made >= 1, JSON.stringify(results.map((r) => r.status)));
            assert.equal(await Invite.countDocuments({ inviterUserId: racer.user.userId }), made);
            for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code?: string }).code, "invite_limit");
            // the rest of the week's links can still be made, one by one, up to five
            for (let i = made; i < 5; i++) await I.createInvite(racer.user.userId);
            await assert.rejects(I.createInvite(racer.user.userId), (e: { code?: string }) => e.code === "invite_limit");
            assert.equal(await Invite.countDocuments({ inviterUserId: racer.user.userId }), 5);
        }
    });

    /* ── one link, one registration ────────────────────────────────────────── */

    const freshLink = async (who = inviter.user.userId) => {
        await Invite.deleteMany({ inviterUserId: who, status: "used" }); // room in the week for the next check
        const r = await I.createInvite(who, new Date());
        return { token: tokenOf(r.invite.link), inviteId: r.invite.inviteId };
    };
    // fresh weekly room for the inviter
    await Invite.deleteMany({ inviterUserId: inviter.user.userId });

    await ok("the join page shows who invited and that the link works (sign-up on the web; no WhatsApp-first link)", async () => {
        const { token } = await freshLink();
        const r = await call("GET", `/api/invites/lookup/${token}`);
        assert.equal(r.status, 200);
        assert.equal(r.json.data.state, "active");
        assert.equal(r.json.data.inviterName, "Meera Tester");
        assert.ok(r.json.data.saheliNumber, "Saheli's number, for the end of setup");
        assert.ok(!("whatsappLink" in r.json.data));
        assert.equal((await call("GET", `/api/invites/lookup/${token.toLowerCase()}`)).json.data.state, "active");
        assert.equal((await call("GET", "/api/invites/lookup/not-a-token")).json.data.state, "invalid");
        assert.equal((await call("GET", `/api/invites/lookup/${I.newInviteToken()}`)).json.data.state, "invalid");
        await Invite.deleteMany({ inviterUserId: inviter.user.userId });
    });

    await ok("a link makes one account, then it is used up (and the inviter sees by whom)", async () => {
        const { token, inviteId } = await freshLink();
        const first = await register("friend1@example.com", "Farah Khan", token);
        assert.equal(first.status, 201, JSON.stringify(first.json));
        assert.equal(first.json.data.registered, true);
        const inv = await Invite.findOne({ inviteId }).select("+token").lean<Record<string, any>>();
        assert.equal(inv!.status, "used");
        assert.equal(inv!.usedVia, "email");
        assert.equal(inv!.token, null, "the code is wiped once used");
        const u = await User.findOne({ email: "friend1@example.com" }).lean<Record<string, any>>();
        assert.equal(inv!.usedByUserId, u!.userId);
        const second = await register("friend2@example.com", "Gita Rao", token);
        assert.equal(second.status, 403);
        assert.equal(second.json.code, "invite_used");
        assert.equal(await User.countDocuments({ email: "friend2@example.com" }), 0);
        assert.equal((await call("GET", `/api/invites/lookup/${token}`)).json.data.state, "used");
        const list = await call("GET", "/api/invites", undefined, inviter.token);
        const row = list.json.data.invites.find((x: { inviteId: string }) => x.inviteId === inviteId);
        assert.equal(row.state, "used");
        assert.equal(row.usedByName, "Farah Khan");
        assert.equal(row.link, null);
    });

    await ok("ten people racing for one link: exactly one account", async () => {
        const { token } = await freshLink();
        const results = await Promise.allSettled(
            Array.from({ length: 10 }, (_, i) => A.findOrCreateEmailUser(`race${i}@example.com`, `Racer ${i}`, { inviteToken: token })),
        );
        const won = results.filter((r) => r.status === "fulfilled");
        assert.equal(won.length, 1, JSON.stringify(results.map((r) => (r.status === "rejected" ? (r.reason as Error).message : "ok"))));
        for (const r of results) if (r.status === "rejected") assert.equal((r.reason as { code?: string }).code, "invite_used");
        assert.equal(await User.countDocuments({ email: /^race\d@example\.com$/ }), 1);
        // and over HTTP too
        const t2 = (await freshLink()).token;
        const http2 = await Promise.all(Array.from({ length: 6 }, (_, i) => register(`hrace${i}@example.com`, `H Racer ${i}`, t2)));
        assert.equal(http2.filter((r) => r.status === 201).length, 1, JSON.stringify(http2.map((r) => r.status)));
        assert.equal(await User.countDocuments({ email: /^hrace\d@example\.com$/ }), 1);
    });

    await ok("a sign-up that fails part-way gives the link back", async () => {
        const { token, inviteId } = await freshLink();
        await assert.rejects(I.gatedSignup({ inviteToken: token, email: "boom@example.com", via: "email" }, async () => {
            throw new Error("db hiccup");
        }));
        assert.equal((await Invite.findOne({ inviteId }).lean<Record<string, any>>())!.status, "active");
        await Invite.deleteOne({ inviteId });
    });

    await ok("links expire after 14 days, and the inviter can cancel an unused one (not a used one, not someone else's)", async () => {
        const { token, inviteId } = await freshLink();
        const inv = await Invite.findOne({ inviteId }).lean<Record<string, any>>();
        const days = (new Date(inv!.expiresAt).getTime() - new Date(inv!.createdAt).getTime()) / 86_400_000;
        assert.ok(Math.abs(days - 14) < 0.01, `valid ${days} days`);
        await Invite.updateOne({ inviteId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        assert.equal((await call("GET", `/api/invites/lookup/${token}`)).json.data.state, "expired");
        const late = await register("late@example.com", "Late Comer", token);
        assert.equal(late.status, 403);
        assert.equal(late.json.code, "invite_expired");

        const b = await freshLink();
        const other = await caregiver("other@example.com", "Omar");
        assert.equal((await call("POST", `/api/invites/${b.inviteId}/revoke`, {}, other.token)).status, 404, "not theirs");
        const rev = await call("POST", `/api/invites/${b.inviteId}/revoke`, {}, inviter.token);
        assert.equal(rev.status, 200);
        assert.equal(rev.json.data.state, "revoked");
        assert.equal((await call("GET", `/api/invites/lookup/${b.token}`)).json.data.state, "revoked");
        const after = await register("revoked@example.com", "Rev Oked", b.token);
        assert.equal(after.json.code, "invite_revoked");
        assert.equal(await User.countDocuments({ email: { $in: ["late@example.com", "revoked@example.com"] } }), 0);

        const c = await freshLink();
        assert.equal((await register("used@example.com", "Used Once", c.token)).status, 201);
        const cannot = await call("POST", `/api/invites/${c.inviteId}/revoke`, {}, inviter.token);
        assert.equal(cannot.status, 409);
    });

    /* ── no invite: the waitlist, on every path ───────────────────────────── */

    await ok("dashboard email sign-up without an invite: no code is sent, the waitlist form is asked for", async () => {
        const n = mails.length;
        const r = await call("POST", "/api/auth/otp/send", { channel: "email", email: "stranger@example.com" });
        assert.equal(r.status, 403);
        assert.equal(r.json.code, "invite_required");
        assert.equal(r.json.data.waitlist, true);
        assert.equal(r.json.data.email, "stranger@example.com");
        assert.equal(mails.length, n, "no sign-in code was emailed");
        const reg = await register("stranger@example.com", "Stranger Danger");
        assert.equal(reg.status, 403);
        assert.equal(reg.json.code, "invite_required");
        assert.equal(await User.countDocuments({ email: "stranger@example.com" }), 0);
        const bad = await call("POST", "/api/auth/otp/send", { channel: "email", email: "stranger@example.com", inviteToken: I.newInviteToken() });
        assert.equal(bad.json.code, "invite_invalid");
    });

    await ok("dashboard mobile sign-in without an invite: no WhatsApp code, no account", async () => {
        const r = await call("POST", "/api/auth/otp/send", { channel: "phone", phone: "9000000201", phoneCountryCode: "+91" });
        assert.equal(r.status, 403);
        assert.equal(r.json.code, "invite_required");
        assert.equal(r.json.data.phone, "9000000201");
        assert.equal(metaSent.length, 0);
        await assert.rejects(A.findOrCreatePhoneUser("+91", "9000000201", "Phone Stranger"), (e: { code?: string }) => e.code === "invite_required");
        assert.equal(await User.countDocuments({ phoneKey: "+919000000201" }), 0);
    });

    await ok("Google sign-up without an invite: no account; the waitlist form gets their email and name", async () => {
        const profile = { googleId: "g-stranger-1", email: "gstranger@example.com", name: "Gauri Stranger", emailVerified: true };
        await assert.rejects(A.findOrCreateGoogleUser(profile), (e: { code?: string; data?: Record<string, unknown> }) =>
            e.code === "invite_required" && e.data?.email === "gstranger@example.com" && e.data?.name === "Gauri Stranger");
        assert.equal(await User.countDocuments({ email: "gstranger@example.com" }), 0);
        // with an invite, Google works
        const { token, inviteId } = await freshLink();
        const u = await A.findOrCreateGoogleUser(profile, { inviteToken: token });
        assert.equal(u.email, "gstranger@example.com");
        const inv = await Invite.findOne({ inviteId }).lean<Record<string, any>>();
        assert.equal(inv!.usedVia, "google");
        assert.equal(inv!.usedByUserId, u.userId);
    });

    await ok("WhatsApp hi from an unknown number: no account, no family, one short line, a waitlist entry (once); the brain is not called", async () => {
        const families = await familyCount();
        const out = await whatsapp("+919000000301", "hi", "Kiran 😊 Wala");
        assert.match(out.content, /invite-only/);
        assert.match(out.content, /waitlist/);
        assert.equal(out.content.split("\n").length, 1, "one line");
        assert.equal(out.brain, false);
        assert.equal(await User.countDocuments({ phoneKey: "+919000000301" }), 0);
        const e = await WaitlistEntry.findOne({ phoneDigits: "919000000301" }).lean<Record<string, any>>();
        assert.equal(e!.source, "whatsapp");
        assert.equal(e!.status, "pending");
        assert.equal(e!.name, "Kiran Wala");
        await whatsapp("+919000000301", "hello?");
        assert.equal(await WaitlistEntry.countDocuments({ phoneDigits: "919000000301" }), 1);
        assert.equal((await WaitlistEntry.findOne({ phoneDigits: "919000000301" }).lean<Record<string, any>>())!.attempts, 2);
        const wrong = await whatsapp("+919000000302", `hi KAVACH-${I.newInviteToken()}`);
        assert.match(wrong.content, /couldn't find that invite code/);
        assert.equal(await User.countDocuments({ phoneKey: "+919000000302" }), 0);
        assert.equal(await familyCount(), families, "no family was made");
        assert.equal(metaSent.length, 0, "nothing went to Meta");
    });

    await ok("WhatsApp hi with a valid invite code: no account, no family, the join link back, and the invite stays usable (on the web)", async () => {
        const { token, inviteId } = await freshLink();
        const families = await familyCount();
        for (const text of [`hi kavach-${token.toLowerCase()}`, `hi KAVACH-${token}`]) {
            const out = await whatsapp("+919000000311", text, "Lata Iyer");
            assert.equal(out.content, `Namaste 🙏 Please open your invite link to sign up on the web: https://app.example.com/join/${token}`);
            assert.equal(out.brain, false);
        }
        assert.equal(await User.countDocuments({ phoneKey: "+919000000311" }), 0, "no account");
        assert.equal(await familyCount(), families, "no family");
        assert.equal(await WaitlistEntry.countDocuments({ phoneDigits: "919000000311" }), 0, "an invited person isn't put on the waitlist");
        const inv = await Invite.findOne({ inviteId }).lean<Record<string, any>>();
        assert.equal(inv!.status, "active", "the invite is not used up");
        assert.equal(inv!.usedVia ?? null, null);
        assert.equal((await I.lookupInvite(token)).state, "active");
        // the same invite then signs them up on the web, once
        const reg = await register("lata@example.com", "Lata Iyer", token);
        assert.equal(reg.status, 201, JSON.stringify(reg.json));
        assert.equal((await Invite.findOne({ inviteId }).lean<Record<string, any>>())!.usedVia, "email");
        // a used code on WhatsApp: no account, and the waitlist line
        const again = await whatsapp("+919000000312", `hi KAVACH-${token}`);
        assert.match(again.content, /already been used/);
        assert.equal(await User.countDocuments({ phoneKey: "+919000000312" }), 0);
    });

    await ok("the dashboard waitlist form: one entry per person, asking again only bumps it", async () => {
        const r = await call("POST", "/api/waitlist", { name: "Nisha Verma", email: "Nisha@Example.com", phone: "9000000321", phoneCountryCode: "+91", note: "my father, 78" });
        assert.equal(r.status, 201);
        assert.equal(r.json.data.onWaitlist, true);
        const again = await call("POST", "/api/waitlist", { name: "Nisha Verma", email: "nisha@example.com" });
        assert.equal(again.status, 201);
        const rows = await WaitlistEntry.find({ email: "nisha@example.com" }).lean<Array<Record<string, any>>>();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].attempts, 2);
        assert.equal(rows[0].phoneDigits, "919000000321");
        assert.equal(rows[0].note, "my father, 78");
        assert.equal(rows[0].source, "dashboard");
        assert.equal((await call("POST", "/api/waitlist", { name: "X", email: "nope" })).status, 400);
        assert.equal((await call("POST", "/api/waitlist", { name: "Okay Name", email: "nope" })).status, 400);
    });

    /* ── approval ──────────────────────────────────────────────────────────── */

    await ok("approve: the email goes out (faked) with 'Complete your sign-up' (their personal link); then they can register", async () => {
        const e = await WaitlistEntry.findOne({ email: "nisha@example.com" }).lean<Record<string, any>>();
        const n = mails.length;
        const res = await W.approveWaitlist(e!.waitlistId, "owner@kavach.care");
        assert.equal(res.emailSent, true);
        assert.equal(mails.length, n + 1);
        const mail = mails.at(-1)!;
        assert.equal(mail.to, "nisha@example.com");
        assert.match(mail.subject, /Nisha, your place on Kavach is ready/);
        const token = tokenOf(res.link);
        assert.ok(new RegExp(`<a href="https://app\\.example\\.com/join/${token}"[^>]*>\\s*Complete your sign-up`).test(String(mail.html)));
        assert.ok(!String(mail.html).includes("wa.me") && !String(mail.html).includes(`KAVACH-${token}`), "no WhatsApp-first button");
        assert.ok(String(mail.text).includes(`https://app.example.com/join/${token}`));
        assert.ok(!("whatsappLink" in res));
        const after = await WaitlistEntry.findOne({ waitlistId: e!.waitlistId }).lean<Record<string, any>>();
        assert.equal(after!.status, "approved");
        assert.equal(after!.approvedBy, "owner@kavach.care");
        assert.ok(after!.approvalEmailSentAt);
        const look = await I.lookupInvite(token);
        assert.equal(look.state, "active");
        assert.equal(look.inviterName, "The Kavach team");
        // their own email now works on the dashboard without any link
        const send = await call("POST", "/api/auth/otp/send", { channel: "email", email: "nisha@example.com" });
        assert.equal(send.status, 200, JSON.stringify(send.json));
        const reg = await register("nisha@example.com", "Nisha Verma");
        assert.equal(reg.status, 201, JSON.stringify(reg.json));
        const done = await WaitlistEntry.findOne({ waitlistId: e!.waitlistId }).lean<Record<string, any>>();
        assert.ok(done!.registeredUserId);
        assert.equal((await I.lookupInvite(token)).state, "revoked", "the personal link is retired once they have an account");
        await assert.rejects(W.approveWaitlist(e!.waitlistId, "owner@kavach.care"), (x: { code?: string }) => x.code === "already_registered");
    });

    let kiranId = "";
    await ok("an approved WhatsApp waitlist number: no account or family from a hi, just the way to the web sign-up", async () => {
        const e = await WaitlistEntry.findOne({ phoneDigits: "919000000301" }).lean<Record<string, any>>();
        const res = await W.approveWaitlist(e!.waitlistId, "help@kavach.care");
        assert.equal(res.emailSent, false);
        assert.equal(res.emailError, "no_email");
        const families = await familyCount();
        const out = await whatsapp("+919000000301", "hi");
        assert.equal(out.content, "Namaste 🙏 You're off the waitlist! Sign up on the web with this number at https://app.example.com/auth/login, then say hi here once you've finished setting up.");
        assert.equal(out.brain, false);
        assert.equal(await User.countDocuments({ phoneKey: "+919000000301" }), 0, "no account");
        assert.equal(await familyCount(), families, "no family");
        assert.equal((await WaitlistEntry.findOne({ waitlistId: e!.waitlistId }).lean<Record<string, any>>())!.registeredUserId ?? null, null);
        // they sign up on the web with that number (mobile sign-in; the sign-in gives them their family)
        const u = await A.findOrCreatePhoneUser("+91", "9000000301", "Kiran Wala");
        await ensureDefaultFamily(u);
        kiranId = u.userId;
        assert.equal((await User.findOne({ userId: u.userId }).lean<Record<string, any>>())!.onboarding.status, "pending");
        assert.ok((await WaitlistEntry.findOne({ waitlistId: e!.waitlistId }).lean<Record<string, any>>())!.registeredUserId);
    });

    await ok("a caregiver who hasn't finished the web onboarding gets one line pointing there; the brain is never called", async () => {
        const finish = "Namaste 🙏 Finish setting up at https://app.example.com/onboarding, then say hi here.";
        assert.equal(await WF.finishOnWebLine(), finish);
        const families = await familyCount();
        for (const text of ["hi", "remind my mother of her BP tablet at 8"]) {
            const out = await whatsapp("+919000000301", text);
            assert.equal(out.content, finish);
            assert.equal(out.brain, false, "the message never reaches the brain");
        }
        // "Finish later" on the web (skipped) is not finished either
        await User.updateOne({ userId: kiranId }, { $set: { onboarding: { status: "skipped", at: new Date() } } });
        const skipped = await whatsapp("+919000000301", "hello");
        assert.equal(skipped.content, finish);
        assert.equal(skipped.brain, false);
        // every answer saved but Finish never tapped (live 15 Oct 2026): they hear that only the last step is left
        const { OnboardingDraft } = await import("../src/models/onboarding.model");
        await OnboardingDraft.create({ userId: kiranId, familyId: "draft-fam", step: "p_whatsapp:0",
            answers: { careFor: "mother", you: { name: "Kiran" }, persons: [{ relation: "Mother", name: "Asha" }] } });
        const almost = await whatsapp("+919000000301", "Done");
        assert.match(almost.content, /one step away.*https:\/\/app\.example\.com\/onboarding.*Finish/);
        assert.equal(almost.brain, false);
        await OnboardingDraft.deleteMany({ userId: kiranId });
        assert.equal(await familyCount(), families, "no family was made");
        // the web onboarding's own WhatsApp check ("KAVACH 123456" sent from their phone) still goes through
        const v = await startVerification(kiranId, { target: "self", phone: "+919000000301", method: "message" });
        const verified = await whatsapp("+919000000301", String(v.text));
        assert.match(verified.content, /नंबर जुड़ गया|number is connected/, "Saheli's 'your number is connected' thank-you");
        assert.equal(verified.brain, false);
        // once the web onboarding is done (what completeOnboarding writes), Saheli answers
        await User.updateOne({ userId: kiranId }, { $set: { onboarding: { status: "done", at: new Date() } } });
        const after = await whatsapp("+919000000301", "hi");
        assert.equal(after.brain, true);
        assert.equal(after.content, BRAIN_REPLY);
        assert.equal(brainTurns.at(-1)!.speaker.id, kiranId);
    });

    await ok("part-way through the web setup: their own proven number, or the number of someone they're adding, is pointed to the web, not the waitlist", async () => {
        const reg = await register("halfway@example.com", "Zoya Halfway");
        assert.equal(reg.status, 403, "uninvited");
        const { token } = await freshLink();
        assert.equal((await register("halfway@example.com", "Zoya Halfway", token)).status, 201);
        const u = (await User.findOne({ email: "halfway@example.com" }))!;
        await ensureDefaultFamily(u);
        const mine = await startVerification(u.userId, { target: "self", phone: "+919000000341", method: "message" });
        assert.match((await whatsapp("+919000000341", String(mine.text))).content, /नंबर जुड़ गया|number is connected/);
        const out = await whatsapp("+919000000341", "hi");
        assert.equal(out.content, "Namaste 🙏 Finish setting up at https://app.example.com/onboarding, then say hi here.");
        const theirs = await startVerification(u.userId, { target: "person:0", phone: "+919000000342", method: "message" });
        await whatsapp("+919000000342", String(theirs.text));
        const parent = await whatsapp("+919000000342", "namaste");
        assert.match(parent.content, /still setting me up/);
        assert.equal(out.brain || parent.brain, false);
        assert.equal(await WaitlistEntry.countDocuments({ phoneDigits: { $in: ["919000000341", "919000000342"] } }), 0);
        assert.equal(await User.countDocuments({ phoneKey: { $in: ["+919000000341", "+919000000342"] } }), 0);
    });

    await ok("the personal link from the email works once, whichever email they register with", async () => {
        const { waitlistId } = await W.joinWaitlist({ name: "Pooja Shah", email: "pooja@example.com", source: "dashboard" });
        const res = await W.approveWaitlist(waitlistId, "owner@kavach.care");
        const token = tokenOf(res.link);
        const reg = await register("pooja.work@example.com", "Pooja Shah", token);
        assert.equal(reg.status, 201, JSON.stringify(reg.json));
        assert.ok((await WaitlistEntry.findOne({ waitlistId }).lean<Record<string, any>>())!.registeredUserId);
        assert.equal((await register("pooja.other@example.com", "Pooja Again", token)).json.code, "invite_used");
    });

    await ok("an email that fails to send is recorded, the approval still stands; reject closes the door", async () => {
        const { waitlistId } = await W.joinWaitlist({ name: "Quinn Das", email: "quinn@example.com", source: "dashboard" });
        failNext = true;
        const res = await W.approveWaitlist(waitlistId, "owner@kavach.care");
        assert.equal(res.emailSent, false);
        assert.match(String(res.emailError), /simulated send failure/);
        const e = await WaitlistEntry.findOne({ waitlistId }).lean<Record<string, any>>();
        assert.equal(e!.status, "approved");
        assert.match(String(e!.approvalEmailError), /simulated/);
        // re-approving re-sends with a new link; the old link stops
        const again = await W.approveWaitlist(waitlistId, "owner@kavach.care");
        assert.equal(again.emailSent, true);
        assert.equal((await I.lookupInvite(tokenOf(res.link))).state, "revoked");
        await W.rejectWaitlist(waitlistId, "owner@kavach.care");
        assert.equal((await I.lookupInvite(tokenOf(again.link))).state, "revoked");
        const send = await call("POST", "/api/auth/otp/send", { channel: "email", email: "quinn@example.com" });
        assert.equal(send.json.code, "invite_required");
    });

    await ok("admin routes: pending first, contacts masked, approve/reject with the service rules", async () => {
        await W.joinWaitlist({ name: "Ritu Malhotra", email: "ritu@example.com", phone: "9000000331", phoneCountryCode: "+91", source: "dashboard" });
        const routes = waitlistRoutes();
        const route = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p)!;
        const admin = { email: "owner@kavach.care", role: "owner" } as never;
        const list = (await route("get", "/waitlist").handler({ admin, params: {}, query: {}, body: undefined })).data as Record<string, any>;
        assert.equal(list.entries[0].status, "pending");
        assert.ok(list.counts.pending >= 1);
        const ritu = list.entries.find((x: { name: string }) => x.name === "Ritu M.");
        assert.ok(ritu, "the name is masked to first name + initial");
        assert.equal(ritu.email, "r••u@example.com");
        assert.ok(!JSON.stringify(list).includes("ritu@example.com"), "no clear email in the list");
        assert.ok(!JSON.stringify(list).includes("9000000331"), "no clear number in the list");
        const pend = (await route("get", "/waitlist").handler({ admin, params: {}, query: { status: "pending" }, body: undefined })).data as Record<string, any>;
        assert.ok(pend.entries.every((x: { status: string }) => x.status === "pending"));
        const approved = await route("post", "/waitlist/:waitlistId/approve").handler({ admin, params: { waitlistId: ritu.waitlistId }, query: {}, body: {} });
        assert.equal((approved.data as Record<string, any>).emailSent, true);
        assert.equal(approved.target, `waitlist:${ritu.waitlistId}`);
        const support = { email: "help@kavach.care", role: "analyst" } as never;
        const noLink = await route("post", "/waitlist/:waitlistId/approve").handler({ admin: support, params: { waitlistId: ritu.waitlistId }, query: {}, body: {} });
        assert.equal((noLink.data as Record<string, any>).link, null, "only those who may reveal contacts get the link");
        await assert.rejects(route("post", "/waitlist/:waitlistId/approve").handler({ admin, params: { waitlistId: randomUUID() }, query: {}, body: {} }),
            (e: { status?: number; code?: string }) => e.status === 404 && e.code === "no_such_entry");
        await assert.rejects(route("post", "/waitlist/:waitlistId/reject").handler({ admin, params: { waitlistId: "x" }, query: {}, body: {} }),
            (e: { status?: number }) => e.status === 400);
        const revealed = await route("post", "/waitlist/:waitlistId/reveal").handler({ admin, params: { waitlistId: ritu.waitlistId }, query: {}, body: {} });
        assert.equal((revealed.data as Record<string, any>).email, "ritu@example.com");
    });

    /* ── nothing else changes ──────────────────────────────────────────────── */

    await ok("family members a caregiver adds still work and reach Saheli on WhatsApp with no web step: a parent, a co-caregiver; Saheli's add tool", async () => {
        const fam = await caregiver("family.head@example.com", "Sunita");
        await inviteFamilyMember(fam.familyId, fam.user, { role: "care_recipient", name: "Kamla Devi", relationship: "mother", phone: "9000000401", phoneCountryCode: "+91", notify: false });
        const who = await resolveWhatsAppSender("+919000000401");
        assert.equal(who.familyId, fam.familyId);
        const elder = await whatsapp("+919000000401", "namaste");
        assert.equal(elder.brain, true, "the person cared for reaches Saheli");
        assert.equal(elder.content, BRAIN_REPLY);
        assert.equal(brainTurns.at(-1)!.speaker.id, who.userId);
        assert.equal(await WaitlistEntry.countDocuments({ phoneDigits: "919000000401" }), 0);
        // even while the caregiver who added her is still part-way through the web setup
        await User.updateOne({ userId: fam.user.userId }, { $set: { onboarding: { status: "pending" } } });
        assert.equal((await whatsapp("+919000000401", "aaj kya hai?")).brain, true);
        await User.updateOne({ userId: fam.user.userId }, { $unset: { onboarding: "" } });

        await inviteFamilyMember(fam.familyId, fam.user, { role: "co_caregiver", name: "Cousin Arjun", email: "cousin@example.com" });
        const before = mails.length;
        const send = await call("POST", "/api/auth/otp/send", { channel: "email", email: "cousin@example.com" });
        assert.equal(send.status, 200, JSON.stringify(send.json));
        const code = String(mails.slice(before).find((m) => m.to === "cousin@example.com")!.subject).slice(0, 6);
        const verify = await call("POST", "/api/auth/otp/verify", { channel: "email", email: "cousin@example.com", code, otpToken: send.json.data.otpToken });
        assert.equal(verify.status, 200, JSON.stringify(verify.json));
        assert.equal(verify.json.data.registered, true);
        // he accepts (joining marks his own onboarding "skipped"), has an empty family of his own, and writes to Saheli
        const arjun = (await User.findOne({ email: "cousin@example.com" }))!;
        await Family.updateOne({ familyId: fam.familyId, "members.userId": arjun.userId }, { $set: { "members.$.status": FamilyMemberStatus.JOINED } });
        await User.updateOne({ userId: arjun.userId }, { $set: { onboarding: { status: "skipped", at: new Date() } } });
        await createDefaultFamilyForUser(arjun);
        await givePhone(arjun.userId, "9000000403");
        const co = await whatsapp("+919000000403", "hi");
        assert.equal(co.brain, true, "a co-caregiver a caregiver added reaches Saheli");
        assert.equal(await WF.webSetupUnfinished({ userId: arjun.userId, role: FamilyRole.PRIMARY_CAREGIVER }), false, "even from his own empty family");

        const signedUp = await caregiver("wa.head@example.com", "Vikram");
        const added = (await executeSaheliTool({ tool: "add_family_member" as never, args: { name: "Bhagwati Devi", relationship: "mother", phone: "9000000402" },
                                                  familyId: signedUp.familyId, recipientUserId: signedUp.user.userId, actorUserId: signedUp.user.userId })) as Record<string, any>;
        assert.equal(added.ok, true, JSON.stringify(added));
    });

    await ok("existing accounts sign in exactly as before (email, Google, mobile), no invite asked", async () => {
        const before = mails.length;
        const send = await call("POST", "/api/auth/otp/send", { channel: "email", email: "inviter@example.com" });
        assert.equal(send.status, 200);
        const code = String(mails.slice(before).find((m) => m.to === "inviter@example.com")!.subject).slice(0, 6);
        const verify = await call("POST", "/api/auth/otp/verify", { channel: "email", email: "inviter@example.com", code, otpToken: send.json.data.otpToken });
        assert.equal(verify.json.data.registered, true);
        const g = await A.findOrCreateGoogleUser({ googleId: "g-inviter", email: "inviter@example.com", name: "Meera Tester", emailVerified: true });
        assert.equal(g.userId, inviter.user.userId);
        const phoneUser = await A.findOrCreatePhoneUser("+91", "9000000301", "Kiran Wala");
        assert.equal(phoneUser.userId, kiranId);
        assert.equal(await User.countDocuments({ phoneKey: "+919000000301" }), 1);
    });

    await ok("families already set up reach Saheli as before: no onboarding status (accounts from before onboarding), or done with a draft left open", async () => {
        const old = await caregiver("before.onboarding@example.com", "Asha");
        assert.equal((await User.findOne({ userId: old.user.userId }).lean<Record<string, any>>())!.onboarding?.status, undefined);
        await inviteFamilyMember(old.familyId, old.user, { role: "care_recipient", name: "Ramesh Rao", relationship: "father", phone: "9000000411", phoneCountryCode: "+91", notify: false });
        await givePhone(old.user.userId, "9000000412");
        const cg = await whatsapp("+919000000412", "hi");
        assert.equal(cg.brain, true, "the caregiver of a family set up before onboarding existed");
        assert.equal(cg.content, BRAIN_REPLY);
        assert.equal((await whatsapp("+919000000411", "namaste")).brain, true, "and the person they care for");
        // self care, finished on the web, with an onboarding draft that was never closed
        const done = await caregiver("done.draft@example.com", "Ira");
        await User.updateOne({ userId: done.user.userId }, { $set: { onboarding: { status: "done", at: new Date() } } });
        await OnboardingDraft.create({ userId: done.user.userId, familyId: done.familyId, answers: {}, step: "welcome" });
        await givePhone(done.user.userId, "9000000413");
        const self = await whatsapp("+919000000413", "hi");
        assert.equal(self.brain, true);
        assert.equal(brainTurns.at(-1)!.speaker.id, done.user.userId);
    });

    await ok("invite-only switched off (admin flag): sign-up is open again; a link given is still used up", async () => {
        setFlagSnapshot({ "signup.inviteOnly": false });
        try {
            const reg = await register("open1@example.com", "Open Door");
            assert.equal(reg.status, 201, JSON.stringify(reg.json));
            const { token, inviteId } = await freshLink();
            assert.equal((await register("open2@example.com", "Open Two", token)).status, 201);
            assert.equal((await Invite.findOne({ inviteId }).lean<Record<string, any>>())!.status, "used");
            // still no sign-up on WhatsApp: the way to the web, no account, no waitlist
            const open = await whatsapp("+919000000421", "hi");
            assert.equal(open.content, "Namaste 🙏 I'm Saheli from Kavach. Sign up at https://app.example.com/auth/login, finish setting up there, then say hi here.");
            assert.equal(open.brain, false);
            assert.equal(await User.countDocuments({ phoneKey: "+919000000421" }), 0);
            assert.equal(await WaitlistEntry.countDocuments({ phoneDigits: "919000000421" }), 0);
        } finally {
            setFlagSnapshot({});
        }
        assert.equal((await register("closed@example.com", "Closed Again")).json.code, "invite_required");
    });

    server.close();
}

(async () => {
    await pure();
    const uri = testDbUri("invitetest");
    if (uri) {
        try {
            await withDb(uri);
        } finally {
            await new Promise((r) => setTimeout(r, 300));
            await mongoose.disconnect().catch(() => undefined);
        }
    } else {
        console.log("  (DB checks skipped: set TEST_MONGODB_URI)");
    }
    if (process.exitCode) {
        console.error("FAILED");
        process.exit(1);
    }
    console.log(`all ${passed} passed`);
    process.exit(0);
})();
