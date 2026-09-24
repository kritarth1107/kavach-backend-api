import { AppError } from "../middleware/error.middleware";
import FamilyCommerceSettingsModel from "../models/familyCommerceSettings.model";
import type { McpPartnerKey } from "../partners/mcp/types";
import { FamilyRole } from "../types/family.types";
import { roleHasPermission } from "../types/careRecord.types";
import {
    DEFAULT_PARTNER_ORDER_SETTINGS,
    defaultFamilyCommerceSettings,
    partnerKeyToSettingsField,
    type FamilyCommerceSettings,
    type PartnerOrderSettings,
} from "../types/commerceSettings.types";
import { getFamilyForActor, requirePermission } from "./careRecordAuth.service";

function normalizePartnerSettings(raw?: Partial<PartnerOrderSettings> | null): PartnerOrderSettings {
    return {
        allowRecipientDirectOrders:
            raw?.allowRecipientDirectOrders ?? DEFAULT_PARTNER_ORDER_SETTINGS.allowRecipientDirectOrders,
        approvalThresholdPaise:
            raw?.approvalThresholdPaise === undefined
                ? DEFAULT_PARTNER_ORDER_SETTINGS.approvalThresholdPaise
                : raw.approvalThresholdPaise,
    };
}

export async function getFamilyCommerceSettings(familyId: string): Promise<FamilyCommerceSettings> {
    const row = await FamilyCommerceSettingsModel.findOne({ familyId }).lean();
    if (!row) return defaultFamilyCommerceSettings(familyId);

    return {
        familyId,
        swiggy: normalizePartnerSettings(row.swiggy),
        instamart: normalizePartnerSettings(row.instamart),
        zepto: normalizePartnerSettings(row.zepto),
    };
}

export async function getPartnerOrderSettings(
    familyId: string,
    partner: McpPartnerKey,
): Promise<PartnerOrderSettings> {
    const settings = await getFamilyCommerceSettings(familyId);
    return settings[partnerKeyToSettingsField(partner)];
}

export function orderRequiresCaregiverApproval(input: {
    actorRole: FamilyRole | null;
    totalPaise: number;
    settings: PartnerOrderSettings;
}): boolean {
    // Instinct parity: CARE_RECIPIENT orders from their own WhatsApp/number — never gate on
    // caregiver approval. Caregivers receive notify-only (see orderOrchestrator submit path).
    if (input.actorRole === FamilyRole.CARE_RECIPIENT) {
        return false;
    }

    if (input.actorRole && roleHasPermission(input.actorRole, "approve_order")) {
        return false;
    }

    if (!input.settings.allowRecipientDirectOrders) {
        return true;
    }

    if (
        input.settings.approvalThresholdPaise != null &&
        input.totalPaise > input.settings.approvalThresholdPaise
    ) {
        return true;
    }

    return false;
}

export async function updatePartnerOrderSettings(input: {
    familyId: string;
    partner: McpPartnerKey;
    actorUserId: string;
    patch: Partial<PartnerOrderSettings>;
}): Promise<PartnerOrderSettings> {
    const family = await getFamilyForActor(input.familyId, input.actorUserId);
    requirePermission(family, input.actorUserId, "approve_order");

    const field = partnerKeyToSettingsField(input.partner);
    const current = await getFamilyCommerceSettings(input.familyId);
    const next: PartnerOrderSettings = {
        ...current[field],
        ...input.patch,
    };

    if (
        next.approvalThresholdPaise != null &&
        (!Number.isFinite(next.approvalThresholdPaise) || next.approvalThresholdPaise < 0)
    ) {
        throw new AppError("Approval threshold must be a positive amount", 400);
    }

    await FamilyCommerceSettingsModel.findOneAndUpdate(
        { familyId: input.familyId },
        {
            $set: {
                [`${field}.allowRecipientDirectOrders`]: next.allowRecipientDirectOrders,
                [`${field}.approvalThresholdPaise`]: next.approvalThresholdPaise,
            },
            $setOnInsert: {
                familyId: input.familyId,
                swiggy: defaultFamilyCommerceSettings(input.familyId).swiggy,
                instamart: defaultFamilyCommerceSettings(input.familyId).instamart,
                zepto: defaultFamilyCommerceSettings(input.familyId).zepto,
            },
        },
        { upsert: true, new: true },
    );

    return next;
}
