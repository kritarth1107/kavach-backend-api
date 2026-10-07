/** Users and families: search, masked detail, reveal (with reason), account and Saheli actions, internal notes. */
import { createHmac } from "crypto";
import { z } from "zod";
import { AdminError } from "../auth";
import { engine } from "../engine";
import { AdminNote, SupportIssue, type IAdminNote, type ISupportIssue } from "../models";
import type { RouteDef } from "../router";
import ActivityLog from "../../models/activityLog.model";
import Family from "../../models/family.model";
import McpConnection from "../../models/mcpConnection.model";
import Order from "../../models/order.model";
import OutboundMessage from "../../models/outboundMessage.model";
import SaheliCompanion from "../../models/saheliCompanion.model";
import SaheliPermissions from "../../models/saheliPermissions.model";
import Session from "../../models/session.model";
import User from "../../models/users.model";
import VoicePreference from "../../models/voicePreference.model";
import ZeptoConnection from "../../models/zeptoConnection.model";
import FeatureFlag from "../../models/featureFlag.model";
import { brainV2Mode } from "../../services/brainV2.service";
import { flaggedEnv, isSaheliPaused, refreshFlags } from "../../services/featureFlags.service";
import {
    daysAgo, esc, fullActivity, fullName, iso, maskedUser, PAGE, pageOf, phoneOf, safeActivity, usersById,
    type ActivityDoc, type UserDoc,
} from "./shared";

type Member = { userId: string; role: string; status: string; joinedAt?: Date; invitedAt?: Date };
type FamilyDoc = { familyId: string; name?: string; members: Member[]; createdBy?: string; status?: string; createdAt?: Date };

const joined = (m: Member) => m.status === "JOINED" || m.status === "ACTIVE";

async function familyOr404(familyId: string): Promise<FamilyDoc> {
    const f = await Family.findOne({ familyId }).lean<FamilyDoc>();
    if (!f) throw new AdminError(404, "no_such_family");
    return f;
}

/** Add or remove one family atomically ($addToSet / $pull), so two admins acting at once never undo each other. */
async function setListFlag(key: "saheli.pausedFamilies" | "brain.liveFamilies", familyId: string, on: boolean, by: string, reason?: string) {
    const row = await FeatureFlag.findOne({ key }).lean<{ value?: unknown }>();
    if (!row || !Array.isArray(row.value)) {
        // First use: start from the env list (live families) or empty, then edit atomically from there.
        const env = key === "brain.liveFamilies" ? (process.env.BRAIN_V2_LIVE_FAMILIES || "").split(",").map((s) => s.trim()).filter(Boolean) : [];
        await FeatureFlag.updateOne({ key, $or: [{ value: null }, { value: { $exists: false } }] }, { $set: { key, value: env, updatedBy: by, updatedAt: new Date() } }, { upsert: !row });
    }
    await FeatureFlag.updateOne({ key }, { ...(on ? { $addToSet: { value: familyId } } : { $pull: { value: familyId } }), $set: { updatedBy: by, reason, updatedAt: new Date() } });
    await refreshFlags();
}

/** What was searched, without the value: its kind and a keyed hash (so repeated probing of one number shows up). */
function searchFingerprint(q: string): { searchKind: string; searchHash: string } {
    const t = q.trim();
    const kind = /@/.test(t) ? "email" : t.replace(/\D/g, "").length >= 6 ? "phone" : /^[\w-]{20,}$/.test(t) ? "id" : "name";
    const key = process.env.ADMIN_AUDIT_KEY || "";
    return { searchKind: kind, searchHash: createHmac("sha256", key).update(t.toLowerCase()).digest("hex").slice(0, 16) };
}

const searchTimes = new Map<string, number[]>();
/** At most 40 searches a minute per admin: enough to work, too few to rebuild hidden numbers by guessing. */
function limitSearches(email: string, now = Date.now()) {
    const recent = (searchTimes.get(email) || []).filter((t) => now - t < 60_000);
    if (recent.length >= 40) throw new AdminError(429, "too_many_searches", "Slow down: too many searches in a minute.");
    recent.push(now);
    searchTimes.set(email, recent);
}

export function peopleRoutes(): RouteDef[] {
    return [
        // ── search (command palette) ────────────────────────────────────────────
        {
            method: "get", path: "/search", perm: "users.read", action: "search.run",
            handler: async ({ admin, query }) => {
                const q = String(query.q || "").trim().slice(0, 80);
                if (q.length < 3) return { data: { users: [], families: [] } };
                limitSearches(admin.email);
                const rx = new RegExp(esc(q), "i");
                const digits = q.replace(/\D/g, "");
                const userQ: Record<string, unknown>[] = [{ userId: q }, { email: rx }, { firstName: rx }, { lastName: rx }];
                if (digits.length >= 6) userQ.push({ phoneKey: new RegExp(`${esc(digits)}$`) });
                const [users, families] = await Promise.all([
                    User.find({ $or: userQ }).limit(8).lean<UserDoc[]>(),
                    Family.find({ $or: [{ familyId: q }, { name: rx }] }).limit(8).lean<FamilyDoc[]>(),
                ]);
                return {
                    detail: { n: users.length + families.length, ...searchFingerprint(q) },
                    data: { users: users.map(maskedUser), families: families.map((f) => ({ familyId: f.familyId, name: f.name || "Family", members: f.members.filter(joined).length })) },
                };
            },
        },

        // ── users ───────────────────────────────────────────────────────────────
        {
            method: "get", path: "/users", perm: "users.read", action: "users.list",
            handler: async ({ admin, query }) => {
                if (query.q) limitSearches(admin.email);
                const page = pageOf(query);
                const filter: Record<string, unknown> = {};
                if (query.status) filter.status = query.status;
                if (query.q && query.q.trim().length >= 2) {
                    const rx = new RegExp(esc(query.q.trim()), "i");
                    const digits = query.q.replace(/\D/g, "");
                    filter.$or = [{ userId: query.q.trim() }, { email: rx }, { firstName: rx }, { lastName: rx }, ...(digits.length >= 6 ? [{ phoneKey: new RegExp(`${esc(digits)}$`) }] : [])];
                }
                const [rows, total] = await Promise.all([
                    User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean<UserDoc[]>(),
                    User.countDocuments(filter),
                ]);
                const ids = rows.map((u) => u.userId);
                const fams = await Family.find({ "members.userId": { $in: ids } }, { familyId: 1, name: 1, members: 1 }).lean<FamilyDoc[]>();
                return {
                    detail: { page, n: rows.length, ...(query.q ? searchFingerprint(query.q) : {}) },
                    data: {
                        total, page, pageSize: PAGE,
                        users: rows.map((u) => {
                            const mine = fams.filter((f) => f.members.some((m) => m.userId === u.userId && m.status !== "REMOVED"));
                            const role = mine[0]?.members.find((m) => m.userId === u.userId)?.role || null;
                            return { ...maskedUser(u), families: mine.length, role };
                        }),
                    },
                };
            },
        },
        {
            method: "get", path: "/users/:userId", perm: "users.read", action: "user.view",
            handler: async ({ params }) => {
                const u = await User.findOne({ userId: params.userId }).lean<UserDoc>();
                if (!u) throw new AdminError(404, "no_such_user");
                const [fams, sessions, issues, notes] = await Promise.all([
                    Family.find({ "members.userId": u.userId }).lean<FamilyDoc[]>(),
                    Session.find({ userId: u.userId }).sort({ lastActiveAt: -1 }).limit(20).lean<Array<{ sessionId: string; status: string; lastActiveAt?: Date; createdAt?: Date; authProvider?: string; userAgent?: string }>>(),
                    SupportIssue.find({ userId: u.userId }).sort({ createdAt: -1 }).limit(20).lean<ISupportIssue[]>(),
                    AdminNote.find({ target: `user:${u.userId}` }).sort({ at: -1 }).limit(50).lean<IAdminNote[]>(),
                ]);
                return {
                    target: `user:${u.userId}`,
                    data: {
                        user: { ...maskedUser(u), emailVerified: !!u.emailVerified },
                        families: fams.map((f) => {
                            const m = f.members.find((x) => x.userId === u.userId);
                            return { familyId: f.familyId, name: f.name || "Family", role: m?.role, status: m?.status, joinedAt: iso(m?.joinedAt) };
                        }),
                        sessions: {
                            active: sessions.filter((s) => s.status === "ACTIVE").length,
                            recent: sessions.slice(0, 8).map((s) => ({ status: s.status, lastActiveAt: iso(s.lastActiveAt), createdAt: iso(s.createdAt), provider: s.authProvider || null, device: (s.userAgent || "").slice(0, 80) || null })),
                        },
                        issues: issues.map((i) => ({ issueId: i.issueId, title: i.title, status: i.status, priority: i.priority, createdAt: iso(i.createdAt) })),
                        notes: notes.map((n) => ({ text: n.text, by: n.by, at: iso(n.at) })),
                    },
                };
            },
        },
        {
            method: "post", path: "/users/:userId/reveal", perm: "pii.reveal", action: "user.reveal",
            handler: async ({ params }) => {
                const u = await User.findOne({ userId: params.userId }).lean<UserDoc>();
                if (!u) throw new AdminError(404, "no_such_user");
                return { target: `user:${u.userId}`, data: { name: fullName(u), email: u.email || null, phone: phoneOf(u) } };
            },
        },
        {
            method: "post", path: "/users/:userId/status", perm: "users.manage", action: "user.status",
            handler: async ({ params, body }) => {
                const input = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input", "status must be ACTIVE or SUSPENDED");
                const u = await User.findOne({ userId: params.userId }).lean<UserDoc>();
                if (!u) throw new AdminError(404, "no_such_user");
                if (u.status === "DELETED" || u.status === "BANNED") throw new AdminError(400, "bad_input", `account is ${u.status}`);
                await User.updateOne({ userId: u.userId }, { $set: { status: input.data.status } });
                let revoked = 0;
                if (input.data.status === "SUSPENDED") {
                    revoked = (await Session.updateMany({ userId: u.userId, status: "ACTIVE" }, { $set: { status: "REVOKED" } })).modifiedCount ?? 0;
                }
                return { target: `user:${u.userId}`, detail: { from: u.status || "ACTIVE", to: input.data.status, revoked }, data: { status: input.data.status, sessionsEnded: revoked } };
            },
        },
        {
            method: "post", path: "/users/:userId/signout", perm: "users.manage", action: "user.signout",
            handler: async ({ params }) => {
                if (!(await User.exists({ userId: params.userId }))) throw new AdminError(404, "no_such_user");
                const r = await Session.updateMany({ userId: params.userId, status: "ACTIVE" }, { $set: { status: "REVOKED" } });
                return { target: `user:${params.userId}`, detail: { revoked: r.modifiedCount ?? 0 }, data: { sessionsEnded: r.modifiedCount ?? 0 } };
            },
        },

        // ── families ────────────────────────────────────────────────────────────
        {
            method: "get", path: "/families", perm: "users.read", action: "families.list",
            handler: async ({ query }) => {
                const page = pageOf(query);
                const filter: Record<string, unknown> = {};
                if (query.q && query.q.trim().length >= 2) filter.$or = [{ familyId: query.q.trim() }, { name: new RegExp(esc(query.q.trim()), "i") }];
                const [rows, total] = await Promise.all([
                    Family.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean<FamilyDoc[]>(),
                    Family.countDocuments(filter),
                ]);
                await refreshFlags().catch(() => undefined);
                const env = flaggedEnv();
                const people = await usersById(rows.flatMap((f) => f.members.filter(joined).map((m) => m.userId)));
                const last = await Promise.all(rows.map((f) => ActivityLog.findOne({ familyId: f.familyId }, { createdAt: 1 }).sort({ createdAt: -1 }).lean<{ createdAt?: Date }>()));
                const week = await Promise.all(rows.map((f) => ActivityLog.countDocuments({ familyId: f.familyId, kind: "message_in", createdAt: { $gte: daysAgo(7) } })));
                return {
                    detail: { page, n: rows.length },
                    data: {
                        total, page, pageSize: PAGE,
                        families: rows.map((f, i) => {
                            const live = f.members.filter(joined);
                            const elders = live.filter((m) => m.role === "CARE_RECIPIENT").map((m) => maskedUser(people.get(m.userId))?.name || "Elder");
                            const caregivers = live.filter((m) => m.role === "PRIMARY_CAREGIVER" || m.role === "CO_CAREGIVER").length;
                            return {
                                familyId: f.familyId, name: f.name || "Family", status: f.status || "ACTIVE", createdAt: iso(f.createdAt),
                                members: live.length, caregivers, elders, lastActivityAt: iso(last[i]?.createdAt), messages7d: week[i],
                                brain: brainV2Mode(f.familyId, env), paused: isSaheliPaused(f.familyId),
                            };
                        }),
                    },
                };
            },
        },
        {
            method: "get", path: "/families/:familyId", perm: "users.read", action: "family.view",
            handler: async ({ params }) => {
                const f = await familyOr404(params.familyId);
                await refreshFlags().catch(() => undefined);
                const since = daysAgo(7);
                const fid = f.familyId;
                const [people, companions, perms, mcp, zepto, voice, recent, notes, issues, counts, orders7, failed7] = await Promise.all([
                    usersById(f.members.map((m) => m.userId)),
                    SaheliCompanion.find({ familyId: fid }).lean<Array<{ recipientUserId: string; enabled?: boolean; preferredLanguage?: string; lastWhatsAppInboundAt?: Date; quietHoursStart?: string; quietHoursEnd?: string; nudgeIntensity?: string; relationshipLabel?: string }>>(),
                    SaheliPermissions.findOne({ familyId: fid }).lean<Record<string, unknown>>(),
                    McpConnection.find({ familyId: fid }, { partner: 1, connectedAt: 1, userId: 1 }).lean<Array<{ partner: string; connectedAt?: Date }>>(),
                    ZeptoConnection.find({ familyId: fid }, { connectedAt: 1 }).lean<Array<{ connectedAt?: Date }>>(),
                    VoicePreference.find({ familyId: fid }).lean<Array<{ userId: string; mode: string }>>(),
                    ActivityLog.find({ familyId: fid }).sort({ createdAt: -1 }).limit(40).lean<ActivityDoc[]>(),
                    AdminNote.find({ target: `family:${fid}` }).sort({ at: -1 }).limit(50).lean<IAdminNote[]>(),
                    SupportIssue.find({ familyId: fid }).sort({ createdAt: -1 }).limit(20).lean<ISupportIssue[]>(),
                    Promise.all(["message_in", "message_out", "reminder", "caregiver_alert", "voice_note"].map((k) => ActivityLog.countDocuments({ familyId: fid, kind: k, createdAt: { $gte: since } }))),
                    Order.countDocuments({ familyId: fid, createdAt: { $gte: since } }),
                    OutboundMessage.countDocuments({ familyId: fid, createdAt: { $gte: since }, deliveredAt: null }),
                ]);
                const perm = perms || {};
                return {
                    target: `family:${fid}`,
                    data: {
                        family: { familyId: fid, name: f.name || "Family", status: f.status || "ACTIVE", createdAt: iso(f.createdAt), createdBy: f.createdBy || null },
                        saheli: { brain: brainV2Mode(fid, flaggedEnv()), paused: isSaheliPaused(fid) },
                        members: f.members.map((m) => ({
                            ...maskedUser(people.get(m.userId)), userId: m.userId, role: m.role, memberStatus: m.status, joinedAt: iso(m.joinedAt),
                            voice: voice.find((v) => v.userId === m.userId)?.mode || "auto",
                        })),
                        companions: companions.map((c) => ({
                            userId: c.recipientUserId, enabled: c.enabled !== false, language: c.preferredLanguage || null,
                            lastInboundAt: iso(c.lastWhatsAppInboundAt),
                            windowOpen: !!c.lastWhatsAppInboundAt && Date.now() - new Date(c.lastWhatsAppInboundAt).getTime() < 24 * 3_600_000,
                            quietHours: c.quietHoursStart && c.quietHoursEnd ? `${c.quietHoursStart}–${c.quietHoursEnd}` : null, nudges: c.nudgeIntensity || null,
                        })),
                        permissions: Object.fromEntries(["medicines", "groceries", "food", "rides", "deliveryFollowUps", "medicineStartCheck", "resumeNudges", "spendSoftLimitInr"].map((k) => [k, perm[k] ?? null])),
                        connections: [...mcp.map((c) => ({ partner: c.partner, connectedAt: iso(c.connectedAt) })), ...zepto.map((c) => ({ partner: "zepto", connectedAt: iso(c.connectedAt) }))],
                        week: { messagesIn: counts[0], messagesOut: counts[1], reminders: counts[2], alerts: counts[3], voiceNotes: counts[4], orders: orders7, failedSends: failed7 },
                        activity: recent.map(safeActivity),
                        notes: notes.map((n) => ({ text: n.text, by: n.by, at: iso(n.at) })),
                        issues: issues.map((i) => ({ issueId: i.issueId, title: i.title, status: i.status, priority: i.priority, createdAt: iso(i.createdAt) })),
                    },
                };
            },
        },
        {
            method: "get", path: "/families/:familyId/activity", perm: "care.breakglass", action: "family.activity_full", reason: "required",
            handler: async ({ params, query }) => {
                const f = await familyOr404(params.familyId);
                const filter: Record<string, unknown> = { familyId: f.familyId };
                if (query.kind) filter.kind = query.kind;
                const rows = await ActivityLog.find(filter).sort({ createdAt: -1 }).limit(200).lean<ActivityDoc[]>();
                return { target: `family:${f.familyId}`, detail: { n: rows.length, kind: query.kind || null }, data: { activity: rows.map(fullActivity) } };
            },
        },
        {
            method: "get", path: "/families/:familyId/conversation", perm: "care.breakglass", action: "family.conversation", reason: "required",
            handler: async ({ params, query }) => {
                const f = await familyOr404(params.familyId);
                const userId = String(query.userId || "");
                if (!f.members.some((m) => m.userId === userId)) throw new AdminError(400, "bad_input", "pick a member of this family");
                const data = await engine<unknown>("GET", `/families/${encodeURIComponent(f.familyId)}/conversation?thread=${encodeURIComponent(userId)}&limit=80`);
                return { target: `family:${f.familyId}`, detail: { thread: `user:${userId}` }, data };
            },
        },
        {
            method: "get", path: "/families/:familyId/care-record", perm: "care.breakglass", action: "family.care_record", reason: "required",
            handler: async ({ params, query }) => {
                const f = await familyOr404(params.familyId);
                const userId = String(query.userId || "");
                if (!f.members.some((m) => m.userId === userId)) throw new AdminError(400, "bad_input", "pick a member of this family");
                const data = await engine<unknown>("GET", `/families/${encodeURIComponent(f.familyId)}/care-record?subject=${encodeURIComponent(userId)}`);
                return { target: `family:${f.familyId}`, detail: { subject: `user:${userId}` }, data };
            },
        },
        {
            method: "post", path: "/families/:familyId/pause", perm: "saheli.manage", action: "family.saheli_pause",
            handler: async ({ admin, params, body }) => {
                const f = await familyOr404(params.familyId);
                const input = z.object({ paused: z.boolean() }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input");
                await setListFlag("saheli.pausedFamilies", f.familyId, input.data.paused, admin.email, admin.reason);
                return { target: `family:${f.familyId}`, detail: { paused: input.data.paused }, data: { paused: input.data.paused, takesEffectWithinSeconds: 60 } };
            },
        },
        {
            method: "post", path: "/families/:familyId/brain", perm: "flags.manage", action: "family.brain_mode",
            handler: async ({ admin, params, body }) => {
                const f = await familyOr404(params.familyId);
                const input = z.object({ live: z.boolean() }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input");
                await setListFlag("brain.liveFamilies", f.familyId, input.data.live, admin.email, admin.reason);
                return { target: `family:${f.familyId}`, detail: { live: input.data.live }, data: { brain: brainV2Mode(f.familyId, flaggedEnv()) } };
            },
        },
        {
            method: "post", path: "/notes", perm: "users.manage", action: "note.add",
            handler: async ({ admin, body }) => {
                const input = z.object({ target: z.string().regex(/^(family|user):[\w-]{1,64}$/), text: z.string().trim().min(2).max(2000) }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input");
                const [kind, id] = input.data.target.split(":");
                const exists = kind === "family" ? await Family.exists({ familyId: id }) : await User.exists({ userId: id });
                if (!exists) throw new AdminError(404, "no_such_target");
                await AdminNote.create({ target: input.data.target, text: input.data.text, by: admin.email, at: new Date() });
                return { status: 201, target: input.data.target, data: { ok: true } };
            },
        },
    ];
}
