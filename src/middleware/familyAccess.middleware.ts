import { NextFunction, Request, Response } from "express";
import Family from "../models/family.model";
import { protect } from "./auth.middleware";

// First path segments under /api/families that are not a family id.
const NOT_A_FAMILY = new Set(["", "active", "primary", "switcher", "invitations"]);

/**
 * Every /api/families/<familyId>/… request must come from a signed-in, joined member of that family.
 *
 * The world route test (plan B1.4, 2026-10-13) found routes that checked only that the person cared for belongs to the
 * family, so anyone signed in could read another family's companion settings. One guard for all family routes means a
 * new route cannot forget it; each route still checks the role it needs (caregiver, primary caregiver).
 */
export function familyAccess(req: Request, res: Response, next: NextFunction): void {
    const familyId = req.params.familyId;
    if (!familyId || NOT_A_FAMILY.has(familyId)) {
        next();
        return;
    }
    void protect(req, res, (err?: unknown) => {
        if (err) {
            next(err);
            return;
        }
        Family.findOne({ familyId })
            .select("familyId members")
            .then((family) => {
                if (!family || !req.user || !family.hasJoinedMember(req.user.userId)) {
                    res.status(403).json({ success: false, message: "Family not found or access denied" });
                    return;
                }
                next();
            })
            .catch(next);
    });
}
