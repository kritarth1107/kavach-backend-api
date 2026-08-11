import { AppError } from "../middleware/error.middleware";
import { randomInt } from "crypto";

export type NormalizedPhone = {
    countryCode: string;
    number: string;
    key: string;
};

/** Reserved code for Cosmos-safe per-user placeholders (not shown in UI). */
export const INTERNAL_PHONE_COUNTRY_CODE = "+99";

export function normalizePhoneDigits(number: string): string {
    return number.replace(/\D/g, "");
}

export function normalizePhoneInput(
    countryCode: string,
    number: string,
): NormalizedPhone {
    const cc = String(countryCode ?? "").trim();
    const digits = normalizePhoneDigits(number);

    if (!/^\+\d{1,4}$/.test(cc)) {
        throw new AppError("A valid country code is required (e.g. +91)", 400);
    }

    if (!/^\d{6,15}$/.test(digits)) {
        throw new AppError("A valid mobile number is required", 400);
    }

    return {
        countryCode: cc,
        number: digits,
        key: `${cc}${digits}`,
    };
}

export function maskPhoneNumber(countryCode: string, number: string): string {
    if (countryCode === INTERNAL_PHONE_COUNTRY_CODE) {
        return "";
    }

    const digits = normalizePhoneDigits(number);
    if (digits.length <= 4) {
        return `${countryCode} ${digits}`;
    }

    const visible = digits.slice(-4);
    const masked = digits.slice(0, -4).replace(/\d/g, "•");
    return `${countryCode} ${masked}${visible}`;
}

export function isInternalPhone(countryCode?: string | null): boolean {
    return countryCode === INTERNAL_PHONE_COUNTRY_CODE;
}

/** Cosmos DB can reject a second user with no phone due to legacy unique indexes. */
export function buildCosmosSafePhonePlaceholder(): NormalizedPhone {
    const number = String(randomInt(1_000_000_000, 9_999_999_999));
    return {
        countryCode: INTERNAL_PHONE_COUNTRY_CODE,
        number,
        key: `${INTERNAL_PHONE_COUNTRY_CODE}${number}`,
    };
}

export function phoneFieldsFromNormalized(phone: NormalizedPhone) {
    return {
        phone: {
            countryCode: phone.countryCode,
            number: phone.number,
        },
        phoneKey: phone.key,
    };
}
