/** Overview numbers, system health, messaging, alerts, reminders, orders, tasks, rides. Aggregates and masked rows. */
import { engineOrNull } from "../engine";
import type { RouteDef } from "../router";
import ActivityLog from "../../models/activityLog.model";
import CareScheduleCompletion from "../../models/careScheduleCompletion.model";
import Family from "../../models/family.model";
import OlaRide from "../../models/olaRide.model";
import Order from "../../models/order.model";
import OutboundMessage from "../../models/outboundMessage.model";
import SaheliTask from "../../models/saheliTask.model";
import SchedulerHeartbeat from "../../models/schedulerHeartbeat.model";
import User from "../../models/users.model";
import { flagsLoadedAt } from "../../services/featureFlags.service";
import { can } from "../permissions";
import { daysAgo, iso, maskedUser, PAGE, pageOf, safeActivity, usersById, type ActivityDoc } from "./shared";

const IST = 330 * 60_000;
const dayKey = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
function lastDays(n: number): string[] {
    return Array.from({ length: n }, (_, i) => dayKey(daysAgo(n - 1 - i)));
}

type Spend = { today: number; softCap: number; hardCap: number; rows: Array<{ day?: string; role?: string; model?: string; costInr?: number; calls?: number }> };

export function opsRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/overview", perm: "overview.read", action: "overview.read",
            handler: async ({ admin }) => {
                const people = can(admin.role, "users.read"); // analysts get numbers only, never a named family
                const d7 = daysAgo(7), d14 = daysAgo(14), d1 = daysAgo(1);
                const [users, users7, families, families7, act, orders7, ordersPrev, failed7, sent7, completions, spend] = await Promise.all([
                    User.countDocuments({ status: { $ne: "DELETED" } }),
                    User.countDocuments({ createdAt: { $gte: d7 } }),
                    Family.countDocuments({}),
                    Family.countDocuments({ createdAt: { $gte: d7 } }),
                    ActivityLog.find({ createdAt: { $gte: d14 }, kind: { $in: ["message_in", "message_out", "caregiver_alert", "reminder", "order_placed", "voice_note"] } },
                        { kind: 1, createdAt: 1, familyId: 1, severity: 1, "data.kind": 1, "data.whatsapp": 1, title: 1 }).sort({ createdAt: -1 }).limit(20_000).lean<ActivityDoc[]>(),
                    Order.countDocuments({ createdAt: { $gte: d7 } }),
                    Order.countDocuments({ createdAt: { $gte: d14, $lt: d7 } }),
                    OutboundMessage.countDocuments({ createdAt: { $gte: d7 }, deliveredAt: null }),
                    OutboundMessage.countDocuments({ createdAt: { $gte: d7 } }),
                    CareScheduleCompletion.find({ updatedAt: { $gte: d7 } }, { status: 1 }).sort({ updatedAt: -1 }).limit(10_000).lean<Array<{ status: string }>>(),
                    engineOrNull<Spend>("GET", "/spend?days=14"),
                ]);
                const days = lastDays(14);
                const series = days.map((day) => ({ day, messagesIn: 0, messagesOut: 0, alerts: 0, reminders: 0, orders: 0 }));
                const byDay = new Map(series.map((s) => [s.day, s]));
                const active7 = new Set<string>(), activePrev = new Set<string>(), active1 = new Set<string>();
                let alerts7 = 0, alertsWhatsApp7 = 0, reminders7 = 0, remindersFailed7 = 0, voice7 = 0, msgs7 = 0, msgsPrev = 0;
                for (const a of act) {
                    const at = new Date(a.createdAt!);
                    const row = byDay.get(dayKey(at));
                    const recent = at >= d7;
                    if (a.kind === "message_in") {
                        if (row) row.messagesIn++;
                        (recent ? active7 : activePrev).add(a.familyId);
                        if (at >= d1) active1.add(a.familyId);
                        recent ? msgs7++ : msgsPrev++;
                    } else if (a.kind === "message_out") { if (row) row.messagesOut++; }
                    else if (a.kind === "caregiver_alert") { if (row) row.alerts++; if (recent) { alerts7++; if (a.data?.whatsapp === true) alertsWhatsApp7++; } }
                    else if (a.kind === "reminder") { if (row) row.reminders++; if (recent) { reminders7++; if (/not delivered|not sent/i.test(a.title)) remindersFailed7++; } }
                    else if (a.kind === "order_placed") { if (row) row.orders++; }
                    else if (a.kind === "voice_note" && recent) voice7++;
                }
                const taken = completions.filter((c) => c.status === "completed").length;
                const missed = completions.filter((c) => c.status === "missed").length;
                const recentAlerts = act.filter((a) => a.kind === "caregiver_alert").sort((a, b) => +new Date(b.createdAt!) - +new Date(a.createdAt!)).slice(0, 6);
                const fams = await Family.find({ familyId: { $in: [...new Set(recentAlerts.map((a) => a.familyId))] } }, { familyId: 1, name: 1 }).lean<Array<{ familyId: string; name?: string }>>();
                return {
                    data: {
                        kpis: {
                            users, users7, families, families7, activeFamilies7: active7.size, activeFamiliesPrev: activePrev.size, activeToday: active1.size,
                            messages7: msgs7, messagesPrev: msgsPrev, voiceNotes7: voice7, alerts7, alertsWhatsApp7, reminders7, remindersFailed7,
                            doses7: { taken, missed }, orders7, ordersPrev, failedSends7: failed7, sends7: sent7,
                        },
                        series,
                        spend: spend.data ? { today: spend.data.today, softCap: spend.data.softCap, hardCap: spend.data.hardCap, byDay: days.map((day) => ({ day, inr: Math.round((spend.data!.rows || []).filter((r) => r.day === day).reduce((s, r) => s + (r.costInr || 0), 0) * 100) / 100 })) } : null,
                        spendError: spend.error || null,
                        recentAlerts: people ? recentAlerts.map((a) => ({ ...safeActivity(a), family: fams.find((f) => f.familyId === a.familyId)?.name || "Family" })) : [],
                    },
                };
            },
        },
        {
            method: "get", path: "/system", perm: "system.read", action: "system.read",
            handler: async () => {
                const [hb, engineHealth, backendHealth] = await Promise.all([
                    SchedulerHeartbeat.find({}).lean<Array<{ _id?: unknown; lastTickAt: Date; gaps: Array<{ from: Date; to: Date }> }>>(),
                    engineOrNull<{ status: string; llm?: string; embeddings?: string; lastDream?: string | null; families?: number; backup?: { day: string; ok: boolean; finishedAt: string | null; bytes?: number; families?: number } | null }>("GET", "/health"),
                    (async () => {
                        const url = process.env.BACKEND_URL;
                        if (!url) return null;
                        try {
                            const r = await fetch(`${url.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(8000) });
                            return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
                        } catch {
                            return { ok: false, status: 0, body: {} };
                        }
                    })(),
                ]);
                return {
                    data: {
                        backend: backendHealth ? { ok: backendHealth.ok, status: backendHealth.status, uptimeSeconds: (backendHealth.body.service as { uptimeSeconds?: number } | undefined)?.uptimeSeconds ?? null } : null,
                        engine: engineHealth.data, engineError: engineHealth.error || null,
                        reminderTick: hb.map((h) => ({ name: String(h._id ?? "reminders"), lastTickAt: iso(h.lastTickAt), healthy: Date.now() - new Date(h.lastTickAt).getTime() < 3 * 60_000, gaps: (h.gaps || []).slice(-10).map((g) => ({ from: iso(g.from), to: iso(g.to) })) })),
                        flagsLoadedAt: flagsLoadedAt() ? new Date(flagsLoadedAt()).toISOString() : null,
                        adminApi: { revision: process.env.K_REVISION || "local", startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() },
                    },
                };
            },
        },
        {
            method: "get", path: "/messages", perm: "users.read", action: "messages.list",
            handler: async ({ query }) => {
                const page = pageOf(query);
                const filter: Record<string, unknown> = { createdAt: { $gte: daysAgo(Math.min(Number(query.days) || 7, 90)) } };
                if (query.status === "failed") filter.deliveredAt = null;
                if (query.channel) filter.channel = query.channel;
                if (query.familyId) filter.familyId = query.familyId;
                const [rows, total, failed] = await Promise.all([
                    OutboundMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean<Array<{ messageId: string; familyId: string; recipientUserId: string; channel: string; deliveredAt?: Date; createdAt?: Date; content?: string }>>(),
                    OutboundMessage.countDocuments(filter),
                    OutboundMessage.countDocuments({ ...filter, deliveredAt: null }),
                ]);
                const people = await usersById(rows.map((r) => r.recipientUserId));
                const fams = await Family.find({ familyId: { $in: [...new Set(rows.map((r) => r.familyId))] } }, { familyId: 1, name: 1 }).lean<Array<{ familyId: string; name?: string }>>();
                return {
                    detail: { page, n: rows.length, status: query.status || "all" },
                    data: {
                        total, failed, page, pageSize: PAGE,
                        messages: rows.map((r) => ({
                            messageId: r.messageId, at: iso(r.createdAt), familyId: r.familyId, family: fams.find((f) => f.familyId === r.familyId)?.name || "Family",
                            recipient: maskedUser(people.get(r.recipientUserId))?.name || "Someone", channel: r.channel, delivered: !!r.deliveredAt, length: (r.content || "").length,
                        })),
                    },
                };
            },
        },
        {
            method: "get", path: "/alerts", perm: "users.read", action: "alerts.list",
            handler: async ({ query }) => {
                const page = pageOf(query);
                const filter: Record<string, unknown> = { kind: "caregiver_alert", createdAt: { $gte: daysAgo(Math.min(Number(query.days) || 30, 120)) } };
                if (query.severity) filter.severity = query.severity;
                const [rows, total] = await Promise.all([
                    ActivityLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean<ActivityDoc[]>(),
                    ActivityLog.countDocuments(filter),
                ]);
                const fams = await Family.find({ familyId: { $in: [...new Set(rows.map((r) => r.familyId))] } }, { familyId: 1, name: 1 }).lean<Array<{ familyId: string; name?: string }>>();
                return { detail: { page, n: rows.length }, data: { total, page, pageSize: PAGE, alerts: rows.map((a) => ({ ...safeActivity(a), family: fams.find((f) => f.familyId === a.familyId)?.name || "Family" })) } };
            },
        },
        {
            method: "get", path: "/reminders", perm: "users.read", action: "reminders.summary",
            handler: async () => {
                const days = lastDays(14);
                const [rows, completions] = await Promise.all([
                    ActivityLog.find({ kind: "reminder", createdAt: { $gte: daysAgo(14) } }, { title: 1, createdAt: 1 }).sort({ createdAt: -1 }).limit(20_000).lean<ActivityDoc[]>(),
                    CareScheduleCompletion.find({ dateKey: { $in: days } }, { status: 1, dateKey: 1 }).limit(20_000).lean<Array<{ status: string; dateKey: string }>>(),
                ]);
                const series = days.map((day) => {
                    const r = rows.filter((x) => dayKey(new Date(x.createdAt!)) === day);
                    const c = completions.filter((x) => x.dateKey === day);
                    return {
                        day, sent: r.filter((x) => !/not delivered|not sent/i.test(x.title)).length, failed: r.filter((x) => /not delivered|not sent/i.test(x.title)).length,
                        taken: c.filter((x) => x.status === "completed").length, missed: c.filter((x) => x.status === "missed").length,
                    };
                });
                return { data: { series } };
            },
        },
        {
            method: "get", path: "/orders", perm: "users.read", action: "orders.list",
            handler: async ({ query }) => {
                const page = pageOf(query);
                const filter: Record<string, unknown> = {};
                if (query.status) filter.status = query.status;
                if (query.partner) filter.partner = query.partner;
                if (query.familyId) filter.familyId = query.familyId;
                const [rows, total, byStatus] = await Promise.all([
                    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean<Array<{ orderId: string; familyId: string; partner?: string; status: string; totalPaise?: number; items?: unknown[]; createdAt?: Date; updatedAt?: Date }>>(),
                    Order.countDocuments(filter),
                    Order.find({ createdAt: { $gte: daysAgo(30) } }, { status: 1, totalPaise: 1 }).limit(20_000).lean<Array<{ status: string; totalPaise?: number }>>(),
                ]);
                const fams = await Family.find({ familyId: { $in: [...new Set(rows.map((r) => r.familyId))] } }, { familyId: 1, name: 1 }).lean<Array<{ familyId: string; name?: string }>>();
                const statusCounts: Record<string, number> = {};
                let gmv = 0;
                for (const o of byStatus) { statusCounts[o.status] = (statusCounts[o.status] || 0) + 1; gmv += o.totalPaise || 0; }
                return {
                    detail: { page, n: rows.length },
                    data: {
                        total, page, pageSize: PAGE, statusCounts, gmv30Inr: Math.round(gmv / 100),
                        orders: rows.map((o) => ({ orderId: o.orderId, at: iso(o.createdAt), updatedAt: iso(o.updatedAt), familyId: o.familyId, family: fams.find((f) => f.familyId === o.familyId)?.name || "Family", partner: o.partner || null, status: o.status, totalInr: o.totalPaise != null ? Math.round(o.totalPaise / 100) : null, items: Array.isArray(o.items) ? o.items.length : 0 })),
                    },
                };
            },
        },
        {
            method: "get", path: "/tasks", perm: "users.read", action: "tasks.list",
            handler: async ({ query }) => {
                const open = query.state !== "all";
                const filter: Record<string, unknown> = open ? { resolvedAt: null } : {};
                const rows = await SaheliTask.find(filter).sort({ lastActiveAt: -1 }).limit(100).lean<Array<{ taskId: string; familyId: string; kind?: string; category?: string; status: string; stage?: string; partner?: string; createdAt?: Date; lastActiveAt?: Date; askCount?: number; isMedicine?: boolean }>>();
                const fams = await Family.find({ familyId: { $in: [...new Set(rows.map((r) => r.familyId))] } }, { familyId: 1, name: 1 }).lean<Array<{ familyId: string; name?: string }>>();
                return {
                    detail: { n: rows.length },
                    data: {
                        tasks: rows.map((t) => ({
                            taskId: t.taskId, familyId: t.familyId, family: fams.find((f) => f.familyId === t.familyId)?.name || "Family", kind: t.kind || t.category || null,
                            status: t.status, stage: t.stage || null, partner: t.partner || null, createdAt: iso(t.createdAt), lastActiveAt: iso(t.lastActiveAt), asks: t.askCount || 0,
                            stale: !!t.lastActiveAt && Date.now() - new Date(t.lastActiveAt).getTime() > 24 * 3_600_000,
                        })),
                    },
                };
            },
        },
        {
            method: "get", path: "/rides", perm: "users.read", action: "rides.list",
            handler: async () => {
                const rows = await OlaRide.find({}).sort({ bookedAt: -1 }).limit(50).lean<Array<{ rideId: string; familyId: string; status: string; bookedAt?: Date; endedAt?: Date; fake?: boolean; fare?: unknown; cancelReason?: string }>>();
                return { detail: { n: rows.length }, data: { rides: rows.map((r) => ({ rideId: r.rideId, familyId: r.familyId, status: r.status, bookedAt: iso(r.bookedAt), endedAt: iso(r.endedAt), test: !!r.fake, cancelReason: r.cancelReason || null })) } };
            },
        },
    ];
}

