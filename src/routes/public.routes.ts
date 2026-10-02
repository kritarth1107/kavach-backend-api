/** Unauthenticated, read-only views reached by a secret link (e.g. the emergency card). */
import { NextFunction, Request, Response, Router } from "express";
import { publicEmergencyCard } from "../services/emergencyCard.service";

const router = Router();

router.get("/emergency/:token", (req: Request, res: Response, next: NextFunction) => {
    publicEmergencyCard(String(req.params.token))
        .then((data) => {
            res.setHeader("Cache-Control", "no-store");
            res.setHeader("X-Robots-Tag", "noindex");
            res.json({ success: true, data });
        })
        .catch(next);
});

export default router;
