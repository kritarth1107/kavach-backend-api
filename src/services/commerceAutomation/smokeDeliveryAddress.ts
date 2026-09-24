/**
 * Default delivery address for Saheli commerce smoke / when elder has none saved.
 * Still confirm-before-pay — never silent place.
 */
import { listPartnerAddresses } from "../partnerAddress.service";
import type { McpPartnerKey } from "../../partners/mcp/types";

/** Raipur smoke address (user-provided for 2026-09-25+ live smoke). */
export const SMOKE_DEFAULT_DELIVERY_ADDRESS =
    "C504, SUNITA PARK, LABHANDIH, NEAR TULIP AREA HOTEL, RAIPUR, CHHATTISGARH, 492001";

export const SMOKE_DEFAULT_DELIVERY_SHORT = "C504 Sunita Park, Labhandih, Raipur 492001";

/**
 * Prefer a saved partner/MCP address label; else the smoke default.
 * Never invent a different street — either saved or this constant.
 */
export async function resolveDeliveryAddressLabel(input: {
    familyId?: string;
    userId?: string;
    partner?: string;
}): Promise<{ label: string; source: "saved" | "smoke_default" }> {
    const familyId = input.familyId?.trim();
    const userId = input.userId?.trim();
    const partner = String(input.partner || "").toLowerCase();
    if (familyId && userId && (partner === "zepto" || partner === "swiggy" || partner === "instamart")) {
        try {
            const rows = await listPartnerAddresses(familyId, partner as McpPartnerKey, userId);
            const preferred = rows.find((r) => r.is_default) || rows[0];
            if (preferred) {
                const parts = [
                    preferred.label,
                    preferred.line1,
                    preferred.line2,
                    preferred.city,
                    preferred.pincode,
                ]
                    .map((s) => String(s || "").trim())
                    .filter(Boolean);
                const label = parts.join(", ").slice(0, 220);
                if (label.length >= 8) return { label, source: "saved" };
            }
        } catch {
            /* fall through to smoke default */
        }
    }
    return { label: SMOKE_DEFAULT_DELIVERY_ADDRESS, source: "smoke_default" };
}

/** Embed into browser goal so Gemini/playbook can fill address fields. */
export function appendDeliveryAddressToGoal(goal: string, addressLabel: string): string {
    const clean = goal.replace(/\|\s*delivery_address=[^|]*/gi, " ").replace(/\s+/g, " ").trim();
    const addr = addressLabel.replace(/\s+/g, " ").trim().slice(0, 220);
    if (!addr) return clean.slice(0, 240);
    if (/delivery_address=/i.test(clean)) return clean.slice(0, 280);
    return `${clean} | delivery_address=${addr}`.slice(0, 320);
}

export function extractDeliveryAddressFromGoal(goal: string): string | undefined {
    const m = goal.match(/delivery_address=([^|]+)/i);
    const v = m?.[1]?.trim();
    return v && v.length >= 8 ? v.slice(0, 220) : undefined;
}
