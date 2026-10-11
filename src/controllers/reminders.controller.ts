/**
 * Caregiver dashboard → a person's Saheli reminders (the calendar's Reminders column and the "All reminders" list).
 * The same rules as Saheli's care memory: joined primary/co-caregivers, about a care recipient of the family or their
 * own self care (never another caregiver's). Everything here can also be done by telling Saheli on WhatsApp.
 */
import { Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor, getMemberRole, requireCareSubject } from "../services/careRecordAuth.service";
import {
    cancelSaheliReminder,
    listSaheliReminders,
    remindersForDay,
    skipSaheliReminder,
    updateSaheliReminder,
} from "../services/saheliReminder.service";
import { FamilyRole } from "../types/family.types";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;

async function scope(req: Request) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    const role = getMemberRole(family, actorUserId);
    if (role !== FamilyRole.PRIMARY_CAREGIVER && role !== FamilyRole.CO_CAREGIVER) {
        throw new AppError("Only caregivers can manage reminders here", 403);
    }
    requireCareSubject(family, subjectUserId, actorUserId);
    return { familyId, recipientUserId: subjectUserId, actorUserId };
}

function reminderId(req: Request): string {
    const id = String(req.params.reminderId || "");
    if (!ID_RE.test(id)) throw new AppError("invalid reminder id", 400);
    return id;
}

function done<T extends { ok: boolean; error?: string }>(res: Response, out: T) {
    if (!out.ok) throw new AppError(out.error || "Could not change the reminder", out.error === "Reminder not found." ? 404 : 400);
    res.json({ success: true, data: out });
}

export async function getReminders(req: Request, res: Response) {
    const s = await scope(req);
    const status = req.query.status === "all" ? "all" : "active";
    res.json({ success: true, data: { reminders: await listSaheliReminders({ ...s, status }) } });
}

export async function getRemindersForDay(req: Request, res: Response) {
    const s = await scope(req);
    const day = typeof req.query.day === "string" && DAY_RE.test(req.query.day) ? req.query.day : "";
    if (!day) throw new AppError("day (YYYY-MM-DD) required", 400);
    res.json({ success: true, data: await remindersForDay({ ...s, day }) });
}

export async function postStopReminder(req: Request, res: Response) {
    const s = await scope(req);
    done(res, await cancelSaheliReminder({ ...s, reminderId: reminderId(req) }));
}

export async function postSkipReminder(req: Request, res: Response) {
    const s = await scope(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    done(res, await skipSaheliReminder({
        ...s,
        reminderId: reminderId(req),
        day: typeof body.day === "string" ? body.day : undefined,
        time: typeof body.time === "string" ? body.time : undefined,
        undo: body.undo === true,
    }));
}

export async function patchReminder(req: Request, res: Response) {
    const s = await scope(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const schedule: Record<string, unknown> = {};
    for (const k of ["times", "repeat", "date", "days", "startDate", "endDate", "windowStart", "windowEnd"]) {
        if (body[k] !== undefined) schedule[k] = body[k];
    }
    done(res, await updateSaheliReminder({
        ...s,
        reminderId: reminderId(req),
        text: typeof body.text === "string" ? body.text : undefined,
        schedule: Object.keys(schedule).length ? schedule : undefined,
    }));
}
