import ElderPartnerAddress from "../models/elderPartnerAddress.model";
import type { McpPartnerKey } from "../partners/mcp/types";

export async function getLastSuccessfulAddress(
    familyId: string,
    recipientUserId: string,
    partner: McpPartnerKey,
): Promise<{
    addressId: string;
    label?: string;
    line1?: string;
} | null> {
    const row = await ElderPartnerAddress.findOne({
        familyId,
        recipientUserId,
        partner,
    }).lean();

    if (!row) return null;

    return {
        addressId: row.lastSuccessfulAddressId,
        label: row.addressLabel,
        line1: row.addressLine1,
    };
}

export async function recordSuccessfulAddress(input: {
    familyId: string;
    recipientUserId: string;
    partner: McpPartnerKey;
    addressId: string;
    addressLabel?: string;
    addressLine1?: string;
}): Promise<void> {
    await ElderPartnerAddress.findOneAndUpdate(
        {
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            partner: input.partner,
        },
        {
            $set: {
                lastSuccessfulAddressId: input.addressId,
                addressLabel: input.addressLabel,
                addressLine1: input.addressLine1,
                lastUsedAt: new Date(),
            },
            $inc: { successCount: 1 },
        },
        { upsert: true },
    );
}

export async function clearSuccessfulAddress(
    familyId: string,
    recipientUserId: string,
    partner: McpPartnerKey,
): Promise<void> {
    await ElderPartnerAddress.deleteOne({
        familyId,
        recipientUserId,
        partner,
    });
}
