import { randomUUID } from "crypto";
import Family from "../models/family.model";
import CareSchedule from "../models/careSchedule.model";
import { AppError } from "../middleware/error.middleware";
import { CareScheduleType } from "../types/careSchedule.types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

const MANAGER_ROLES = new Set([FamilyRole.PRIMARY_CAREGIVER, FamilyRole.CO_CAREGIVER]);

function canManageSchedule(role: FamilyRole | null) {
    return role !== null && MANAGER_ROLES.has(role);
}

async function getFamilyAndRecipient(familyId: string, recipientUserId: string) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) {
        throw new AppError("Family not found", 404);
    }

    const member = family.members.find((m) => m.userId === recipientUserId);
    if (!member || member.status !== FamilyMemberStatus.JOINED) {
        throw new AppError("Care recipient not found", 404);
    }

    if (member.role !== FamilyRole.CARE_RECIPIENT) {
        throw new AppError("Member is not a care recipient", 400);
    }

    return family;
}

function assertFamilyAccess(family: Awaited<ReturnType<typeof getFamilyAndRecipient>>, userId: string) {
    if (!family.hasJoinedMember(userId)) {
        throw new AppError("Family not found or access denied", 403);
    }
}

function assertCanManageSchedule(family: Awaited<ReturnType<typeof getFamilyAndRecipient>>, userId: string) {
    const role = family.getMemberRole(userId);
    if (!canManageSchedule(role)) {
        throw new AppError("You do not have permission to manage care schedules", 403);
    }
}

function normalizeType(type?: string): CareScheduleType {
    const upper = type?.toUpperCase();
    if (upper && Object.values(CareScheduleType).includes(upper as CareScheduleType)) {
        return upper as CareScheduleType;
    }
    return CareScheduleType.CUSTOM;
}

function serializeSchedule(item: {
    scheduleId: string;
    familyId: string;
    recipientUserId: string;
    type: CareScheduleType;
    title: string;
    time: string;
    dosage?: string;
    instructions?: string;
    daysOfWeek: number[];
    active: boolean;
    createdBy: string;
    updatedBy?: string;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        scheduleId: item.scheduleId,
        familyId: item.familyId,
        recipientUserId: item.recipientUserId,
        type: item.type,
        title: item.title,
        time: item.time,
        dosage: item.dosage ?? null,
        instructions: item.instructions ?? null,
        daysOfWeek: item.daysOfWeek ?? [],
        active: item.active,
        createdBy: item.createdBy,
        updatedBy: item.updatedBy ?? null,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
    };
}

export async function listCareSchedules(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
) {
    const family = await getFamilyAndRecipient(familyId, recipientUserId);
    assertFamilyAccess(family, actorUserId);

    const items = await CareSchedule.find({
        familyId,
        recipientUserId,
    }).sort({ time: 1, title: 1 });

    const role = family.getMemberRole(actorUserId);

    return {
        schedules: items.map(serializeSchedule),
        canManage: canManageSchedule(role),
    };
}

export async function createCareSchedule(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
    payload: {
        type?: string;
        title?: string;
        time?: string;
        dosage?: string;
        instructions?: string;
        daysOfWeek?: number[];
        active?: boolean;
    },
) {
    const family = await getFamilyAndRecipient(familyId, recipientUserId);
    assertCanManageSchedule(family, actorUserId);

    const title = payload.title?.trim();
    const time = payload.time?.trim();

    if (!title) {
        throw new AppError("Title is required", 400);
    }
    if (!time) {
        throw new AppError("Time is required", 400);
    }

    const item = await CareSchedule.create({
        scheduleId: randomUUID(),
        familyId,
        recipientUserId,
        type: normalizeType(payload.type),
        title,
        time,
        dosage: payload.dosage?.trim() || undefined,
        instructions: payload.instructions?.trim() || undefined,
        daysOfWeek: Array.isArray(payload.daysOfWeek) ? payload.daysOfWeek : [],
        active: payload.active !== false,
        createdBy: actorUserId,
        updatedBy: actorUserId,
    });

    return serializeSchedule(item);
}

export async function updateCareSchedule(
    familyId: string,
    recipientUserId: string,
    scheduleId: string,
    actorUserId: string,
    payload: {
        type?: string;
        title?: string;
        time?: string;
        dosage?: string | null;
        instructions?: string | null;
        daysOfWeek?: number[];
        active?: boolean;
    },
) {
    const family = await getFamilyAndRecipient(familyId, recipientUserId);
    assertCanManageSchedule(family, actorUserId);

    const item = await CareSchedule.findOne({ scheduleId, familyId, recipientUserId });
    if (!item) {
        throw new AppError("Schedule item not found", 404);
    }

    if (payload.type !== undefined) {
        item.type = normalizeType(payload.type);
    }
    if (payload.title !== undefined) {
        const title = payload.title.trim();
        if (!title) throw new AppError("Title is required", 400);
        item.title = title;
    }
    if (payload.time !== undefined) {
        const time = payload.time.trim();
        if (!time) throw new AppError("Time is required", 400);
        item.time = time;
    }
    if (payload.dosage !== undefined) {
        item.dosage = payload.dosage?.trim() || undefined;
    }
    if (payload.instructions !== undefined) {
        item.instructions = payload.instructions?.trim() || undefined;
    }
    if (payload.daysOfWeek !== undefined) {
        item.daysOfWeek = payload.daysOfWeek;
    }
    if (payload.active !== undefined) {
        item.active = payload.active;
    }

    item.updatedBy = actorUserId;
    await item.save();

    return serializeSchedule(item);
}

export async function deleteCareSchedule(
    familyId: string,
    recipientUserId: string,
    scheduleId: string,
    actorUserId: string,
) {
    const family = await getFamilyAndRecipient(familyId, recipientUserId);
    assertCanManageSchedule(family, actorUserId);

    const result = await CareSchedule.deleteOne({ scheduleId, familyId, recipientUserId });
    if (result.deletedCount === 0) {
        throw new AppError("Schedule item not found", 404);
    }

    return { deleted: true };
}
