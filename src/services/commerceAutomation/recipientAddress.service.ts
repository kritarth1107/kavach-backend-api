/**
 * Thin compatibility layer over the family address book (familyAddressBook.service).
 * Every caller gets the SAME resolver: named place → place confirmed for the current order
 * → member's default. Family-scoped; never global, never another family's, never a
 * store-account address. null → Saheli asks.
 */
import { pincodeOf, shortAddress } from "./kavachAddress";
import { resolveAddress, savePlaceFromChat, type ResolvedAddress } from "../familyAddressBook.service";

export type RecipientAddress = { full: string; short: string; pincode: string; nickname?: string; addressId?: string };

export async function getRecipientDeliveryAddress(
    familyId: string | undefined,
    recipientUserId: string | undefined,
    opts: { nickname?: string | null } = {},
): Promise<ResolvedAddress | null> {
    if (!familyId || !recipientUserId) return null;
    return resolveAddress({ familyId, memberUserId: recipientUserId, nickname: opts.nickname }).catch(() => null);
}

/** Saves a typed address into the family book (reuses a matching place). */
export async function saveRecipientDeliveryAddress(input: {
    familyId: string;
    recipientUserId: string;
    address: string;
    source: "elder_whatsapp" | "caregiver";
    setByUserId?: string;
    nickname?: string | null;
}): Promise<(RecipientAddress & { created: boolean }) | null> {
    const parsed = parseAddressReply(input.address);
    if (!parsed) return null;
    const r = await savePlaceFromChat({
        familyId: input.familyId,
        memberUserId: input.recipientUserId,
        address: parsed.full,
        actorUserId: input.setByUserId,
        nickname: input.nickname,
    });
    if (!r) return null;
    return { full: r.place.full, short: r.place.short, pincode: r.place.pincode, nickname: r.place.nickname, addressId: r.place.addressId, created: r.created };
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
