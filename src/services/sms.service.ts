import { maskPhoneNumber } from "../utils/phone.util";

/** Mock SMS OTP — replace with Twilio/MSG91 when going live. */
export const MOCK_PHONE_OTP = "123456";

export function generatePhoneOtpCode(): string {
    return MOCK_PHONE_OTP;
}

export async function sendOtpSms(
    countryCode: string,
    number: string,
    code: string,
): Promise<void> {
    const masked = maskPhoneNumber(countryCode, number);
    console.info(`[Kavach SMS mock] OTP ${code} sent to ${masked}`);
}
