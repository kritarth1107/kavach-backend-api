import { Request, Response } from "express";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor, requirePermission } from "../services/careRecordAuth.service";
import {
    completeZeptoConnect,
    disconnectZepto,
    getZeptoConnectionStatus,
    startZeptoConnect,
} from "../partners/zepto/mcpClient.service";
import { getZeptoRedirectUri } from "../partners/zepto/config";

export async function getZeptoConnectHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");

    const result = await startZeptoConnect(familyId, actorUserId);
    res.json({ success: true, data: result });
}

export async function getZeptoStatusHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    await getFamilyForActor(familyId, actorUserId);
    const status = await getZeptoConnectionStatus(familyId, actorUserId);
    res.json({
        success: true,
        data: {
            ...status,
            redirectUri: getZeptoRedirectUri(),
            mcpUrl: process.env.ZEPTO_MCP_URL || "https://mcp.zepto.co.in/mcp",
        },
    });
}

export async function deleteZeptoConnectHandler(req: Request, res: Response) {
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");
    const result = await disconnectZepto(familyId, actorUserId);
    res.json({ success: true, data: result });
}

export async function getZeptoOAuthCallbackHandler(req: Request, res: Response) {
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const error = req.query.error ? String(req.query.error) : null;

    const frontend = config.server.liveFrontendUrl.replace(/\/$/, "");

    if (error) {
        res.redirect(`${frontend}/dashboard/integrations?zepto=error&message=${encodeURIComponent(error)}`);
        return;
    }

    if (!code || !state) {
        res.redirect(`${frontend}/dashboard/integrations?zepto=error&message=missing_code`);
        return;
    }

    try {
        await completeZeptoConnect(code, state);
        res.redirect(`${frontend}/dashboard/integrations?zepto=connected`);
    } catch (err) {
        const message = err instanceof Error ? err.message : "oauth_failed";
        res.redirect(
            `${frontend}/dashboard/integrations?zepto=error&message=${encodeURIComponent(message)}`,
        );
    }
}

export async function postZeptoOAuthCallbackHandler(req: Request, res: Response) {
    const code = String(req.body?.code ?? req.query.code ?? "");
    const state = String(req.body?.state ?? req.query.state ?? "");
    if (!code || !state) {
        throw new AppError("Missing OAuth code or state", 400);
    }
    const result = await completeZeptoConnect(code, state);
    res.json({ success: true, data: result });
}
