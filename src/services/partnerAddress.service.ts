import { randomUUID } from "crypto";
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

    const deduped = new Map<string, (typeof parsed)[number]>();
    for (const row of parsed) {
        const id = row.partnerAddressId?.trim();
        if (!id || deduped.has(id)) continue;
        deduped.set(id, row);
    }
    const rows = [...deduped.values()];
    if (!rows.length) return 0;

    const incomingIds = rows.map((r) => r.partnerAddressId);
    await PartnerAddress.deleteMany({
        familyId,
        partner,
        userId,
        partnerAddressId: { $nin: incomingIds },
    });

    let upserted = 0;
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        await PartnerAddress.findOneAndUpdate(
            { familyId, partner, partnerAddressId: row.partnerAddressId },
            {
                $set: {
                    userId,
                    label: row.label,
                    line1: row.line1,
                    line2: row.line2,
                    city: row.city,
                    pincode: row.pincode,
                    isDefault: i === 0,
                    syncedAt: new Date(),
                },
                $setOnInsert: {
                    addressId: randomUUID(),
                },
            },
            { upsert: true },
        );
        upserted += 1;
    }

    return upserted;
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

/** Pull latest addresses from partner MCP before order/search flows. */
export async function ensurePartnerAddressesSynced(
    partner: McpPartnerKey,
    familyId: string,
    userId: string,
): Promise<number> {
    try {
        return await syncPartnerAddresses(partner, familyId, userId);
    } catch (err) {
        console.warn(`Blocking address sync failed for ${partner}/${familyId}:`, err);
        return 0;
    }
}
