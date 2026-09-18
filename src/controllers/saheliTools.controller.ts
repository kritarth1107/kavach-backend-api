import { Request, Response } from "express";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";
import { executeSaheliTool, type SaheliToolName } from "../services/saheliTools.service";

function verifyInternalSecret(req: Request) {
    const secret = req.header("X-Kavach-Secret");
    if (!secret || secret !== config.aiEngine.apiSecret) {
        throw new AppError("Unauthorized", 401);
    }
}

export async function executeTool(req: Request, res: Response) {
    verifyInternalSecret(req);
    const { tool, args, family_id, recipient_user_id, actor_user_id } = req.body ?? {};
    if (!tool || !family_id || !recipient_user_id || !actor_user_id) {
        throw new AppError("tool, family_id, recipient_user_id, actor_user_id required", 400);
    }
    const result = await executeSaheliTool({
        tool: tool as SaheliToolName,
        args: (args ?? {}) as Record<string, unknown>,
        familyId: String(family_id),
        recipientUserId: String(recipient_user_id),
        actorUserId: String(actor_user_id),
    });
    res.json({ ok: true, result });
}
