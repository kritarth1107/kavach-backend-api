import { Request, Response } from "express";
import { placeCodOrderFromPreview } from "../services/orderAgent.service";

export async function postPlaceCodOrderHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const previewId = String(req.body?.previewId ?? "");
    if (!previewId) {
        res.status(400).json({ success: false, message: "previewId is required" });
        return;
    }

    const result = await placeCodOrderFromPreview({
        familyId,
        previewId,
        actorUserId: req.user!.userId,
    });

    res.json({ success: true, data: result });
}
