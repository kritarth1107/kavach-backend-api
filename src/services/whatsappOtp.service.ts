/**
 * Codes sent on WhatsApp with the approved "otp" authentication template (code in the text + a "Copy code" button).
 * Used for mobile sign-in and for proving a parent's number during onboarding. There is no SMS provider.
 */
import { randomInt } from "crypto";
import { AppError } from "../middleware/error.middleware";
import { AuthOtpSend } from "../models/authOtp.model";
import type { NormalizedPhone } from "../utils/phone.util";

export const OTP_TEMPLATE = process.env.WHATSAPP_OTP_TEMPLATE || "otp";

/** Sign-in codes: at most 4 an hour and 10 a day to one number, and a ceiling on all of them an hour (spend). */
const PER_NUMBER_HOUR = 4;
const PER_NUMBER_DAY = 10;
const ALL_PER_HOUR = Number(process.env.PHONE_OTP_HOURLY_CAP || 200);

export function generatePhoneOtpCode(): string {
    return String(randomInt(100000, 1_000_000));
}

/** Send one code with the template. Throws when WhatsApp refuses it. */
export async function sendWhatsAppCode(to: string, code: string): Promise<void> {
    const { isMetaWhatsAppEnabled, sendMetaWhatsAppTemplate } = await import("../clients/metaWhatsApp.client");
    if (!isMetaWhatsAppEnabled()) {
        if (process.env.NODE_ENV === "production") throw new Error("WhatsApp is not configured");
        console.info(`[WhatsApp OTP, local] code for ${to.slice(0, 5)}…: ${code}`);
        return;
    }
    await sendMetaWhatsAppTemplate({ to, templateName: OTP_TEMPLATE, languageCode: "en", bodyParameters: [code], urlButtonParameter: code });
}

/** Mobile sign-in: the limits above, then the code on WhatsApp. */
export async function sendPhoneSignInCode(phone: NormalizedPhone, code: string, now = new Date()): Promise<void> {
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);
    if ((await AuthOtpSend.countDocuments({ phoneKey: phone.key, at: { $gte: hourAgo } })) >= PER_NUMBER_HOUR
        || (await AuthOtpSend.countDocuments({ phoneKey: phone.key, at: { $gte: dayAgo } })) >= PER_NUMBER_DAY) {
        throw new AppError("We've sent several codes to this number already. Wait a little, or sign in with email or Google.", 429);
    }
    if ((await AuthOtpSend.countDocuments({ at: { $gte: hourAgo } })) >= ALL_PER_HOUR) {
        console.error(`[WhatsApp OTP] hourly ceiling reached (${ALL_PER_HOUR})`);
        throw new AppError("Mobile sign-in is busy right now. Please try again in a few minutes, or use email or Google.", 429);
    }
    await AuthOtpSend.create({ phoneKey: phone.key, at: now });
    try {
        await sendWhatsAppCode(`${phone.countryCode}${phone.number}`, code);
    } catch (err) {
        console.warn("[WhatsApp OTP] send failed:", err instanceof Error ? err.message : err);
        throw new AppError("Couldn't send a code to this number on WhatsApp. Check the number has WhatsApp, or sign in with email.", 502);
    }
}
