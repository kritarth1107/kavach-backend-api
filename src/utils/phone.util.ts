import { AppError } from "../middleware/error.middleware";

export type NormalizedPhone = {
    countryCode: string;
    number: string;
    key: string;
};

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
    const digits = normalizePhoneDigits(number);
    if (digits.length <= 4) {
        return `${countryCode} ${digits}`;
    }

    const visible = digits.slice(-4);
    const masked = digits.slice(0, -4).replace(/\d/g, "•");
    return `${countryCode} ${masked}${visible}`;
}
