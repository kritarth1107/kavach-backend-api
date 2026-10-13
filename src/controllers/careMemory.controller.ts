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

/** The person-centred pages (Care plan, Story, Emergency card): who they are, mood, what Saheli learned with their words,
 *  the people around them, their day and a week of doses. */
export async function getPortrait(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/portrait`, undefined, 45_000) });
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

// mirrors the engine's app/care/versions.py KINDS (D-13 added "link": its history drawer filtered on nothing before;
// "food" is the food log's own history, nutrition plan §N2)
const HISTORY_KINDS = new Set(["note", "fact", "skill", "style", "link", "food"]);

/** What changed in this person's memory (notes, care record, skills, style), with the family member's name on each change. */
export async function getMemoryHistory(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const kind = typeof req.query.kind === "string" && HISTORY_KINDS.has(req.query.kind) ? req.query.kind : undefined;
    const target = typeof req.query.target === "string" ? req.query.target.slice(0, 200) : undefined;
    const what = typeof req.query.what === "string" ? req.query.what.slice(0, 100) : undefined;
    const limit = typeof req.query.limit === "string" ? String(Math.min(Math.max(Number(req.query.limit) || 40, 1), 100)) : undefined;
    // actor: on a caregiver's own self-care page the engine leaves the shared family notes out
    const data = (await aiEngineJson("GET", `${base}/memory-history${qs({ kind, target, what, limit, actor: actor.id })}`)) as {
        changes?: Array<{ actorId?: string | null; by?: string }>;
    };
    const ids = [...new Set((data.changes ?? []).map((c) => c.actorId).filter((x): x is string => !!x && x !== "saheli"))];
    if (ids.length) {
        const users = await User.find({ userId: { $in: ids } }, { userId: 1, firstName: 1, lastName: 1 }).lean();
        const names = new Map(users.map((u) => [u.userId, [u.firstName, u.lastName].filter(Boolean).join(" ")]));
        for (const c of data.changes ?? []) if (c.actorId && names.get(c.actorId)) c.by = names.get(c.actorId);
    }
    res.json({ success: true, data });
}

/** Undo one change, or put an item back as it was (mode "restore"). `confirm` = the caregiver confirmed ending or restarting a medicine. */
const UNDO_MODES = new Set(["undo", "restore"]);

function versionId(value: string): number {
    const vid = Number(value);
    if (!Number.isInteger(vid) || vid < 1) throw new AppError("Bad id", 400);
    return vid;
}

/** What an undo/restore would do, in plain words (the dashboard shows it before the caregiver confirms). */
export async function getMemoryUndoPreview(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const vid = versionId(req.params.versionId);
    const mode = req.query.mode === "restore" ? "restore" : "undo";
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/memory-history/${vid}/preview${qs({ mode, actor: actor.id })}`) });
}

export async function postMemoryUndo(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const vid = versionId(req.params.versionId);
    const mode = String(req.body?.mode ?? "undo");
    if (!UNDO_MODES.has(mode)) throw new AppError("mode must be undo or restore", 400);
    const reason = String(req.body?.reason ?? "").trim().slice(0, 300);
    const confirm = req.body?.confirm === true;
    // a medicine undo also updates its reminders through the backend: same 45 s budget as other medicine edits
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/memory-history/${vid}`, { actor, mode, reason, confirm }, 45_000) });
}

/** Voice replies for this person (auto = when they send a voice note, always, never): same setting Saheli changes on WhatsApp. */
export async function getVoicePreference(req: Request, res: Response) {
    await caregiverScope(req);
    const { getVoiceMode, VOICE_MODE_LABEL } = await import("../services/voicePreference.service");
    const mode = await getVoiceMode(req.params.subjectUserId, req.params.familyId);
    res.json({ success: true, data: { mode, means: VOICE_MODE_LABEL[mode] } });
}

/** The care record holds the setting (trust plan A1): saved in the engine, which keeps the backend's copy in step. */
export async function postVoicePreference(req: Request, res: Response) {
    const { actor, base } = await caregiverScope(req);
    const { isVoiceMode, VOICE_MODE_LABEL } = await import("../services/voicePreference.service");
    const mode = req.body?.mode;
    if (!isVoiceMode(mode)) throw new AppError("mode must be auto, always or never", 400);
    await aiEngineJson("PUT", `${base}/speech`, { actor, voice: mode }, 30_000);
    const { forgetEnginePerson } = await import("../clients/enginePerson.client");
    forgetEnginePerson(req.params.familyId, req.params.subjectUserId);
    res.json({ success: true, data: { mode, means: VOICE_MODE_LABEL[mode] } });
}

export async function getSkills(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    // Only this person's own skills: the order agents' shared store steps (counts across every family) are no family's to
    // see (founder 2026-10-13: a new account read them as orders it had never placed).
    const data = (await aiEngineJson("GET", `${base}/skills`)) as { skills?: unknown[] };
    res.json({ success: true, data: { skills: data?.skills ?? [] } });
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

/** Everything the family handed over: state, who acts next, next action, deadline, stuck (all=1 adds the last 14 days). */
export async function getWork(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/work${req.query.all === "1" ? "?all=true" : ""}`) });
}

/** The family's limits for orders and rides (boundaries); changing them is for the family's approver (engine checks). */
export async function getBoundaries(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/boundaries`) });
}

const BOUNDARY_KEYS = new Set(["elder_order_limit", "elder_ride_limit", "anyone_over", "monthly_cap", "approval_categories", "approvers", "members"]);

export async function putBoundaries(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const raw = (req.body?.changes ?? {}) as Record<string, unknown>;
    const changes = Object.fromEntries(Object.entries(raw).filter(([k]) => BOUNDARY_KEYS.has(k)));
    if (!Object.keys(changes).length) throw new AppError("Nothing to change", 400);
    res.json({ success: true, data: await aiEngineJson("PUT", `${base}/boundaries`, { actor, changes }) });
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

// ── food and nutrition (nutrition plan §N8, §N10; engine INTERFACES.md §3) ──────────────────────────────────────────────
// The same tools Saheli uses on WhatsApp (log_food, change_food, nutrition_target, nutrition_settings, pantry), run by the
// engine with the caregiver as actor. Field names are camelCase here and snake_case at the engine.

const MEALS = new Set(["breakfast", "lunch", "snack", "dinner", "other"]);

function str(v: unknown, max: number): string | undefined {
    return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function positive(v: unknown, max: number): number | undefined {
    if (v === undefined || v === null || v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max) throw new AppError(`a number between 0 and ${max} is needed`, 400);
    return n;
}

function eatenAt(v: unknown): string | undefined {
    const s = str(v, 40);
    if (s && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) throw new AppError("eatenAt must be YYYY-MM-DDTHH:MM (IST)", 400);
    return s;
}

function meal(v: unknown): string | undefined {
    const s = str(v, 16);
    if (s && !MEALS.has(s)) throw new AppError("meal must be breakfast, lunch, snack, dinner or other", 400);
    return s;
}

export async function getNutrition(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const day = typeof req.query.day === "string" && DAY_RE.test(req.query.day) ? req.query.day : undefined;
    const days = ["1", "7", "30"].includes(String(req.query.days)) ? String(req.query.days) : undefined;
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/nutrition${qs({ days, day })}`, undefined, 45_000) });
}

export async function getNutritionFoods(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
    const limit = String(Math.min(Math.max(Number(req.query.limit) || 10, 1), 20));
    if (!q) return void res.json({ success: true, data: { foods: [] } });
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/nutrition/foods${qs({ q, limit })}`) });
}

export async function getNutritionReport(req: Request, res: Response) {
    const { base } = await caregiverScope(req);
    const days = ["7", "14", "30"].includes(String(req.query.days)) ? String(req.query.days) : "7";
    res.json({ success: true, data: await aiEngineJson("GET", `${base}/nutrition/report${qs({ days })}`, undefined, 45_000) });
}

export async function postNutritionEntries(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    // answerTo: the caregiver answers the question Saheli's food agent asked about this log (how many, which one), or
    // cancels it ("never mind": nothing is saved) or says they don't know (a usual portion, marked estimate)
    const answerTo = str(req.body?.answerTo, 64);
    const cancel = answerTo ? req.body?.cancel === true : undefined;
    const unsure = answerTo ? req.body?.unsure === true : undefined;
    const raw = Array.isArray(req.body?.items) ? (req.body.items as Array<Record<string, unknown>>) : [];
    if (raw.length > 15 || (!raw.length && !(answerTo && (cancel || unsure)))) throw new AppError("1 to 15 items", 400);
    const items = raw.map((i) => {
        const name = str(i?.name, 200);
        if (!name) throw new AppError("each item needs a name", 400);
        return { name, quantity: positive(i.quantity, 5000), unit: str(i.unit, 16), brand: str(i.brand, 120), food_id: str(i.foodId, 64) };
    });
    const body = {
        actor, items, meal: meal(req.body?.meal), eaten_at: eatenAt(req.body?.eatenAt),
        answer_to: answerTo ? id(answerTo, "question id") : undefined, cancel: cancel || undefined, unsure: unsure || undefined,
    };
    // a new food is looked up on the web (grounded search): the same budget as Saheli's own slow path
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/entries`, body, 60_000) });
}

export async function postNutritionEntryChange(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const entryId = id(req.params.entryId, "entry id");
    const s = (req.body?.set ?? {}) as Record<string, unknown>;
    const set = { quantity: positive(s.quantity, 5000), unit: str(s.unit, 16), eaten_at: eatenAt(s.eatenAt), meal: meal(s.meal), item: str(s.item, 200) };
    if (Object.values(set).every((v) => v === undefined)) throw new AppError("Nothing to change", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/entries/${entryId}`, { actor, set }, 60_000) });
}

export async function postNutritionEntryDelete(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const entryId = id(req.params.entryId, "entry id");
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/entries/${entryId}/delete`, { actor }) });
}

const TARGET_SETTERS = new Set(["caregiver", "self", "doctor", "dietitian", "trainer", "other"]);

export async function postNutritionTargets(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const setBy = String(req.body?.setBy ?? "caregiver");
    if (!TARGET_SETTERS.has(setBy)) throw new AppError("setBy must be caregiver, self, doctor, dietitian, trainer or other", 400);
    const how = req.body?.how === "strict" ? "strict" : "guide";
    const set = req.body?.set && typeof req.body.set === "object" && !Array.isArray(req.body.set) ? req.body.set : {};
    const rules = Array.isArray(req.body?.rules) ? (req.body.rules as unknown[]).slice(0, 10) : [];
    const remove = Array.isArray(req.body?.remove) ? (req.body.remove as unknown[]).map((k) => String(k).slice(0, 40)).slice(0, 20) : [];
    if (!Object.keys(set).length && !rules.length && !remove.length) throw new AppError("Nothing to change", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/targets`, { actor, set, rules, set_by: setBy, how, remove }) });
}

export async function postNutritionSettings(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const b = req.body ?? {};
    const body = {
        actor,
        tracking: str(b.tracking, 8),
        ask: str(b.ask, 12),
        daily_summary_to: Array.isArray(b.dailySummaryTo) ? (b.dailySummaryTo as unknown[]).map(String).slice(0, 6) : undefined,
        sizes: b.sizes && typeof b.sizes === "object" && !Array.isArray(b.sizes) ? b.sizes : undefined,
        counters: Array.isArray(b.counters) ? (b.counters as unknown[]).map((c) => String(c).slice(0, 60)).slice(0, 10) : undefined,
    };
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/settings`, body) });
}

export async function postNutritionPantry(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const action = String(req.body?.action ?? "");
    if (!["add", "used", "remove"].includes(action)) throw new AppError("action must be add, used or remove", 400);
    const pid = str(req.body?.id, 64);
    const body = { actor, action, item: str(req.body?.item, 200), count: positive(req.body?.count, 1000), unit: str(req.body?.unit, 8), id: pid ? id(pid, "pantry id") : undefined };
    if (!body.item && !body.id) throw new AppError("item or id required", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/pantry`, body, 45_000) });
}

/** "Waiting: did they eat it?" for a delivered meal: only a Yes or Part logs food (plan §N6.1). */
export async function postNutritionConsumed(req: Request, res: Response) {
    const { base, actor } = await caregiverScope(req);
    const taskId = id(String(req.body?.taskId ?? ""), "task id");
    const consumed = String(req.body?.consumed ?? "");
    if (!["yes", "part", "no"].includes(consumed)) throw new AppError("consumed must be yes, part or no", 400);
    const portion = str(req.body?.portionEaten, 8);
    if (portion && !["all", "most", "half", "little"].includes(portion)) throw new AppError("portionEaten must be all, most, half or little", 400);
    res.json({ success: true, data: await aiEngineJson("POST", `${base}/nutrition/consumed`, { actor, task_id: taskId, consumed, portion_eaten: portion }, 60_000) });
}

// Doctor links (§N10, founder Q8): made only by a caregiver or a self-care user, never automatically. caregiverScope already
// refuses the person cared for, view-only members and doctors.

async function sharesOpen(): Promise<boolean> {
    const { flagsLoadedAt, nutritionPageEnabled, refreshFlags } = await import("../services/featureFlags.service");
    if (!flagsLoadedAt()) await refreshFlags().catch(() => undefined);
    return nutritionPageEnabled();
}

export async function getNutritionShares(req: Request, res: Response) {
    await caregiverScope(req);
    const { listNutritionShares } = await import("../services/nutritionShare.service");
    res.json({ success: true, data: { shares: await listNutritionShares(req.params.familyId, req.params.subjectUserId) } });
}

export async function postNutritionShare(req: Request, res: Response) {
    const { actor } = await caregiverScope(req);
    if (!(await sharesOpen())) throw new AppError("Doctor links open with the Food & nutrition page", 403);
    const { createNutritionShare } = await import("../services/nutritionShare.service");
    const share = await createNutritionShare({
        familyId: req.params.familyId, subjectUserId: req.params.subjectUserId, createdBy: actor.id,
        days: req.body?.days, expiresInDays: req.body?.expiresInDays, label: req.body?.label,
    });
    res.json({ success: true, data: share });
}

export async function deleteNutritionShare(req: Request, res: Response) {
    await caregiverScope(req);
    const { revokeNutritionShare } = await import("../services/nutritionShare.service");
    res.json({ success: true, data: await revokeNutritionShare(req.params.familyId, req.params.subjectUserId, String(req.params.shareId)) });
}

/** Dashboard switches the family's pages depend on (admin feature flags). */
export async function getFeatures(req: Request, res: Response) {
    await getFamilyForActor(req.params.familyId, req.user!.userId);
    res.json({ success: true, data: { nutritionPage: await sharesOpen() } });
}
