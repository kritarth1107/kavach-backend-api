/** Support issues, and users' data requests (export / erasure) with their legal due dates. */
import { randomUUID } from "crypto";
import { z } from "zod";
import { AdminError } from "../auth";
import { engineOrNull } from "../engine";
import {
    DATA_REQUEST_STATUSES, DATA_REQUEST_TYPES, DataRequest, ISSUE_PRIORITIES, ISSUE_STATUSES, SupportIssue,
    type IDataRequest, type ISupportIssue,
} from "../models";
import type { RouteDef } from "../router";
import ActivityLog from "../../models/activityLog.model";
import CareSchedule from "../../models/careSchedule.model";
import CareScheduleCompletion from "../../models/careScheduleCompletion.model";
import ElderProfile from "../../models/elderProfile.model";
import Family from "../../models/family.model";
import Notification from "../../models/notification.model";
import Order from "../../models/order.model";
import SaheliCompanion from "../../models/saheliCompanion.model";
import SaheliMessage from "../../models/saheliMessage.model";
import SaheliReminder from "../../models/saheliReminder.model";
import Session from "../../models/session.model";
import User from "../../models/users.model";
import VoicePreference from "../../models/voicePreference.model";
import { iso, PAGE, pageOf } from "./shared";

const issueOut = (i: ISupportIssue) => ({
    issueId: i.issueId, title: i.title, body: i.body ?? null, familyId: i.familyId ?? null, userId: i.userId ?? null, area: i.area ?? null,
    status: i.status, priority: i.priority, assignee: i.assignee ?? null, createdBy: i.createdBy, createdAt: iso(i.createdAt), updatedAt: iso(i.updatedAt),
    log: (i.log || []).map((l) => ({ at: iso(l.at), by: l.by, text: l.text })),
});
const requestOut = (r: IDataRequest) => ({
    requestId: r.requestId, type: r.type, userId: r.userId, status: r.status, receivedAt: iso(r.receivedAt), dueAt: iso(r.dueAt),
    overdue: r.status !== "done" && r.status !== "rejected" && new Date(r.dueAt) < new Date(), note: r.note ?? null, createdBy: r.createdBy,
    log: (r.log || []).map((l) => ({ at: iso(l.at), by: l.by, text: l.text })),
});

/** Secrets never leave, even in a user's own export. */
const SECRET_FIELDS = new Set(["passwordHash", "tokenHash", "tokensEnc", "clientInfoEnc", "_id", "__v"]);
function clean<T>(v: T): T {
    if (Array.isArray(v)) return v.map(clean) as unknown as T;
    if (v && typeof v === "object" && !(v instanceof Date)) {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_FIELDS.has(k)).map(([k, x]) => [k, clean(x)])) as T;
    }
    return v;
}

export function supportRoutes(): RouteDef[] {
    return [
        {
            method: "get", path: "/issues", perm: "users.read", action: "issues.list",
            handler: async ({ query }) => {
                const page = pageOf(query);
                const filter: Record<string, unknown> = {};
                if (query.status) filter.status = query.status;
                else if (query.open !== "all") filter.status = { $ne: "resolved" };
                if (query.familyId) filter.familyId = query.familyId;
                const [rows, total, counts] = await Promise.all([
                    SupportIssue.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).lean<ISupportIssue[]>(),
                    SupportIssue.countDocuments(filter),
                    Promise.all(ISSUE_STATUSES.map((s) => SupportIssue.countDocuments({ status: s }))),
                ]);
                return { detail: { page, n: rows.length }, data: { total, page, pageSize: PAGE, counts: Object.fromEntries(ISSUE_STATUSES.map((s, i) => [s, counts[i]])), issues: rows.map(issueOut) } };
            },
        },
        {
            method: "post", path: "/issues", perm: "users.manage", action: "issue.create",
            handler: async ({ admin, body }) => {
                const input = z.object({
                    title: z.string().trim().min(3).max(200), body: z.string().max(4000).optional(), familyId: z.string().max(64).optional(),
                    userId: z.string().max(64).optional(), area: z.string().max(40).optional(), priority: z.enum(ISSUE_PRIORITIES).default("normal"),
                }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input", input.error.issues[0]?.message);
                if (input.data.familyId && !(await Family.exists({ familyId: input.data.familyId }))) throw new AdminError(404, "no_such_family");
                const issueId = `ISS-${Date.now().toString(36).toUpperCase()}`;
                const doc = await SupportIssue.create({ ...input.data, issueId, status: "open", createdBy: admin.email, createdAt: new Date(), updatedAt: new Date(), log: [{ at: new Date(), by: admin.email, text: "Opened" }] });
                return { status: 201, target: `issue:${issueId}`, data: issueOut(doc.toObject()) };
            },
        },
        {
            method: "patch", path: "/issues/:issueId", perm: "users.manage", action: "issue.update",
            handler: async ({ admin, params, body }) => {
                const input = z.object({
                    status: z.enum(ISSUE_STATUSES).optional(), priority: z.enum(ISSUE_PRIORITIES).optional(), assignee: z.string().email().nullable().optional(),
                    comment: z.string().trim().min(1).max(2000).optional(),
                }).strict().safeParse(body);
                if (!input.success || !Object.keys(input.data).length) throw new AdminError(400, "bad_input");
                const issue = await SupportIssue.findOne({ issueId: params.issueId }).lean<ISupportIssue>();
                if (!issue) throw new AdminError(404, "no_such_issue");
                const { comment, ...set } = input.data;
                const lines = [
                    ...Object.entries(set).map(([k, v]) => `${k} → ${v ?? "none"}`),
                    ...(comment ? [comment] : []),
                ];
                await SupportIssue.updateOne({ issueId: issue.issueId }, { $set: { ...set, updatedAt: new Date() }, $push: { log: { $each: lines.map((text) => ({ at: new Date(), by: admin.email, text })) } } });
                return { target: `issue:${issue.issueId}`, detail: { changed: Object.keys(set), comment: !!comment }, data: issueOut((await SupportIssue.findOne({ issueId: issue.issueId }).lean<ISupportIssue>())!) };
            },
        },

        {
            method: "get", path: "/data-requests", perm: "data.requests", action: "data_requests.list",
            handler: async () => {
                const rows = await DataRequest.find({}).sort({ receivedAt: -1 }).limit(200).lean<IDataRequest[]>();
                return { detail: { n: rows.length }, data: { requests: rows.map(requestOut) } };
            },
        },
        {
            method: "post", path: "/data-requests", perm: "data.requests", action: "data_request.create",
            handler: async ({ admin, body }) => {
                const input = z.object({ type: z.enum(DATA_REQUEST_TYPES), userId: z.string().min(3).max(64), note: z.string().max(1000).optional(), receivedAt: z.coerce.date().optional() }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input");
                if (!(await User.exists({ userId: input.data.userId }))) throw new AdminError(404, "no_such_user");
                const receivedAt = input.data.receivedAt ?? new Date();
                const requestId = `DR-${randomUUID().slice(0, 8).toUpperCase()}`;
                const doc = await DataRequest.create({
                    requestId, type: input.data.type, userId: input.data.userId, note: input.data.note, receivedAt,
                    dueAt: new Date(receivedAt.getTime() + 30 * 86_400_000), createdBy: admin.email, status: "received",
                    log: [{ at: new Date(), by: admin.email, text: "Received" }],
                });
                return { status: 201, target: `user:${input.data.userId}`, detail: { type: input.data.type, requestId }, data: requestOut(doc.toObject()) };
            },
        },
        {
            method: "patch", path: "/data-requests/:requestId", perm: "data.requests", action: "data_request.update",
            handler: async ({ admin, params, body }) => {
                const input = z.object({ status: z.enum(DATA_REQUEST_STATUSES), comment: z.string().max(1000).optional() }).safeParse(body);
                if (!input.success) throw new AdminError(400, "bad_input");
                const r = await DataRequest.findOne({ requestId: params.requestId }).lean<IDataRequest>();
                if (!r) throw new AdminError(404, "no_such_request");
                await DataRequest.updateOne({ requestId: r.requestId }, { $set: { status: input.data.status }, $push: { log: { at: new Date(), by: admin.email, text: `status → ${input.data.status}${input.data.comment ? `: ${input.data.comment}` : ""}` } } });
                return { target: `user:${r.userId}`, detail: { requestId: r.requestId, status: input.data.status }, data: requestOut((await DataRequest.findOne({ requestId: r.requestId }).lean<IDataRequest>())!) };
            },
        },
        {
            method: "post", path: "/data-requests/:requestId/export", perm: "data.requests", action: "data_request.export",
            handler: async ({ admin, params }) => {
                const r = await DataRequest.findOne({ requestId: params.requestId }).lean<IDataRequest>();
                if (!r || r.type !== "export") throw new AdminError(404, "no_such_export_request");
                const userId = r.userId;
                const [user, families, schedules, completions, messages, orders, activity, notifications, voice, companions, sessions, profiles, reminders] = await Promise.all([
                    User.findOne({ userId }).lean(),
                    Family.find({ "members.userId": userId }, { familyId: 1, name: 1, members: 1 }).lean<Array<{ familyId: string; name?: string; members: Array<{ userId: string; role: string; status: string; joinedAt?: Date }> }>>(),
                    CareSchedule.find({ recipientUserId: userId }).lean(),
                    CareScheduleCompletion.find({ recipientUserId: userId }).lean(),
                    SaheliMessage.find({ recipientUserId: userId }).sort({ createdAt: 1 }).limit(20_000).lean(),
                    Order.find({ subjectUserId: userId }).lean(),
                    ActivityLog.find({ recipientUserId: userId }).limit(20_000).lean(),
                    Notification.find({ userId }).limit(5_000).lean(),
                    VoicePreference.find({ userId }).lean(),
                    SaheliCompanion.find({ recipientUserId: userId }).lean(),
                    Session.find({ userId }, { sessionId: 1, status: 1, createdAt: 1, lastActiveAt: 1, authProvider: 1 }).lean(),
                    ElderProfile.find({ recipientUserId: userId }).lean(),
                    SaheliReminder.find({ recipientUserId: userId }).lean(),
                ]);
                if (!user) throw new AdminError(404, "no_such_user");
                const memory = await Promise.all(families.map(async (f) => ({ familyId: f.familyId, ...(await engineOrNull<unknown>("GET", `/families/${encodeURIComponent(f.familyId)}/export?subject=${encodeURIComponent(userId)}`)) })));
                await DataRequest.updateOne({ requestId: r.requestId }, { $set: { status: r.status === "received" ? "in_progress" : r.status }, $push: { log: { at: new Date(), by: admin.email, text: "Export generated" } } });
                return {
                    target: `user:${userId}`, detail: { requestId: r.requestId },
                    data: clean({
                        generatedAt: new Date().toISOString(), requestId: r.requestId, account: user,
                        families: families.map((f) => ({ familyId: f.familyId, name: f.name, role: f.members.find((m) => m.userId === userId)?.role, status: f.members.find((m) => m.userId === userId)?.status })),
                        careSchedules: schedules, scheduleCompletions: completions, saheliMessages: messages, orders, activity, notifications,
                        voicePreferences: voice, companionSettings: companions, sessions, profiles, reminders, saheliMemory: memory,
                    }),
                };
            },
        },
    ];
}
