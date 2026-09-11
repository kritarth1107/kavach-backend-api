import PartnerAddress from "../models/partnerAddress.model";
import { listMcpTools, syncPartnerAddressesFromMcp } from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";

export async function listPartnerAddresses(familyId: string, partner?: McpPartnerKey) {
    const query: Record<string, string> = { familyId };
    if (partner) query.partner = partner;
    const rows = await PartnerAddress.find(query).sort({ isDefault: -1, syncedAt: -1 }).lean();
    return rows.map((row) => ({
        address_id: row.addressId,
        partner: row.partner,
        partner_address_id: row.partnerAddressId,
        label: row.label ?? "",
        line1: row.line1,
        line2: row.line2 ?? "",
        city: row.city ?? "",
        pincode: row.pincode ?? "",
        is_default: row.isDefault,
        synced_at: row.syncedAt?.toISOString?.() ?? null,
    }));
}

export async function syncPartnerAddresses(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
): Promise<number> {
    const parsed = await syncPartnerAddressesFromMcp(partner, familyId, userId);
    if (!parsed.length) return 0;

    await PartnerAddress.deleteMany({ familyId, partner, userId });

    let inserted = 0;
    for (let i = 0; i < parsed.length; i += 1) {
        const row = parsed[i];
        await PartnerAddress.create({
            familyId,
            userId,
            partner,
            partnerAddressId: row.partnerAddressId,
            label: row.label,
            line1: row.line1,
            line2: row.line2,
            city: row.city,
            pincode: row.pincode,
            isDefault: i === 0,
            syncedAt: new Date(),
        });
        inserted += 1;
    }

    return inserted;
}

export async function getDefaultPartnerAddressId(
    familyId: string,
    partner: McpPartnerKey,
    userId: string,
): Promise<string | undefined> {
    const row = await PartnerAddress.findOne({ familyId, partner, userId, isDefault: true }).lean();
    if (row) return row.partnerAddressId;
    const any = await PartnerAddress.findOne({ familyId, partner, userId })
        .sort({ syncedAt: -1 })
        .lean();
    return any?.partnerAddressId;
}

export async function refreshPartnerAddressesInBackground(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
) {
    try {
        const count = await syncPartnerAddresses(partner, familyId, userId);
        console.log(`Synced ${count} ${partner} addresses for family ${familyId}`);
    } catch (err) {
        console.warn(`Address sync failed for ${partner}/${familyId}:`, err);
        try {
            const tools = await listMcpTools(partner, familyId, userId);
            console.warn(
                `${partner} MCP tools:`,
                tools.map((t) => t.name).join(", ") || "(none)",
            );
        } catch {
            // ignore secondary failure
        }
    }
}
