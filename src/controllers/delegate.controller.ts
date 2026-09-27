import type { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor, getMemberRole } from "../services/careRecordAuth.service";
import { FamilyRole } from "../types/family.types";

async function member(familyId: string, userId: string) {
    const fam = await getFamilyForActor(familyId, userId);
    return { fam, role: getMemberRole(fam, userId) };
}
function caregiverOnly(role: FamilyRole | null) {
    if (role !== FamilyRole.PRIMARY_CAREGIVER && role !== FamilyRole.CO_CAREGIVER) throw new AppError("Only caregivers can change this", 403);
}
async function actorName(userId: string): Promise<string | undefined> {
    const User = (await import("../models/users.model")).default;
    const u = await User.findOne({ userId }).lean();
    return (u as { firstName?: string } | null)?.firstName || undefined;
}

/** GET …/recipients/:recipientUserId/saheli/delegate — permissions, open tasks, follow-ups, approvals, why memory. */
export async function getDelegateHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        await member(familyId, req.user.userId);
        const { delegateSummary } = await import("../services/delegate/summary.service");
        res.json({ success: true, data: await delegateSummary(familyId, recipientUserId) });
    } catch (e) {
        next(e);
    }
}

/** PATCH …/:familyId/saheli/permissions — caregiver-editable toggles (hard guards are not settings). */
export async function patchPermissionsHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId } = req.params;
        const { role } = await member(familyId, req.user.userId);
        caregiverOnly(role);
        const { updatePermissions, PermissionPatchError } = await import("../services/delegate/permissions.service");
        try {
            await updatePermissions(familyId, { userId: req.user.userId, name: await actorName(req.user.userId) }, (req.body || {}) as Record<string, unknown>);
        } catch (err) {
            if (err instanceof PermissionPatchError) throw new AppError(err.message, 400);
            throw err;
        }
        const recipientUserId = String(req.query.recipientUserId || "");
        const { delegateSummary } = await import("../services/delegate/summary.service");
        const { getPermissions } = await import("../services/delegate/permissions.service");
        res.json({ success: true, data: recipientUserId ? await delegateSummary(familyId, recipientUserId) : { permissions: await getPermissions(familyId) } });
    } catch (e) {
        next(e);
    }
}

/** POST …/:familyId/saheli/approvals/:taskId {decision: "approve"|"deny"} */
export async function decideApprovalHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, taskId } = req.params;
        const { role } = await member(familyId, req.user.userId);
        caregiverOnly(role);
        const decision = req.body?.decision;
        if (decision !== "approve" && decision !== "deny") throw new AppError("decision must be approve or deny", 400);
        const { decideApproval } = await import("../services/delegate/approvals.service");
        const t = await decideApproval(taskId, familyId, decision, { userId: req.user.userId, name: await actorName(req.user.userId) });
        if (!t) throw new AppError("Not found", 404);
        res.json({ success: true, data: { taskId, status: t.status } });
    } catch (e) {
        next(e);
    }
}

/** POST …/:familyId/saheli/tasks/:taskId/dismiss — caregiver stops Saheli carrying an open task / follow-up. */
export async function dismissTaskHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, taskId } = req.params;
        const { role } = await member(familyId, req.user.userId);
        caregiverOnly(role);
        const SaheliTask = (await import("../models/saheliTask.model")).default;
        const r = await SaheliTask.updateOne(
            { taskId, familyId, status: { $in: ["open", "asked"] } },
            { $set: { status: "cancelled", outcome: "dismissed", resolvedAt: new Date() }, $push: { history: { at: new Date(), event: "dismissed", note: "by caregiver" } } } as never,
        );
        res.json({ success: true, data: { dismissed: r.modifiedCount > 0 } });
    } catch (e) {
        next(e);
    }
}

/** DELETE …/recipients/:recipientUserId/saheli/why/:whyId — caregiver removes a remembered reason. */
export async function deleteWhyHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId, whyId } = req.params;
        const { role } = await member(familyId, req.user.userId);
        caregiverOnly(role);
        const { deleteWhy } = await import("../services/delegate/why.service");
        res.json({ success: true, data: { removed: await deleteWhy({ familyId, recipientUserId }, whyId) } });
    } catch (e) {
        next(e);
    }
}

// ── Secret-gated mock / test hooks (fixture +999 phones only) ────────────────────────────────
function mockAuthorized(req: Request): boolean {
    const { timingSafeEqual } = require("crypto") as typeof import("crypto");
    if (process.env.NODE_ENV !== "production" && process.env.WHATSAPP_MOCK_OPEN === "1") return true;
    const expected = process.env.WHATSAPP_MOCK_SECRET?.trim();
    const provided = String(req.get("x-kavach-mock-secret") ?? "");
    if (!expected || !provided || provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

/**
 * POST /api/webhooks/whatsapp/mock/delegate {from, action, …}
 *  order_placed | ride_booked | order_failed — write the same activity row the real placement
 *      paths write (the real hook takes it from there; nothing is ordered anywhere)
 *  fast_forward {hours, dropSession} — age this phone's tasks / nudges / last inbound (time travel)
 *  tick {bypassGate, bypassQuiet} — run the delegate scheduler for this phone now
 *  state — dashboard summary for this phone's family / recipient
 *  set_permissions {patch} — as a caregiver would on the dashboard
 *  decide {taskId, decision} — caregiver approves / denies (dashboard button)
 */
export async function postMockDelegate(req: Request, res: Response) {
    if (!mockAuthorized(req)) {
        res.status(404).json({ success: false, message: "Not found" });
        return;
    }
    try {
        const { isSmokeFixturePhone } = await import("../services/smokeFixtures.service");
        const { normalizeChannelIdentifier, resolveWhatsAppSender } = await import("../services/identityResolver.service");
        const { ChannelType } = await import("../types/careRecord.types");
        const phone = normalizeChannelIdentifier(ChannelType.WHATSAPP, String(req.body?.from || ""));
        if (!isSmokeFixturePhone(phone)) {
            res.status(400).json({ success: false, message: "fixture phones only" });
            return;
        }
        const who = await resolveWhatsAppSender(phone);
        const caregiver = who.role === FamilyRole.PRIMARY_CAREGIVER || who.role === FamilyRole.CO_CAREGIVER;
        let subject = who.userId;
        if (caregiver) {
            const Family = (await import("../models/family.model")).default;
            const fam = await Family.findOne({ familyId: who.familyId }).lean();
            subject = String((fam?.members || []).find((m: { role?: string }) => m.role === "CARE_RECIPIENT")?.userId || who.userId);
        }
        const action = String(req.body?.action || "");
        const { logActivity } = await import("../services/activityLog.service");
        const SaheliTask = (await import("../models/saheliTask.model")).default;
        if (action === "order_placed" || action === "order_failed" || action === "ride_booked") {
            const b = req.body || {};
            const label = String(b.partnerLabel || b.partner || "Store");
            if (action === "ride_booked") {
                await logActivity({ familyId: who.familyId, recipientUserId: subject, actorUserId: who.userId, kind: "ride", title: "Uber ride booked", detail: `${b.from || "Home"} → ${b.to || "Clinic"}`, data: { provider: "uber", from: b.from || "Home", to: b.to || "Clinic", mock: true } });
            } else {
                await logActivity({
                    familyId: who.familyId,
                    recipientUserId: subject,
                    actorUserId: who.userId,
                    kind: action,
                    severity: action === "order_failed" ? "warn" : "info",
                    title: action === "order_placed" ? `${label}: order placed ${b.totalLabel || ""} COD`.replace(/\s+/g, " ") : `${label}: checkout failed${b.reason ? ` (${b.reason})` : ""}`,
                    detail: `${b.item || "item"}${b.etaText ? ` — ${b.etaText}` : ""} → Home`,
                    data: { source: "mock", store: b.partner || null, totalLabel: b.totalLabel || null, payment: "COD", failureReason: b.reason || null, mock: true },
                });
            }
            await new Promise((r) => setTimeout(r, Number(b.waitMs) || 6000));
            const { delegateSummary } = await import("../services/delegate/summary.service");
            res.json({ success: true, data: await delegateSummary(who.familyId, subject) });
            return;
        }
        if (action === "fast_forward") {
            const h = Math.min(Math.max(Number(req.body?.hours) || 0, 0), 96);
            const ms = h * 3600_000;
            const rows = await SaheliTask.find({ phone }).lean();
            for (const t of rows) {
                const set: Record<string, Date> = {};
                for (const f of ["lastActiveAt", "askedAt", "dueAt", "resumeOfferedAt", "placedAt", "nudgedAt"] as const) {
                    const v = (t as unknown as Record<string, Date | undefined>)[f];
                    if (v) set[f] = new Date(new Date(v).getTime() - ms);
                }
                if (Object.keys(set).length) await SaheliTask.updateOne({ taskId: t.taskId }, { $set: set });
            }
            const SaheliCompanion = (await import("../models/saheliCompanion.model")).default;
            const SaheliProactiveNudge = (await import("../models/saheliProactiveNudge.model")).default;
            const ActivityLog = (await import("../models/activityLog.model")).default;
            const c = await SaheliCompanion.findOne({ familyId: who.familyId, recipientUserId: subject }).lean();
            if (c?.lastWhatsAppInboundAt) await SaheliCompanion.updateOne({ _id: c._id }, { $set: { lastWhatsAppInboundAt: new Date(new Date(c.lastWhatsAppInboundAt).getTime() - ms) } });
            for (const n of await SaheliProactiveNudge.find({ familyId: who.familyId, recipientUserId: subject }).lean()) {
                await SaheliProactiveNudge.updateOne({ _id: n._id }, { $set: { sentAt: new Date(new Date(n.sentAt).getTime() - ms) } });
            }
            // Conversation rows age too (nudge gate reads them).
            for (const a of await ActivityLog.find({ familyId: who.familyId, recipientUserId: subject, createdAt: { $gte: new Date(Date.now() - 4 * 86_400_000) } }).select({ _id: 1, createdAt: 1 }).lean()) {
                await ActivityLog.collection.updateOne({ _id: a._id }, { $set: { createdAt: new Date(new Date(a.createdAt as Date).getTime() - ms) } });
            }
            // The chat session ages too (a live draft left hours ago is no longer "fresh").
            const WS = (await import("../models/whatsappSession.model")).default;
            const sess = await WS.findOne({ phone }).lean();
            const su = (sess as { updatedAt?: Date } | null)?.updatedAt;
            if (sess && su) await WS.collection.updateOne({ phone }, { $set: { updatedAt: new Date(new Date(su).getTime() - ms) } });
            if (req.body?.dropSession) {
                const WhatsappSession = (await import("../models/whatsappSession.model")).default;
                await WhatsappSession.deleteOne({ phone });
                const { forgetTurns } = await import("../services/saheliRouter.service");
                forgetTurns(phone);
            }
            res.json({ success: true, data: { shiftedHours: h, tasks: rows.length } });
            return;
        }
        if (action === "tick") {
            const { runDelegateTick } = await import("../services/delegate/followup.service");
            const out = await runDelegateTick({ onlyPhone: phone, bypassGate: req.body?.bypassGate !== false, bypassQuiet: req.body?.bypassQuiet === true });
            const { buildWhatsAppMockPeek } = await import("../services/whatsappMockPeek.service");
            res.json({ success: true, data: { tick: out, peek: await buildWhatsAppMockPeek(phone) } });
            return;
        }
        if (action === "set_permissions") {
            const { updatePermissions } = await import("../services/delegate/permissions.service");
            await updatePermissions(who.familyId, { userId: who.userId, name: String(req.body?.name || "Caregiver") }, (req.body?.patch || {}) as Record<string, unknown>);
        } else if (action === "decide") {
            const { decideApproval } = await import("../services/delegate/approvals.service");
            await decideApproval(String(req.body?.taskId || ""), who.familyId, req.body?.decision === "deny" ? "deny" : "approve", { userId: who.userId, name: String(req.body?.name || "Caregiver") });
        } else if (action !== "state") {
            res.status(400).json({ success: false, message: "unknown action" });
            return;
        }
        const { delegateSummary } = await import("../services/delegate/summary.service");
        res.json({ success: true, data: await delegateSummary(who.familyId, subject) });
    } catch (err) {
        res.status(500).json({ success: false, message: err instanceof Error ? err.message.slice(0, 200) : "failed" });
    }
}
