/**
 * Delivery address for Saheli commerce = the current care recipient's OWN saved address
 * (recipient_delivery_addresses, scoped by familyId + recipientUserId). No global / smoke /
 * store-account fallback: null means "ask the elder for their address".
 */
import { getRecipientDeliveryAddress } from "./recipientAddress.service";

export async function resolveDeliveryAddressLabel(input: {
    familyId?: string;
    /** Care recipient (NOT the acting caregiver). */
    recipientUserId?: string;
    partner?: string;
}): Promise<{ label: string; source: "recipient" } | null> {
    const a = await getRecipientDeliveryAddress(input.familyId, input.recipientUserId);
    return a ? { label: a.full, source: "recipient" } : null;
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
