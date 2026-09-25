/**
 * Default delivery address for Saheli commerce smoke / when elder has none saved.
 * Still confirm-before-pay — never silent place.
 */
import { KAVACH_DELIVERY_ADDRESS } from "./kavachAddress";

/** Raipur smoke address (user-provided for 2026-09-25+ live smoke). */
export const SMOKE_DEFAULT_DELIVERY_ADDRESS = KAVACH_DELIVERY_ADDRESS;

export const SMOKE_DEFAULT_DELIVERY_SHORT = "C504 Sunita Park, Labhandih, Raipur 492001";

/**
 * Delivery address for every partner = the care recipient's saved Kavach address.
 * Store-account / MCP saved addresses are never used or displayed (they can point at a
 * different city — e.g. a Gurugram Swiggy default).
 */
export async function resolveDeliveryAddressLabel(_input: {
    familyId?: string;
    userId?: string;
    partner?: string;
}): Promise<{ label: string; source: "kavach" }> {
    return { label: KAVACH_DELIVERY_ADDRESS, source: "kavach" };
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
