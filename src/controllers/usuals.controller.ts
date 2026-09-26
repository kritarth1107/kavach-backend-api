import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { assertFamilyMember } from "../services/family.service";
import { removeDecline, removeUsualItem, usualsSummary } from "../services/commerceAutomation/usuals/usuals.service";

async function member(familyId: string, userId: string): Promise<void> {
    await assertFamilyMember(familyId, userId).catch(() => {
        throw new AppError("Family not found or access denied", 403);
    });
}

/** Dashboard: what Saheli has learned about this elder's usuals (family members only). */
export async function getUsualsHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        await member(familyId, req.user.userId);
        res.json({ success: true, data: await usualsSummary({ familyId, recipientUserId }) });
    } catch (error) {
        next(error);
    }
}

/** Remove one usual item: DELETE …/saheli/usuals/items?name=…&partner=… */
export async function deleteUsualItemHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        await member(familyId, req.user.userId);
        const name = String(req.query.name ?? "").trim();
        const partner = String(req.query.partner ?? "").trim();
        if (!name || !partner) throw new AppError("name and partner are required", 400);
        const removed = await removeUsualItem({ familyId, recipientUserId }, name, partner);
        res.json({ success: true, data: { removed, usuals: await usualsSummary({ familyId, recipientUserId }) } });
    } catch (error) {
        next(error);
    }
}

/** Remove one recorded decline: DELETE …/saheli/usuals/declines?item=…&at=<ISO> */
export async function deleteUsualDeclineHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        await member(familyId, req.user.userId);
        const item = String(req.query.item ?? "").trim();
        const at = String(req.query.at ?? "").trim();
        if (!item || !at || Number.isNaN(new Date(at).getTime())) throw new AppError("item and at are required", 400);
        const removed = await removeDecline({ familyId, recipientUserId }, item, at);
        res.json({ success: true, data: { removed, usuals: await usualsSummary({ familyId, recipientUserId }) } });
    } catch (error) {
        next(error);
    }
}
