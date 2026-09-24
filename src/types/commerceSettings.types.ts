import type { McpPartnerKey } from "../partners/mcp/types";

export type PartnerOrderSettings = {
    /**
     * Instinct parity (default true): care recipients order from their own WhatsApp.
     * Caregivers are notified only — never parked in awaiting_approval for normal groceries.
     * Toggle kept for family preference / legacy dashboard messaging.
     */
    allowRecipientDirectOrders: boolean;
    /** Soft hint for large baskets (paise). Null = no limit. Elders still place; caregivers notified. */
    approvalThresholdPaise: number | null;
};

export type FamilyCommerceSettings = {
    familyId: string;
    swiggy: PartnerOrderSettings;
    instamart: PartnerOrderSettings;
    zepto: PartnerOrderSettings;
};

export const DEFAULT_PARTNER_ORDER_SETTINGS: PartnerOrderSettings = {
    allowRecipientDirectOrders: true,
    approvalThresholdPaise: null,
};

export function defaultFamilyCommerceSettings(familyId: string): FamilyCommerceSettings {
    return {
        familyId,
        swiggy: { ...DEFAULT_PARTNER_ORDER_SETTINGS },
        instamart: { ...DEFAULT_PARTNER_ORDER_SETTINGS },
        zepto: { ...DEFAULT_PARTNER_ORDER_SETTINGS },
    };
}

export function partnerKeyToSettingsField(
    partner: McpPartnerKey,
): keyof Pick<FamilyCommerceSettings, "swiggy" | "instamart" | "zepto"> {
    return partner;
}
