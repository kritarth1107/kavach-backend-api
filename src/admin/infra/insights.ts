/**
 * Admin insights (founder 21 Oct: "build everything"): cost per family, spend alerts, the growth funnel, families that
 * need attention, Saheli's quality over time, the outreach report and order health. The engine gives counts from the
 * conversation (no text); this joins them with families, sign-ups, WhatsApp delivery receipts and windows.
 */
import mongoose, { Schema } from "mongoose";
import { engineOrNull } from "../engine";
import Family from "../../models/family.model";
import MessageDelivery from "../../models/messageDelivery.model";
import { OnboardingDraft as Onboarding } from "../../models/onboarding.model";
import User from "../../models/users.model";
import WaitlistEntry from "../../models/waitlist.model";
import WhatsAppWindow from "../../models/whatsappWindow.model";
import { isSaheliPaused } from "../../services/featureFlags.service";
import { WINDOW_MS, phoneKey } from "../../services/whatsappWindow.service";
import { costAnalysis } from "./costs";
import { istDay } from "./pricing";

const DAY = 86_400_000;
const live = (fid: string) => !/^(sim-|shadow:|replay-|founder-|lab-|eval-|world-)/.test(fid);
type FamilyDoc = { familyId: string; name?: string; createdAt?: Date; members: Array<{ userId: string; role: string; status?: string }> };

async function families(): Promise<Map<string, FamilyDoc>> {
    const rows = await Family.find({}, { familyId: 1, name: 1, createdAt: 1, members: 1 }).lean<FamilyDoc[]>();
    return new Map(rows.filter((f) => live(f.familyId)).map((f) => [f.familyId, f]));
}

// ── 1. cost per family ────────────────────────────────────────────────────────────

type FamCost = { familyId: string; test: boolean; costInr: number; turns: number; perTurn: number; byKind: Record<string, { turns: number; costInr: number }>; daily: Record<string, number> };

export async function familyCosts(days = 30) {
    const [eng, fams] = await Promise.all([
        engineOrNull<{ families: FamCost[]; ledgerDaily: Record<string, number>; backgroundDaily: Record<string, number>; byRole: Record<string, { costInr: number; calls: number }>; note: string }>("GET", `/insights/family-costs?days=${days}`),
        families(),
    ]);
    if (!eng.data) return { error: eng.error || "engine did not answer", families: [] };
    const sent = await MessageDelivery.aggregate<{ _id: string; n: number; failed: number }>([
        { $match: { createdAt: { $gte: new Date(Date.now() - days * DAY) }, familyId: { $exists: true } } },
        { $group: { _id: "$familyId", n: { $sum: 1 }, failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } } } },
    ]);
    const msgs = new Map(sent.map((s) => [s._id, s]));
    const total = eng.data.families.reduce((t, f) => t + f.costInr, 0);
    return {
        days, note: eng.data.note, byRole: eng.data.byRole, ledgerDaily: eng.data.ledgerDaily, backgroundDaily: eng.data.backgroundDaily,
        tracedTotal: Math.round(total * 100) / 100,
        families: eng.data.families.map((f) => {
            const fam = fams.get(f.familyId);
            const m = msgs.get(f.familyId);
            const members = fam?.members.filter((x) => x.status !== "LEFT" && x.status !== "REMOVED").length ?? null;
            return { ...f, name: f.test ? "Tests and simulations" : fam?.name || "Family (not in the backend)", members,
                share: total ? Math.round((f.costInr / total) * 1000) / 10 : 0, perMemberDay: members ? Math.round((f.costInr / members / days) * 100) / 100 : null,
                whatsappSent: m?.n ?? 0, whatsappFailed: m?.failed ?? 0 };
        }),
    };
}

// ── 2. spend alerts ───────────────────────────────────────────────────────────────

const settingsSchema = new Schema({ key: { type: String, default: "spend" }, jumpPct: Number, minInr: Number, creditLowPct: Number, creditLowDays: Number,
    browserUseMinUsd: Number, email: Boolean, emailTo: String, by: String, at: Date }, { collection: "admin_spend_alert_settings", versionKey: false });
const alertSchema = new Schema({ key: { type: String, index: true, unique: true }, level: String, platform: String, text: String, value: Number, at: Date,
    dismissedAt: Date, dismissedBy: String, emailedAt: Date }, { collection: "admin_spend_alerts", versionKey: false });
const Settings = mongoose.models.AdminSpendAlertSettings || mongoose.model("AdminSpendAlertSettings", settingsSchema);
const Alert = mongoose.models.AdminSpendAlert || mongoose.model("AdminSpendAlert", alertSchema);

export type AlertSettings = { jumpPct: number; minInr: number; creditLowPct: number; creditLowDays: number; browserUseMinUsd: number; email: boolean; emailTo: string };
const DEFAULTS: AlertSettings = { jumpPct: 50, minInr: 500, creditLowPct: 15, creditLowDays: 14, browserUseMinUsd: 15, email: false, emailTo: "" };

export async function alertSettings(): Promise<AlertSettings> {
    const s = await Settings.findOne({ key: "spend" }).lean<Partial<AlertSettings>>();
    return { ...DEFAULTS, ...Object.fromEntries(Object.entries(s || {}).filter(([k, v]) => k in DEFAULTS && v != null)) } as AlertSettings;
}

export async function saveAlertSettings(s: Partial<AlertSettings>, by: string) {
    const clean: Partial<AlertSettings> = {};
    for (const k of ["jumpPct", "minInr", "creditLowPct", "creditLowDays", "browserUseMinUsd"] as const) if (s[k] != null && Number.isFinite(Number(s[k])) && Number(s[k]) >= 0) clean[k] = Number(s[k]);
    if (typeof s.email === "boolean") clean.email = s.email;
    if (typeof s.emailTo === "string") clean.emailTo = s.emailTo.trim().slice(0, 300);
    await Settings.updateOne({ key: "spend" }, { $set: { ...clean, key: "spend", by, at: new Date() } }, { upsert: true });
    return alertSettings();
}

export async function listAlerts(limit = 50) {
    return Alert.find({}).sort({ at: -1 }).limit(limit).lean();
}

export async function dismissAlert(key: string, by: string) {
    return (await Alert.updateOne({ key }, { $set: { dismissedAt: new Date(), dismissedBy: by } })).modifiedCount > 0;
}

/**
 * One pass: yesterday's spend per platform against the 7 days before it, every credit grant running low or out soon,
 * Browser Use's balance, and the model soft cap. Each alert is kept once (by key); email only when the team turned it on.
 */
export async function checkSpend(now = Date.now()) {
    const s = await alertSettings();
    const c = await costAnalysis(now);
    const yday = istDay(new Date(now - DAY));
    const prior = Array.from({ length: 7 }, (_, i) => istDay(new Date(now - (i + 2) * DAY)));
    const found: Array<{ key: string; level: "warn" | "info"; platform: string; text: string; value: number }> = [];
    const inr = (v: number) => `₹${Math.round(v).toLocaleString("en-IN")}`;
    for (const p of c.platforms) {
        if (p.unit || !p.connected) continue;
        const daily = (p as { grossDaily?: Record<string, number> }).grossDaily || {};
        const y = daily[yday] ?? 0;
        const avg = prior.reduce((t, d) => t + (daily[d] ?? 0), 0) / 7;
        if (y >= s.minInr && y > avg * (1 + s.jumpPct / 100)) {
            found.push({ key: `jump:${p.id}:${yday}`, level: "warn", platform: p.name, value: Math.round(y),
                text: `${p.name} spent ${inr(y)} yesterday, ${avg ? `${Math.round((y / avg - 1) * 100)}% above` : "against nothing on"} the 7-day average (${inr(avg)}).` });
        }
    }
    const tot = c.daily.find((x) => x.day === yday)?.gross ?? 0;
    const totAvg = prior.reduce((t, d) => t + (c.daily.find((x) => x.day === d)?.gross ?? 0), 0) / 7;
    if (tot >= s.minInr && tot > totAvg * (1 + s.jumpPct / 100)) {
        found.push({ key: `jump:all:${yday}`, level: "warn", platform: "All platforms", value: Math.round(tot), text: `Total spend yesterday was ${inr(tot)}, against a 7-day average of ${inr(totAvg)}.` });
    }
    for (const g of c.credits) {
        if (g.left != null && g.amountInr && g.left / g.amountInr * 100 <= s.creditLowPct) {
            found.push({ key: `credit-low:${g.grantId}:${Math.floor(g.left / g.amountInr * 20)}`, level: "warn", platform: g.provider, value: g.left,
                text: `${g.label}: ${inr(g.left)} left of ${inr(g.amountInr)} (${Math.round(g.left / g.amountInr * 100)}%).` });
        }
        if (g.daysLeft != null && g.daysLeft <= s.creditLowDays) {
            found.push({ key: `credit-days:${g.grantId}:${g.daysLeft <= 3 ? 3 : g.daysLeft <= 7 ? 7 : 14}`, level: "warn", platform: g.provider, value: g.daysLeft,
                text: `${g.label} runs out in about ${g.daysLeft} days at the current pace.` });
        }
        if (g.expiresInDays != null && g.expiresInDays <= s.creditLowDays && (g.left ?? 1) > 0) {
            found.push({ key: `credit-expiry:${g.grantId}:${g.expiresInDays <= 3 ? 3 : g.expiresInDays <= 7 ? 7 : 14}`, level: "info", platform: g.provider, value: g.expiresInDays,
                text: `${g.label} expires in ${g.expiresInDays} days${g.left != null ? ` with ${inr(g.left)} unused` : ""}.` });
        }
    }
    const bu = c.platforms.find((p) => p.id === "browser-use")?.groups[0]?.lines.find((l) => l.name === "Balance")?.detail?.[0]?.value.match(/\$([\d.]+)/);
    if (bu && Number(bu[1]) < s.browserUseMinUsd) {
        found.push({ key: `browser-use-low:${istDay(new Date(now))}`, level: "warn", platform: "Browser Use", value: Number(bu[1]),
            text: `Browser Use balance is $${bu[1]} (below $${s.browserUseMinUsd}). Orders and rides stop when it runs out.` });
    }
    const caps = c.models.caps;
    if (caps.today != null && caps.soft != null && caps.today >= caps.soft) {
        found.push({ key: `model-soft-cap:${istDay(new Date(now))}`, level: "warn", platform: "Models", value: caps.today,
            text: `Model spend today (${inr(caps.today)}) reached the soft cap (₹${caps.soft}): Saheli is on the cheapest models.` });
    }
    const fresh: typeof found = [];
    for (const a of found) {
        const r = await Alert.updateOne({ key: a.key }, { $setOnInsert: { ...a, at: new Date(now) } }, { upsert: true });
        if (r.upsertedCount) fresh.push(a);
    }
    if (fresh.length && s.email) {
        try {
            const { sendCareTeamAlert } = await import("../../services/email.service");
            if (s.emailTo) process.env.CARE_TEAM_ALERT_TO = s.emailTo;
            await sendCareTeamAlert(`Kavach spend: ${fresh.length} new alert${fresh.length > 1 ? "s" : ""}`, fresh.map((a) => `• ${a.text}`).join("\n"), "crisis");
            await Alert.updateMany({ key: { $in: fresh.map((a) => a.key) } }, { $set: { emailedAt: new Date() } });
        } catch (e) {
            console.error("spend alert email failed", (e as Error).message);
        }
    }
    return { checked: new Date(now).toISOString(), found: found.length, new: fresh.length };
}

/** The admin API is one task: an hourly pass in-process (the first a few minutes after start). Off with SPEND_ALERTS=off. */
export function startSpendAlerts() {
    if ((process.env.SPEND_ALERTS || "on") === "off") return;
    const run = () => checkSpend().catch((e) => console.error("spend alert check failed", (e as Error).message));
    setTimeout(run, 5 * 60_000);
    setInterval(run, 3 * 3_600_000);
}

// ── 3. growth funnel ──────────────────────────────────────────────────────────────

type Person = { familyId: string; personId: string; firstInAt: string | null; lastInAt: string | null; lastOutAt: string | null; activeDays: number; in7: number; in30: number; inAll: number; unansweredSinceLastReply: number };

export async function growth() {
    const [wl, users, onb, fams, eng] = await Promise.all([
        WaitlistEntry.find({}, { createdAt: 1, approvedAt: 1, registeredAt: 1, status: 1, source: 1 }).lean<Array<{ createdAt?: Date; approvedAt?: Date; registeredAt?: Date; status: string; source: string }>>(),
        User.find({}, { userId: 1, createdAt: 1, onboarding: 1, signupSource: 1 }).lean<Array<{ userId: string; createdAt?: Date; onboarding?: { status?: string; at?: Date }; signupSource?: string }>>(),
        (Onboarding as mongoose.Model<{ userId: string; completedAt?: Date | null }>).find({}, { userId: 1, completedAt: 1 }).lean<Array<{ userId: string; completedAt?: Date | null }>>(),
        families(),
        engineOrNull<{ people: Person[] }>("GET", "/insights/people?days=365"),
    ]);
    const liveUsers = new Set([...fams.values()].flatMap((f) => f.members.map((m) => m.userId)));
    const people = new Map((eng.data?.people || []).map((p) => [p.personId, p]));
    const done = new Map(onb.filter((o) => o.completedAt).map((o) => [o.userId, o.completedAt!]));
    const now = Date.now();
    const week = (d?: Date | string | null) => {
        if (!d) return null;
        const t = new Date(d); const day = (t.getUTCDay() + 6) % 7;
        return istDay(new Date(t.getTime() - day * DAY));
    };
    const signedUp = users.filter((u) => liveUsers.has(u.userId));
    const onboarded = signedUp.filter((u) => u.onboarding?.status === "done" || done.has(u.userId));
    const wrote = signedUp.filter((u) => people.get(u.userId)?.firstInAt);
    const active7 = signedUp.filter((u) => (people.get(u.userId)?.in7 ?? 0) > 0);
    const active30 = signedUp.filter((u) => (people.get(u.userId)?.in30 ?? 0) > 0);
    const funnel = [
        { step: "Asked to join (waitlist)", n: wl.length },
        { step: "Approved", n: wl.filter((w) => w.approvedAt).length },
        { step: "Signed up (in a family)", n: signedUp.length },
        { step: "Finished onboarding", n: onboarded.length },
        { step: "Wrote to Saheli", n: wrote.length },
        { step: "Active in the last 30 days", n: active30.length },
        { step: "Active in the last 7 days", n: active7.length },
    ];
    // weekly cohorts by sign-up week: who wrote, and who was still writing a week and a month later
    const cohorts: Record<string, { week: string; signedUp: number; onboarded: number; wrote: number; activeAfter7: number; activeAfter30: number; activeNow: number }> = {};
    for (const u of signedUp) {
        const w = week(u.createdAt);
        if (!w) continue;
        const c = (cohorts[w] ??= { week: w, signedUp: 0, onboarded: 0, wrote: 0, activeAfter7: 0, activeAfter30: 0, activeNow: 0 });
        const p = people.get(u.userId);
        c.signedUp++;
        if (u.onboarding?.status === "done" || done.has(u.userId)) c.onboarded++;
        if (p?.firstInAt) c.wrote++;
        const created = new Date(u.createdAt!).getTime();
        if (p?.lastInAt && new Date(p.lastInAt).getTime() >= created + 7 * DAY) c.activeAfter7++;
        if (p?.lastInAt && new Date(p.lastInAt).getTime() >= created + 30 * DAY) c.activeAfter30++;
        if ((p?.in7 ?? 0) > 0) c.activeNow++;
    }
    const daily: Record<string, { day: string; asked: number; signedUp: number; firstMessage: number }> = {};
    const bump = (d: Date | string | null | undefined, k: "asked" | "signedUp" | "firstMessage") => {
        if (!d || now - new Date(d).getTime() > 60 * DAY) return;
        const day = istDay(new Date(d));
        (daily[day] ??= { day, asked: 0, signedUp: 0, firstMessage: 0 })[k]++;
    };
    wl.forEach((w) => bump(w.createdAt, "asked"));
    signedUp.forEach((u) => bump(u.createdAt, "signedUp"));
    wrote.forEach((u) => bump(people.get(u.userId)?.firstInAt, "firstMessage"));
    const timeTo = (pairs: Array<[Date | string | null | undefined, Date | string | null | undefined]>) => {
        const v = pairs.filter(([a, b]) => a && b).map(([a, b]) => (new Date(b!).getTime() - new Date(a!).getTime()) / 3_600_000).filter((h) => h >= 0).sort((a, b) => a - b);
        return v.length ? Math.round(v[Math.floor(v.length / 2)] * 10) / 10 : null;
    };
    return {
        funnel, cohorts: Object.values(cohorts).sort((a, b) => b.week.localeCompare(a.week)), daily: Object.values(daily).sort((a, b) => a.day.localeCompare(b.day)),
        families: { total: fams.size, withActivity7: new Set(active7.map((u) => [...fams.values()].find((f) => f.members.some((m) => m.userId === u.userId))?.familyId)).size },
        medianHours: {
            askToApprove: timeTo(wl.map((w) => [w.createdAt, w.approvedAt])),
            approveToSignUp: timeTo(wl.map((w) => [w.approvedAt, w.registeredAt])),
            signUpToFirstMessage: timeTo(signedUp.map((u) => [u.createdAt, people.get(u.userId)?.firstInAt])),
        },
        sources: { waitlistDashboard: wl.filter((w) => w.source === "dashboard").length, waitlistWhatsapp: wl.filter((w) => w.source === "whatsapp").length,
            signedUpByWhatsapp: signedUp.filter((u) => u.signupSource === "whatsapp").length },
        engineError: eng.error || null,
    };
}

// ── 4. families needing attention ─────────────────────────────────────────────────

export async function attention() {
    const [fams, eng] = await Promise.all([families(), engineOrNull<{ people: Person[]; briefs: Record<string, { sent7: number; lastAt: string | null }> }>("GET", "/insights/people?days=60")]);
    const userIds = [...fams.values()].flatMap((f) => f.members.map((m) => m.userId));
    const [users, deliveries] = await Promise.all([
        User.find({ userId: { $in: userIds } }, { userId: 1, firstName: 1, lastName: 1, phone: 1 }).lean<Array<{ userId: string; firstName?: string; lastName?: string; phone?: string }>>(),
        MessageDelivery.aggregate<{ _id: { u: string; k: string }; sent: number; read: number; failed: number }>([
            { $match: { createdAt: { $gte: new Date(Date.now() - 7 * DAY) }, toUserId: { $in: userIds } } },
            { $group: { _id: { u: "$toUserId", k: "$kind" }, sent: { $sum: 1 }, read: { $sum: { $cond: [{ $ifNull: ["$readAt", false] }, 1, 0] } },
                failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } } } },
        ]),
    ]);
    const byUser = new Map(users.map((u) => [u.userId, u]));
    const windows = await WhatsAppWindow.find({ phone: { $in: users.map((u) => phoneKey(u.phone || "")).filter((p) => p.length >= 8) } }).lean<Array<{ phone: string; lastInboundAt?: Date; closedAt?: Date }>>();
    const win = new Map(windows.map((w) => [w.phone, w]));
    const people = new Map((eng.data?.people || []).map((p) => [`${p.familyId}|${p.personId}`, p]));
    const del = new Map<string, { sent: number; read: number; failed: number; briefSent: number; briefRead: number }>();
    for (const d of deliveries) {
        const x = del.get(d._id.u) || { sent: 0, read: 0, failed: 0, briefSent: 0, briefRead: 0 };
        x.sent += d.sent; x.read += d.read; x.failed += d.failed;
        if (d._id.k === "brief") { x.briefSent += d.sent; x.briefRead += d.read; }
        del.set(d._id.u, x);
    }
    const now = Date.now();
    const initial = (u?: { firstName?: string; lastName?: string }) => (u?.firstName ? `${u.firstName}${u.lastName ? ` ${u.lastName[0]}.` : ""}` : "Member");
    const out = [];
    for (const f of fams.values()) {
        const flags: Array<{ level: "high" | "medium" | "low"; text: string; person?: string }> = [];
        const membersOut = [];
        for (const m of f.members.filter((x) => x.status !== "LEFT" && x.status !== "REMOVED")) {
            const u = byUser.get(m.userId);
            const p = people.get(`${f.familyId}|${m.userId}`);
            const w = win.get(phoneKey(u?.phone || ""));
            const last = p?.lastInAt ? new Date(p.lastInAt).getTime() : w?.lastInboundAt ? new Date(w.lastInboundAt).getTime() : 0;
            const silentDays = last ? Math.floor((now - last) / DAY) : null;
            const open = !!last && now - last < WINDOW_MS && !(w?.closedAt && new Date(w.closedAt).getTime() >= last);
            const d = del.get(m.userId);
            const name = initial(u);
            const elder = m.role === "CARE_RECIPIENT";
            if (elder && (silentDays == null || silentDays >= 2)) flags.push({ level: silentDays == null || silentDays >= 4 ? "high" : "medium", person: name, text: silentDays == null ? `${name} has never written to Saheli` : `${name} hasn't written in ${silentDays} days` });
            if ((p?.unansweredSinceLastReply ?? 0) >= 3) flags.push({ level: p!.unansweredSinceLastReply >= 5 ? "high" : "medium", person: name, text: `${p!.unansweredSinceLastReply} messages from Saheli since ${name}'s last reply` });
            if (elder && !open) flags.push({ level: "low", person: name, text: `WhatsApp window closed for ${name} (only templates reach them)` });
            if (d && d.failed >= 2) flags.push({ level: d.failed >= 5 ? "high" : "medium", person: name, text: `${d.failed} messages to ${name} failed in 7 days` });
            if (!elder && d && d.briefSent >= 3 && d.briefRead === 0) flags.push({ level: "low", person: name, text: `${name} hasn't read any of ${d.briefSent} nightly briefs this week` });
            membersOut.push({ userId: m.userId, name, role: m.role, lastInAt: last ? new Date(last).toISOString() : null, silentDays, windowOpen: open,
                in7: p?.in7 ?? 0, unanswered: p?.unansweredSinceLastReply ?? 0, sent7: d?.sent ?? 0, read7: d?.read ?? 0, failed7: d?.failed ?? 0, briefs7: d?.briefSent ?? 0, briefsRead7: d?.briefRead ?? 0 });
        }
        const paused = isSaheliPaused(f.familyId);
        if (paused) flags.push({ level: "low", text: "Saheli is paused for this family" });
        const brief = eng.data?.briefs?.[f.familyId];
        if (!brief && f.members.some((m) => m.role === "PRIMARY_CAREGIVER")) flags.push({ level: "low", text: "No nightly brief sent this week" });
        const score = flags.reduce((t, x) => t + (x.level === "high" ? 5 : x.level === "medium" ? 2 : 1), 0);
        out.push({ familyId: f.familyId, name: f.name || "Family", score, flags, members: membersOut, paused, briefs7: brief?.sent7 ?? 0 });
    }
    return { families: out.sort((a, b) => b.score - a.score), engineError: eng.error || null };
}

// ── 5–7. quality, outreach, orders (engine) + delivery receipts ─────────────────────

export async function quality(days = 30) {
    const [q, fams] = await Promise.all([engineOrNull<Record<string, unknown> & { familiesWithMostFailures: Array<[string, number]> }>("GET", `/insights/quality?days=${days}`), families()]);
    if (!q.data) return { error: q.error || "engine did not answer" };
    return { ...q.data, familiesWithMostFailures: q.data.familiesWithMostFailures.map(([fid, n]) => ({ familyId: fid, name: fams.get(fid)?.name || fid.slice(0, 8), failures: n })) };
}

export async function outreach(days = 14) {
    const [o, rows] = await Promise.all([
        engineOrNull<Record<string, unknown>>("GET", `/insights/outreach?days=${days}`),
        MessageDelivery.aggregate<{ _id: { k: string; s: string; t: boolean }; n: number }>([
            { $match: { createdAt: { $gte: new Date(Date.now() - days * DAY) } } },
            { $group: { _id: { k: "$kind", s: "$status", t: { $ifNull: ["$viaTemplate", false] } }, n: { $sum: 1 } } },
        ]),
    ]);
    const errors = await MessageDelivery.aggregate<{ _id: string; n: number }>([
        { $match: { createdAt: { $gte: new Date(Date.now() - days * DAY) }, status: "failed" } },
        { $group: { _id: { $ifNull: ["$errorTitle", "unknown"] }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 },
    ]);
    const kinds: Record<string, { kind: string; sent: number; delivered: number; read: number; failed: number; template: number }> = {};
    for (const r of rows) {
        const k = (kinds[r._id.k] ??= { kind: r._id.k, sent: 0, delivered: 0, read: 0, failed: 0, template: 0 });
        k.sent += r.n;
        if (r._id.s === "delivered") k.delivered += r.n;
        if (r._id.s === "read") { k.read += r.n; k.delivered += r.n; }
        if (r._id.s === "failed") k.failed += r.n;
        if (r._id.t) k.template += r.n;
    }
    return { days, engine: o.data, engineError: o.error || null, whatsapp: Object.values(kinds).sort((a, b) => b.sent - a.sent), whatsappErrors: errors.map((e) => ({ error: e._id, n: e.n })) };
}

export async function orders(days = 60) {
    const o = await engineOrNull<Record<string, unknown>>("GET", `/insights/orders?days=${days}`);
    let browser: { perRunUsd: number | null; runs: number } = { perRunUsd: null, runs: 0 };
    try {
        const { browserUseHistory } = await import("./vendors");
        const h = await browserUseHistory();
        const usd = Object.values(h.daily).reduce((t, x) => t + x.taskUsd + x.proxyUsd, 0);
        browser = { perRunUsd: h.tasks ? Math.round((usd / h.tasks) * 1000) / 1000 : null, runs: h.tasks };
    } catch { /* no Browser Use key */ }
    return { ...(o.data || {}), engineError: o.error || null, browser };
}
