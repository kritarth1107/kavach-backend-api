import { Request, Response, NextFunction } from "express";
import Family from "../models/family.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyRole } from "../types/family.types";
import {
    getCompanionProfile,
    updateCompanionProfile,
    ensureRecipientInFamily,
} from "../services/saheliCompanion.service";
import {
    deliverSaheliOutreach,
    listFamilyMemoriesForRecipient,
} from "../services/saheliOutreach.service";

function assertCaregiverAccess(
    family: InstanceType<typeof Family> | null,
    actorUserId: string,
) {
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }
    const actor = family.members.find((m) => m.userId === actorUserId);
    if (
        !actor ||
        (actor.role !== FamilyRole.PRIMARY_CAREGIVER && actor.role !== FamilyRole.CO_CAREGIVER)
    ) {
        throw new AppError("Only caregivers can manage Saheli companion", 403);
    }
}

export async function getCompanionSettings(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        const family = await ensureRecipientInFamily(familyId, recipientUserId);
        void family;
        const profile = await getCompanionProfile(familyId, recipientUserId);
        res.json({ data: profile });
    } catch (err) {
        next(err);
    }
}

export async function patchCompanionSettings(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        const profile = await updateCompanionProfile(
            familyId,
            recipientUserId,
            actorUserId,
            req.body,
        );
        res.json({ data: profile });
    } catch (err) {
        next(err);
    }
}

export async function triggerOutreach(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        const family = await Family.findOne({ familyId, status: "ACTIVE" });
        assertCaregiverAccess(family, actorUserId);
        await ensureRecipientInFamily(familyId, recipientUserId);
        const result = await deliverSaheliOutreach({
            familyId,
            recipientUserId,
            force: true,
            outreachKind: req.body?.outreachKind ?? "casual",
        });
        res.json({ data: result });
    } catch (err) {
        next(err);
    }
}

export async function getFamilyMemories(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        const data = await listFamilyMemoriesForRecipient(
            familyId,
            recipientUserId,
            actorUserId,
        );
        res.json({ data });
    } catch (err) {
        next(err);
    }
}
