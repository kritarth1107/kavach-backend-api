import { Request, Response } from "express";
import { AppError } from "../middleware/error.middleware";
import { isMcpPartnerKey, type McpPartnerKey } from "../partners/mcp/types";
import { getPartnerIntegrationDetail } from "../services/integrationPartner.service";
import {
    getPartnerOrderSettings,
    updatePartnerOrderSettings,
} from "../services/commerceSettings.service";

function parsePartner(value: string): McpPartnerKey {
    if (!isMcpPartnerKey(value)) {
        throw new AppError(`Unknown partner: ${value}`, 400);
    }
    return value;
}

export async function getPartnerIntegrationDetailHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const { familyId } = req.params;
    const data = await getPartnerIntegrationDetail(familyId, partner, req.user!.userId);
    res.json({ success: true, data });
}

export async function getPartnerOrderSettingsHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const { familyId } = req.params;
    const settings = await getPartnerOrderSettings(familyId, partner);
    res.json({ success: true, data: settings });
}

export async function patchPartnerOrderSettingsHandler(req: Request, res: Response) {
    const partner = parsePartner(req.params.partner);
    const { familyId } = req.params;
    const body = req.body ?? {};

    const patch: {
        allowRecipientDirectOrders?: boolean;
        approvalThresholdPaise?: number | null;
    } = {};

    if (typeof body.allowRecipientDirectOrders === "boolean") {
        patch.allowRecipientDirectOrders = body.allowRecipientDirectOrders;
    }

    if (body.approvalThresholdPaise === null) {
        patch.approvalThresholdPaise = null;
    } else if (body.approvalThresholdRupees != null) {
        const rupees = Number(body.approvalThresholdRupees);
        patch.approvalThresholdPaise = Number.isFinite(rupees) ? Math.round(rupees * 100) : null;
    } else if (body.approvalThresholdPaise != null) {
        patch.approvalThresholdPaise = Number(body.approvalThresholdPaise);
    }

    const settings = await updatePartnerOrderSettings({
        familyId,
        partner,
        actorUserId: req.user!.userId,
        patch,
    });

    res.json({ success: true, data: settings });
}
