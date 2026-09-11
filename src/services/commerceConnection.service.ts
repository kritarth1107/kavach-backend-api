import McpConnection from "../models/mcpConnection.model";
import Family from "../models/family.model";
import { getMcpConnectionStatus } from "../partners/mcp/mcpClient.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";

const CAREGIVER_ROLES = new Set<FamilyRole>([
    FamilyRole.PRIMARY_CAREGIVER,
    FamilyRole.CO_CAREGIVER,
]);

function isCaregiverRole(role: FamilyRole): boolean {
    return CAREGIVER_ROLES.has(role);
}

export async function resolveFamilyMcpUserId(
    familyId: string,
    partner: McpPartnerKey,
    preferredUserId?: string,
): Promise<string | null> {
    if (preferredUserId) {
        const preferred = await getMcpConnectionStatus(partner, familyId, preferredUserId);
        if (preferred.connected) return preferredUserId;
    }

    const family = await Family.findOne({ familyId, status: "ACTIVE" }).lean();
    if (!family) return null;

    const caregiverIds = new Set(
        family.members
            .filter(
                (m) =>
                    m.status === FamilyMemberStatus.JOINED && isCaregiverRole(m.role as FamilyRole),
            )
            .map((m) => m.userId),
    );

    const connections = await McpConnection.find({ familyId, partner })
        .sort({ connectedAt: -1 })
        .lean();

    for (const row of connections) {
        if (caregiverIds.has(row.userId)) return row.userId;
    }

    return connections[0]?.userId ?? null;
}

export async function listFamilyConnectedPartners(
    familyId: string,
    preferredUserId?: string,
): Promise<Record<McpPartnerKey, boolean>> {
    const partners: McpPartnerKey[] = ["swiggy", "instamart", "zepto"];
    const out = { swiggy: false, instamart: false, zepto: false } as Record<
        McpPartnerKey,
        boolean
    >;
    await Promise.all(
        partners.map(async (partner) => {
            const userId = await resolveFamilyMcpUserId(familyId, partner, preferredUserId);
            out[partner] = Boolean(
                userId && (await getMcpConnectionStatus(partner, familyId, userId)).connected,
            );
        }),
    );
    return out;
}
