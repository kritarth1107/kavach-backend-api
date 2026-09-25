/**
 * Per-care-recipient delivery address. Scoped by (familyId, recipientUserId) — never global,
 * never another family's, never a store-account address. No address → Saheli asks the elder.
 */
import RecipientDeliveryAddress from "../../models/recipientDeliveryAddress.model";
import { pincodeOf, shortAddress } from "./kavachAddress";

export type RecipientAddress = { full: string; short: string; pincode: string };

export async function getRecipientDeliveryAddress(
    familyId: string | undefined,
    recipientUserId: string | undefined,
): Promise<RecipientAddress | null> {
    if (!familyId || !recipientUserId) return null;
    const row = await RecipientDeliveryAddress.findOne({ familyId, recipientUserId }).lean().catch(() => null);
    if (!row?.address || !row.pincode) return null;
    return { full: row.address, short: shortAddress(row.address), pincode: row.pincode };
}

export async function saveRecipientDeliveryAddress(input: {
    familyId: string;
    recipientUserId: string;
    address: string;
    source: "elder_whatsapp" | "caregiver";
    setByUserId?: string;
}): Promise<RecipientAddress | null> {
    const parsed = parseAddressReply(input.address);
    if (!parsed) return null;
    await RecipientDeliveryAddress.findOneAndUpdate(
        { familyId: input.familyId, recipientUserId: input.recipientUserId },
        { $set: { address: parsed.full, pincode: parsed.pincode, source: input.source, setByUserId: input.setByUserId } },
        { upsert: true },
    );
    return parsed;
}

/** A usable delivery address typed by the elder: some street text + a 6-digit Indian pincode. */
export function parseAddressReply(text: string): RecipientAddress | null {
    const full = String(text || "")
        .replace(/^(?:my\s+)?(?:delivery\s+|home\s+)?address\s*(?:is|:|-)?\s*/i, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
    const pincode = pincodeOf(full);
    if (!pincode) return null;
    const letters = full.replace(/\b\d{6}\b/, "").replace(/[^a-z]/gi, "");
    if (letters.length < 8) return null;
    return { full, short: shortAddress(full), pincode };
}
