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

// ── care views (the same data Saheli's tools read on WhatsApp) ──────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function getStock(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/stock`) });
}

export async function postStock(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const count = Number(req.body?.count);
    if (!Number.isInteger(count) || count < 0 || count > 2000) throw new AppError("count must be 0–2000", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/stock`, { actor, key: String(req.body?.key ?? ""), count }) });
}

export async function postRefillOrder(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const key = String(req.params.key ?? "").slice(0, 160);
    const service = String(req.body?.service ?? "");
    if (!["apollo", "1mg", "pharmeasy"].includes(service)) throw new AppError("service must be apollo, 1mg or pharmeasy", 400);
    const qty = Math.min(Math.max(Number(req.body?.qty) || 1, 1), 20);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/stock/${encodeURIComponent(key)}/order`, { actor, service, qty }, 45_000) });
}

export async function getEmergency(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/emergency`) });
}

export async function getCareTeam(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/care-team`) });
}

export async function postAppointmentQuestion(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const question = String(req.body?.question ?? "").trim().slice(0, 400);
    if (!question) throw new AppError("question required", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/appointments/question`, { actor, key: String(req.body?.key ?? ""), question }, 45_000) });
}

export async function getReport(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 31);
    const subject = await User.findOne({ userId: req.params.subjectUserId }).lean();
    const name = [subject?.firstName, subject?.lastName].filter(Boolean).join(" ");
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/report${qs({ days: String(days), name })}`, undefined, 60_000) });
}

export async function getWellbeing(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const days = Math.min(Math.max(Number(req.query.days) || 14, 3), 60);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/wellbeing${qs({ days: String(days) })}`) });
}

export async function getPatterns(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/patterns`) });
}

export async function getOutcomes(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/outcomes`) });
}

export async function postOutcome(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const body = { actor, kind: String(req.body?.kind ?? ""), summary: String(req.body?.summary ?? "").slice(0, 400) };
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/outcomes`, body) });
}

export async function postFeedback(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const body = { actor, target: String(req.body?.target ?? "").slice(0, 250), vote: req.body?.vote === "down" ? "down" : "up" };
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/feedback`, body) });
}

export async function getConsent(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/consent`) });
}

export async function postConsent(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/consent`, { actor, granted: req.body?.granted === true }) });
}

export async function getMemoryHealth(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/memory-health`) });
}

export async function postForget(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const what = String(req.body?.what ?? "").trim().slice(0, 200);
    if (what.length < 3) throw new AppError("Say what to forget (a few words)", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/forget`, { actor, what }) });
}

export async function postRestoreForgotten(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const id = Number(req.params.eventId);
    if (!Number.isInteger(id) || id < 1) throw new AppError("Bad id", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/forgotten/${id}/restore`, { actor }) });
}

export async function getSkills(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/skills`) });
}

export async function postSkill(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const text = String(req.body?.text ?? "").trim().slice(0, 600);
    if (text.length < 3) throw new AppError("Write the skill in a few words", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/skills`, { actor, text }) });
}

const SKILL_ACTIONS = new Set(["approve", "edit", "remove", "restore"]);

export async function postSkillAction(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const id = Number(req.params.skillId);
    if (!Number.isInteger(id) || id < 1) throw new AppError("Bad id", 400);
    const action = String(req.body?.action ?? "");
    if (!SKILL_ACTIONS.has(action)) throw new AppError("Unknown action", 400);
    const text = action === "edit" ? String(req.body?.text ?? "").trim().slice(0, 600) : undefined;
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/skills/${id}`, { actor, action, text }) });
}

export async function getLogins(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/logins`) });
}

export async function getFamilyTasks(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/family-tasks`) });
}

export async function postFamilyTask(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const { familyId } = req.params;
    const title = String(req.body?.title ?? "").trim();
    const assignee = String(req.body?.assignee ?? "");
    if (title.length < 2) throw new AppError("title required", 400);
    const family = await getFamilyForActor(familyId, actor.id);
    if (!family.hasJoinedMember(assignee)) throw new AppError("Assign the task to someone in the family", 400);
    const due = typeof req.body?.due === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(req.body.due) ? req.body.due.slice(0, 16) : undefined;
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/family-tasks`, { actor, title: title.slice(0, 300), assignee, due }) });
}

export async function postFamilyTaskDone(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const taskId = id(req.params.taskId, "task id");
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/family-tasks/${taskId}/done`, { actor, note: String(req.body?.note || "done").slice(0, 200) }) });
}

export async function getSpending(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const month = typeof req.query.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : undefined;
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/spending${qs({ month })}`) });
}

export async function getEmergencyLink(req: Request, res: Response) {
    await caregiverScope(req);
    const { currentEmergencyLink } = await import("../services/emergencyCard.service");
    res.json({ success: true, data: await currentEmergencyLink(req.params.familyId, req.params.subjectUserId) });
}

export async function postEmergencyLink(req: Request, res: Response) {
    const { actor } = await caregiverScope(req);
    const { ensureEmergencyLink } = await import("../services/emergencyCard.service");
    res.json({ success: true, data: await ensureEmergencyLink(req.params.familyId, req.params.subjectUserId, actor.id) });
}

export async function deleteEmergencyLink(req: Request, res: Response) {
    await caregiverScope(req);
    const { revokeEmergencyLinks } = await import("../services/emergencyCard.service");
    res.json({ success: true, data: await revokeEmergencyLinks(req.params.familyId, req.params.subjectUserId) });
}
