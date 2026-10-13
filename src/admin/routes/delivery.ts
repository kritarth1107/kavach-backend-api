/**
 * The admin "Delivery" page (trust plan B1.6; founder D6: the daily due-vs-sent report goes to the Kavach team email and
 * here): today's due list as it stands, the saved 23:30 reports, the dose alerts the team got, and the ledger's own
 * health (sends with a wamid, with a receipt). Escalations on time (B2.5) come from /delivery/escalations.
 * Counts and masked names only: what a slot was for (a medicine's name) stays in the team email and the break-glass views.
 */
import type { RouteDef } from "../router";
import { maskName } from "../mask";
import { daysAgo, iso } from "./shared";
import DeliveryReport from "../../models/deliveryReport.model";
import DueSlot, { type IDueSlot } from "../../models/dueSlot.model";
import OpsAlertLog from "../../models/opsAlertLog.model";
import { EscalationCheck } from "../../models/escalation.model";

const IST = 330 * 60_000;
const dayKey = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** A report's people and items with names masked and medicines left out. */
function masked<T extends { people?: string[]; person?: string; medicine?: string }>(row: T): T {
    const out: T = { ...row };
    if (out.people) out.people = out.people.map((p) => maskName(p) || "someone");
    if (out.person) out.person = maskName(out.person) || "someone";
    if ("medicine" in out) out.medicine = "a medicine";
    return out;
}

export function deliveryRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/delivery", perm: "users.read", action: "delivery.read",
            handler: async ({ query }) => {
                const day = isDay(query.day) ? query.day! : dayKey(new Date());
                const { buildDeliveryReport } = await import("../../services/deliveryReport.service");
                const [report, saved, slots, alerts] = await Promise.all([
                    buildDeliveryReport(day, new Date(), { readOnly: true }),
                    DeliveryReport.findOne({ dateKey: day }, { emailedAt: 1, emailError: 1, builtAt: 1 }).lean<{ emailedAt?: Date; emailError?: string; builtAt?: Date }>(),
                    DueSlot.find({ dateKey: day, test: { $ne: true } }).sort({ dueAt: 1 }).limit(2000).lean<IDueSlot[]>(),
                    OpsAlertLog.find({ at: { $gte: new Date(`${day}T00:00:00+05:30`), $lt: new Date(new Date(`${day}T00:00:00+05:30`).getTime() + 86_400_000) } })
                        .sort({ at: -1 }).limit(50).lean<Array<{ kind: string; subject: string; items: Array<Record<string, unknown>>; emailed: boolean; at: Date }>>(),
                ]);
                return {
                    detail: { day, slots: slots.length },
                    data: {
                        day,
                        report: { ...report, families: report.families.map(masked), notDelivered: report.notDelivered.map(masked) },
                        saved: saved ? { builtAt: iso(saved.builtAt), emailedAt: iso(saved.emailedAt), emailError: saved.emailError ?? null } : null,
                        slots: slots.map((s) => ({
                            family: s.familyId.slice(0, 8), kind: s.kind, medicine: s.medicine, critical: !!s.critical, time: s.time, dueAt: iso(s.dueAt),
                            state: s.state, reason: s.reason ?? null, attempts: s.attempts ?? 0, sentAt: iso(s.sentAt), deliveredAt: iso(s.deliveredAt),
                            readAt: iso(s.readAt), alerted: !!s.alertedAt, alertReason: s.alertReason ?? null,
                        })),
                        alerts: alerts.map((a) => ({ kind: a.kind, subject: a.kind === "dose" ? `${a.items.length} dose slot(s)` : a.subject, emailed: a.emailed, at: iso(a.at),
                            items: a.items.map((i) => masked(i as { person?: string; medicine?: string })) })),
                    },
                };
            },
        },
        {
            // B2.5b: the 09:00 check of each day, "escalations on time: x/y" with every case
            method: "get", path: "/delivery/escalations", perm: "users.read", action: "delivery.escalations",
            handler: async ({ query }) => {
                const days = Math.min(Math.max(Number(query.days) || 14, 1), 90);
                const rows = await EscalationCheck.find({ checkedAt: { $gte: daysAgo(days + 1) } }).sort({ dateKey: -1 }).limit(days)
                    .lean<Array<{ dateKey: string; onTime: number; total: number; cases: Array<{ family: string; person: string; thirdAt: Date; outcome: string;
                        reason?: string; alertAt?: Date; onTime: boolean }> }>>();
                return {
                    detail: { days, n: rows.length },
                    data: {
                        days: rows.map((r) => ({ day: r.dateKey, onTime: r.onTime, total: r.total, misses: r.total - r.onTime })),
                        cases: rows.flatMap((r) => r.cases.map((c) => ({ day: r.dateKey, family: c.family, person: maskName(c.person) || "someone",
                            thirdAt: iso(c.thirdAt), outcome: c.outcome, reason: c.reason ?? null, alertAt: iso(c.alertAt), onTime: c.onTime }))),
                    },
                };
            },
        },
        {
            method: "get", path: "/delivery/reports", perm: "overview.read", action: "delivery.reports",
            handler: async ({ query }) => {
                const days = Math.min(Math.max(Number(query.days) || 14, 1), 90);
                const rows = await DeliveryReport.find({ builtAt: { $gte: daysAgo(days) } }, { dateKey: 1, totals: 1, ledger: 1, emailedAt: 1, emailError: 1, notDelivered: 1 })
                    .sort({ dateKey: -1 }).limit(days).lean<Array<{ dateKey: string; totals: Record<string, unknown>; ledger?: Record<string, number>; emailedAt?: Date; emailError?: string; notDelivered?: unknown[] }>>();
                return {
                    detail: { days, n: rows.length },
                    data: {
                        reports: rows.map((r) => ({ day: r.dateKey, totals: r.totals, ledger: r.ledger ?? null, emailedAt: iso(r.emailedAt), emailError: r.emailError ?? null,
                            notDelivered: (r.notDelivered ?? []).length })),
                    },
                };
            },
        },
    ];
}
