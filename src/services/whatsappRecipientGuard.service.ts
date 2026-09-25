import { INTERNAL_PHONE_COUNTRY_CODE } from "../utils/phone.util";

/**
 * Internal placeholder phones ("+99" + random 10 digits, see buildCosmosSafePhonePlaceholder)
 * must never be used as a WhatsApp destination. They surface as 12-digit "99…" numbers once
 * country code + number are concatenated, which is indistinguishable by shape from a few real
 * Central-Asian numbers (+992/+994/+995/+996/+998), so ambiguous cases are confirmed in the DB.
 */
export class WhatsAppPlaceholderRecipientError extends Error {
    readonly code = "WHATSAPP_PLACEHOLDER_RECIPIENT";
    constructor(to: string) {
        super(`Refusing WhatsApp send to internal placeholder number (…${to.replace(/\D/g, "").slice(-4)})`);
        this.name = "WhatsAppPlaceholderRecipientError";
    }
}

export function isWhatsAppPlaceholderRecipientError(
    err: unknown,
): err is WhatsAppPlaceholderRecipientError {
    return (
        err instanceof WhatsAppPlaceholderRecipientError ||
        (typeof err === "object" &&
            err !== null &&
            (err as { code?: string }).code === "WHATSAPP_PLACEHOLDER_RECIPIENT")
    );
}

const PLACEHOLDER_CC_DIGITS = INTERNAL_PHONE_COUNTRY_CODE.replace(/\D/g, ""); // "99"

/** Shape-only check: could this E.164 be an internal "+99" + 10-digit placeholder? */
export function couldBePlaceholderNumber(raw: string | undefined | null): boolean {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return digits.length === 12 && digits.startsWith(PLACEHOLDER_CC_DIGITS);
}

/** "+999…" is an unassigned ITU code — always a placeholder when shaped like one. */
export function isDefinitelyPlaceholderNumber(raw: string | undefined | null): boolean {
    const digits = String(raw ?? "").replace(/\D/g, "");
    return couldBePlaceholderNumber(digits) && digits.startsWith("999");
}

const cache = new Map<string, { placeholder: boolean; at: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

/** True when `raw` is an internal placeholder number (never message it). */
export async function isPlaceholderWhatsAppNumber(raw: string | undefined | null): Promise<boolean> {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (!couldBePlaceholderNumber(digits)) return false;
    if (isDefinitelyPlaceholderNumber(digits)) return true;

    const hit = cache.get(digits);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.placeholder;

    const local = digits.slice(PLACEHOLDER_CC_DIGITS.length);
    let placeholder: boolean;
    try {
        const User = (await import("../models/users.model")).default;
        const FamilyInvitation = (await import("../models/familyInvitation.model")).default;
        const [user, invite] = await Promise.all([
            User.exists({
                $or: [
                    { phoneKey: `${INTERNAL_PHONE_COUNTRY_CODE}${local}` },
                    { "phone.countryCode": INTERNAL_PHONE_COUNTRY_CODE, "phone.number": local },
                ],
            }),
            FamilyInvitation.exists({ phoneCountryCode: INTERNAL_PHONE_COUNTRY_CODE, phone: local }),
        ]);
        placeholder = Boolean(user || invite);
    } catch (err) {
        // Fail closed only for this narrow 12-digit "99…" shape.
        console.warn(
            "WhatsApp placeholder check failed — treating 99… number as placeholder:",
            err instanceof Error ? err.message : err,
        );
        return true;
    }
    cache.set(digits, { placeholder, at: Date.now() });
    return placeholder;
}

/** Throws WhatsAppPlaceholderRecipientError (and warns) instead of sending to a placeholder. */
export async function assertSendableWhatsAppRecipient(to: string): Promise<void> {
    if (await isPlaceholderWhatsAppNumber(to)) {
        const err = new WhatsAppPlaceholderRecipientError(to);
        console.warn(`WhatsApp send skipped: ${err.message}`);
        throw err;
    }
}
