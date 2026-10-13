import { Request, Response, NextFunction } from "express";
import Family from "../models/family.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyRole } from "../types/family.types";
import {
    getCompanionProfile,
    serializeCompanionForApi,
    updateCompanionProfile,
    ensureRecipientInFamily,
} from "../services/saheliCompanion.service";
import { getFamilyMembersList } from "../services/familyMember.service";

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
        res.json({ data: serializeCompanionForApi(profile) });
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
        res.json({ data: serializeCompanionForApi(profile) });
    } catch (err) {
        next(err);
    }
}

export async function getCompanionActivity(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        await ensureRecipientInFamily(familyId, recipientUserId);
        const family = await Family.findOne({ familyId, status: "ACTIVE" });
        assertCaregiverAccess(family, actorUserId);

        const SaheliNudgeLog = (await import("../models/saheliNudgeLog.model")).default;
        const { listRecentEscalations } = await import("../services/saheliEmergency.service");

        const [nudges, escalations] = await Promise.all([
            SaheliNudgeLog.find({ familyId, recipientUserId })
                .sort({ createdAt: -1 })
                .limit(20)
                .lean(),
            listRecentEscalations(familyId, recipientUserId, 10),
        ]);

        res.json({
            data: {
                nudges: nudges.map((n) => ({
                    nudgeKind: n.nudgeKind,
                    messagePreview: n.messagePreview,
                    delivered: n.delivered,
                    channel: n.channel,
                    reason: n.reason ?? null,
                    doseStatus: n.delivered ? "sent" : n.terminal || n.reason === "no_valid_recipient" ? "skipped" : "failed",
                    // WhatsApp's own receipt (trust plan B1.3): sent ✓, delivered ✓✓ (on the phone), read (blue ✓✓), failed
                    delivery: n.deliveryStatus ?? (n.delivered ? "sent" : null),
                    deliveredAt: n.deliveredAt?.toISOString?.() ?? null,
                    readAt: n.readAt?.toISOString?.() ?? null,
                    createdAt: n.createdAt?.toISOString?.() ?? null,
                })),
                escalations: escalations.map((e) => ({
                    message: e.message,
                    caregiversNotified: e.caregiversNotified,
                    createdAt: e.createdAt?.toISOString?.() ?? null,
                })),
            },
        });
    } catch (err) {
        next(err);
    }
}
