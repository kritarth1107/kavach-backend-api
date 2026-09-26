import { NextFunction, Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { assertFamilyMember } from "../services/family.service";
import { usualsSummary } from "../services/commerceAutomation/usuals/usuals.service";

/** Dashboard: what Saheli has learned about this elder's usuals (family members only). */
export async function getUsualsHandler(req: Request, res: Response, next: NextFunction) {
    try {
        if (!req.user) throw new AppError("Not authenticated", 401);
        const { familyId, recipientUserId } = req.params;
        await assertFamilyMember(familyId, req.user.userId);
        res.json({ success: true, data: await usualsSummary({ familyId, recipientUserId }) });
    } catch (error) {
        next(error);
    }
}
