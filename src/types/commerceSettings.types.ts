import type { McpPartnerKey } from "../partners/mcp/types";

export type PartnerOrderSettings = {
    /** When false (default), all care-recipient orders need caregiver approval. */
    allowRecipientDirectOrders: boolean;
    /** Orders above this amount (in paise) need approval even when direct ordering is on. Null = no limit. */
    approvalThresholdPaise: number | null;
};

export type FamilyCommerceSettings = {
    familyId: string;
    swiggy: PartnerOrderSettings;
    instamart: PartnerOrderSettings;
    zepto: PartnerOrderSettings;
};

export const DEFAULT_PARTNER_ORDER_SETTINGS: PartnerOrderSettings = {
    allowRecipientDirectOrders: false,
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
