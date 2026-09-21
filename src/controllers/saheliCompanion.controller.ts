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
import {
    deliverSaheliOutreach,
    listFamilyMemoriesForRecipient,
} from "../services/saheliOutreach.service";
import { refreshRecipientMemoryToAiEngine } from "../services/saheliMemorySync.service";
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

export async function forgetFamilyMemory(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId, factId } = req.params;
        const actorUserId = req.user!.userId;
        await ensureRecipientInFamily(familyId, recipientUserId);
        const family = await Family.findOne({ familyId, status: "ACTIVE" });
        assertCaregiverAccess(family, actorUserId);

        const { aiForgetMemory } = await import("../clients/aiEngine.client");
        const result = await aiForgetMemory({ factId, forgottenBy: actorUserId });
        res.json({ data: result });
    } catch (err) {
        next(err);
    }
}

export async function correctFamilyMemory(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId, factId } = req.params;
        const actorUserId = req.user!.userId;
        await ensureRecipientInFamily(familyId, recipientUserId);
        const family = await Family.findOne({ familyId, status: "ACTIVE" });
        assertCaregiverAccess(family, actorUserId);

        const replacement = String(req.body?.replacementContent ?? "").trim();
        if (replacement.length < 4) {
            throw new AppError("replacementContent is required (min 4 chars)", 400);
        }

        const { aiCorrectMemory } = await import("../clients/aiEngine.client");
        const result = await aiCorrectMemory({
            factId,
            replacementContent: replacement,
            actorUserId,
            sourceRole: "family",
        });
        res.json({ data: result });
    } catch (err) {
        next(err);
    }
}

export async function getSaheliMemoryProfile(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        const membersPayload = await getFamilyMembersList(familyId, actorUserId);
        const displayName =
            membersPayload.members.find((m) => m.userId === recipientUserId)?.name?.trim() ||
            "Care recipient";
        const { ensureAiContext } = await import("../services/aiTenant.service");
        const { aiGetMemoryProfile, aiGrepMemory } = await import("../clients/aiEngine.client");
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const [profile, grep] = await Promise.all([
            aiGetMemoryProfile({ aiFamilyId: ctx.aiFamilyId, aiElderId: ctx.aiElderId }),
            aiGrepMemory({
                aiFamilyId: ctx.aiFamilyId,
                aiElderId: ctx.aiElderId,
                query: "health medicine person preference",
                limit: 10,
            }),
        ]);
        res.json({ data: { profile_md: profile.profile_md, entities: grep.hits } });
    } catch (err) {
        next(err);
    }
}

export async function getSaheliMemoryEntity(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId, slug } = req.params;
        const actorUserId = req.user!.userId;
        const membersPayload = await getFamilyMembersList(familyId, actorUserId);
        const displayName =
            membersPayload.members.find((m) => m.userId === recipientUserId)?.name?.trim() ||
            "Care recipient";
        const { ensureAiContext } = await import("../services/aiTenant.service");
        const { aiGetMemoryEntity } = await import("../clients/aiEngine.client");
        const ctx = await ensureAiContext(familyId, recipientUserId, displayName);
        const result = await aiGetMemoryEntity({
            aiFamilyId: ctx.aiFamilyId,
            aiElderId: ctx.aiElderId,
            slug,
        });
        res.json({ data: result.entity });
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

export async function postSaheliMemoryRefreshHandler(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    try {
        const { familyId, recipientUserId } = req.params;
        const actorUserId = req.user!.userId;
        await ensureRecipientInFamily(familyId, recipientUserId);
        const membersPayload = await getFamilyMembersList(familyId, actorUserId);
        const displayName =
            membersPayload.members.find((m) => m.userId === recipientUserId)?.fullName?.trim() ||
            membersPayload.members.find((m) => m.userId === recipientUserId)?.name?.trim() ||
            "Care recipient";
        const sessionId = req.body?.sessionId ? String(req.body.sessionId) : undefined;
        await refreshRecipientMemoryToAiEngine({
            familyId,
            recipientUserId,
            displayName,
            sessionId,
        });
        res.json({ success: true });
    } catch (err) {
        next(err);
    }
}
