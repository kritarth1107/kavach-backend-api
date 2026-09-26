/**
 * Delivery address for Saheli commerce = the family address book resolver (named place →
 * place confirmed for this order → member's default). No global / smoke / store-account
 * fallback: null means "ask the elder for their address".
 */
import { getRecipientDeliveryAddress } from "./recipientAddress.service";

export async function resolveDeliveryAddressLabel(input: {
    familyId?: string;
    /** Care recipient (NOT the acting caregiver). */
    recipientUserId?: string;
    partner?: string;
    nickname?: string | null;
}): Promise<{ label: string; source: "recipient"; nickname: string; addressId: string } | null> {
    const a = await getRecipientDeliveryAddress(input.familyId, input.recipientUserId, { nickname: input.nickname });
    return a ? { label: a.full, source: "recipient", nickname: a.nickname, addressId: a.addressId } : null;
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
