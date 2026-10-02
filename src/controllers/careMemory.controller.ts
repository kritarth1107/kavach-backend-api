/**
 * Caregiver dashboard → Saheli's care memory and tasks (ai-engine /v2/dash).
 * Only JOINED primary/co-caregivers of the family, about its care recipient. Edits carry the caregiver as actor.
 */
import { Request, Response } from "express";
import { aiEngineJson } from "../clients/aiEngine.client";
import { AppError } from "../middleware/error.middleware";
import User from "../models/users.model";
import { getFamilyForActor, getMemberRole, requireCareSubject } from "../services/careRecordAuth.service";
import { FamilyRole } from "../types/family.types";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;

async function caregiverScope(req: Request) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    const role = getMemberRole(family, actorUserId);
    if (role !== FamilyRole.PRIMARY_CAREGIVER && role !== FamilyRole.CO_CAREGIVER) {
        throw new AppError("Only caregivers can see Saheli's care memory", 403);
    }
    requireCareSubject(family, subjectUserId, actorUserId);
    const user = await User.findOne({ userId: actorUserId }).lean();
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
    return { base: `/v2/dash/${encodeURIComponent(familyId)}/${encodeURIComponent(subjectUserId)}`, actor: { id: actorUserId, name } };
}

function qs(params: Record<string, string | undefined>): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : "";
}

function id(value: string, what: string): string {
    if (!ID_RE.test(value)) throw new AppError(`invalid ${what}`, 400);
    return value;
}

export async function getOverview(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const day = typeof req.query.day === "string" && DAY_RE.test(req.query.day) ? req.query.day : undefined;
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/overview${qs({ day })}`, undefined, 45_000) });
}

export async function getFactHistory(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const key = typeof req.query.key === "string" ? req.query.key.slice(0, 200) : "";
    if (!key) throw new AppError("key required", 400);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/history${qs({ key })}`) });
}

export async function getEvents(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const day = typeof req.query.day === "string" && DAY_RE.test(req.query.day) ? req.query.day : undefined;
    const kinds = typeof req.query.kinds === "string" ? req.query.kinds.slice(0, 300) : undefined;
    const limit = typeof req.query.limit === "string" ? String(Math.min(Number(req.query.limit) || 300, 1000)) : undefined;
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/events${qs({ day, kinds, limit })}`) });
}

export async function postFact(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const { domain, name, details, sentence } = req.body ?? {};
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/facts`, { actor, domain, name, details: details ?? {}, sentence }, 45_000) });
}

export async function postStopFact(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const { domain, name, reason } = req.body ?? {};
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/facts/stop`, { actor, domain, name, reason: reason || "removed by caregiver" }, 45_000) });
}

export async function postResolveFact(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const { key, approve } = req.body ?? {};
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/facts/resolve`, { actor, key, approve: Boolean(approve) }, 45_000) });
}

export async function postCloseLoop(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const loopId = id(req.params.loopId, "loop id");
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/loops/${loopId}/close`, { actor, note: req.body?.note || "closed from dashboard" }) });
}

export async function putNote(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const { subjectId, slug, title, body } = req.body ?? {};
    res.json({ success: true, data: await aiEngineJson("PUT", `${base}/notes`, { actor, subject_id: subjectId, slug, title, body }) });
}

export async function postTaskInput(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const taskId = id(req.params.taskId, "task id");
    const { kind, value } = req.body ?? {};
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/tasks/${taskId}/input`, { actor, kind, value: String(value ?? "") }) });
}

export async function postTaskCancel(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const taskId = id(req.params.taskId, "task id");
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/tasks/${taskId}/cancel`, { actor, reason: req.body?.reason || "cancelled from dashboard" }) });
}

export async function getTaskLive(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const taskId = id(req.params.taskId, "task id");
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/tasks/${taskId}/live`) });
}

export async function getHome(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/home`, undefined, 45_000) });
}
