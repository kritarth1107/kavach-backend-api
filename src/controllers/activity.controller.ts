import type { Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor, getMemberRole, requireCareRecipient } from "../services/careRecordAuth.service";
import { FamilyRole } from "../types/family.types";
import { listActivity, istDayKey } from "../services/activityLog.service";
import { ACTIVITY_KINDS, type ActivityKind } from "../models/activityLog.model";
import { generateDailySnapshot, getDailySnapshot, listDailySnapshots } from "../services/dailySnapshot.service";
import { getFamilyMembersList } from "../services/familyMember.service";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Caller must be a JOINED caregiver of the family; subject must be its care recipient. */
async function requireCaregiverOf(req: Request) {
    const { familyId, subjectUserId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    const role = getMemberRole(family, actorUserId);
    if (role !== FamilyRole.PRIMARY_CAREGIVER && role !== FamilyRole.CO_CAREGIVER) {
        throw new AppError("Only caregivers can view activity", 403);
    }
    requireCareRecipient(family, subjectUserId);
    return { familyId, subjectUserId, actorUserId };
}

export async function getActivityHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = await requireCaregiverOf(req);
    const day = typeof req.query.day === "string" ? req.query.day : undefined;
    if (day && !DAY_RE.test(day)) throw new AppError("day must be YYYY-MM-DD", 400);
    const beforeRaw = typeof req.query.before === "string" ? req.query.before : undefined;
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) throw new AppError("before must be an ISO timestamp", 400);
    const kinds =
        typeof req.query.kinds === "string"
            ? (req.query.kinds.split(",").map((k) => k.trim()).filter((k) => ACTIVITY_KINDS.includes(k as ActivityKind)) as ActivityKind[])
            : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 500);
    const rows = await listActivity({ familyId, recipientUserId: subjectUserId, dayKey: day, before, kinds, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => ({
        id: String(r._id),
        kind: r.kind,
        title: r.title,
        detail: r.detail ?? "",
        severity: r.severity,
        dayKey: r.dayKey,
        createdAt: new Date(r.createdAt as Date).toISOString(),
        actorUserId: r.actorUserId ?? null,
        data: r.data ?? {},
    }));
    res.json({
        success: true,
        data: { items, hasMore, nextBefore: hasMore && items.length ? items[items.length - 1]!.createdAt : null },
    });
}

export async function getDailySnapshotHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = await requireCaregiverOf(req);
    const day = typeof req.query.day === "string" && req.query.day ? req.query.day : istDayKey();
    if (!DAY_RE.test(day)) throw new AppError("day must be YYYY-MM-DD", 400);
    res.json({ success: true, data: { snapshot: await getDailySnapshot(subjectUserId, day, familyId) } });
}

export async function listDailySnapshotsHandler(req: Request, res: Response) {
    const { familyId, subjectUserId } = await requireCaregiverOf(req);
    const limit = Number(req.query.limit ?? 14) || 14;
    res.json({ success: true, data: { snapshots: await listDailySnapshots(subjectUserId, limit, familyId) } });
}

const lastRegen = new Map<string, number>();
export async function postDailySnapshotHandler(req: Request, res: Response) {
    const { familyId, subjectUserId, actorUserId } = await requireCaregiverOf(req);
    const day = typeof req.body?.day === "string" && req.body.day ? req.body.day : istDayKey();
    if (!DAY_RE.test(day)) throw new AppError("day must be YYYY-MM-DD", 400);
    const key = `${subjectUserId}:${day}`;
    const prev = lastRegen.get(key);
    if (prev !== undefined && Date.now() - prev < 120_000) {
        throw new AppError("Snapshot was just generated — try again in a couple of minutes", 429);
    }
    lastRegen.set(key, Date.now());
    const elderName = await getFamilyMembersList(familyId, actorUserId)
        .then((p) => p.members.find((m) => m.userId === subjectUserId)?.name)
        .catch(() => undefined);
    const snapshot = await generateDailySnapshot({
        familyId,
        recipientUserId: subjectUserId,
        dayKey: day,
        elderName: elderName || undefined,
        source: "on_demand",
    });
    res.json({ success: true, data: { snapshot } });
}
