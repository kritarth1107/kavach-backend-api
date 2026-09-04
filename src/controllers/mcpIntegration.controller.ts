import { Request, Response } from "express";
import config from "../config/app.config";
import { AppError } from "../middleware/error.middleware";
import { getFamilyForActor, requirePermission } from "../services/careRecordAuth.service";
import {
    completeMcpConnect,
    disconnectMcp,
    getMcpConnectionStatus,
    startMcpConnect,
} from "../partners/mcp/mcpClient.service";
import { getMcpPartner } from "../partners/mcp/partners";
import { isMcpPartnerKey, type McpPartnerKey } from "../partners/mcp/types";

function parsePartner(value: string): McpPartnerKey {
    if (!isMcpPartnerKey(value)) {
        throw new AppError(`Unknown MCP partner: ${value}`, 400);
    }
    return value;
}

export async function getMcpConnectHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");

    const result = await startMcpConnect(partner, familyId, actorUserId);
    res.json({ success: true, data: result });
}

export async function getMcpStatusHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    await getFamilyForActor(familyId, actorUserId);
    const status = await getMcpConnectionStatus(partner, familyId, actorUserId);
    const partnerConfig = getMcpPartner(partner);
    res.json({
        success: true,
        data: {
            ...status,
            redirectUri: partnerConfig.getRedirectUri(),
            mcpUrl: partnerConfig.mcpUrl,
            label: partnerConfig.label,
        },
    });
}

export async function deleteMcpConnectHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const { familyId } = req.params;
    const actorUserId = req.user!.userId;
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");
    const result = await disconnectMcp(partner, familyId, actorUserId);
    res.json({ success: true, data: result });
}

export async function getMcpOAuthCallbackHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const code = String(req.query.code ?? "");
    const state = String(req.query.state ?? "");
    const error = req.query.error ? String(req.query.error) : null;

    const frontend = config.server.liveFrontendUrl.replace(/\/$/, "");

    if (error) {
        res.redirect(
            `${frontend}/dashboard/integrations?${partner}=error&message=${encodeURIComponent(error)}`,
        );
        return;
    }

    if (!code || !state) {
        res.redirect(`${frontend}/dashboard/integrations?${partner}=error&message=missing_code`);
        return;
    }

    try {
        await completeMcpConnect(code, state);
        res.redirect(`${frontend}/dashboard/integrations?${partner}=connected`);
    } catch (err) {
        const message = err instanceof Error ? err.message : "oauth_failed";
        res.redirect(
            `${frontend}/dashboard/integrations?${partner}=error&message=${encodeURIComponent(message)}`,
        );
    }
}

export async function postMcpOAuthCallbackHandler(req: Request, res: Response) {
    parsePartner(req.params.partner);
    const code = String(req.body?.code ?? req.query.code ?? "");
    const state = String(req.body?.state ?? req.query.state ?? "");
    if (!code || !state) {
        throw new AppError("Missing OAuth code or state", 400);
    }
    const result = await completeMcpConnect(code, state);
    res.json({ success: true, data: result });
}
