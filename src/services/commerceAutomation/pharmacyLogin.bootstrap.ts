/**
 * Deterministic Apollo / PharmEasy / 1mg login bootstrap (Playwright).
 * Prefer this over burning Gemini steps just to click Login + enter phone.
 * Returns need_otp only after Continue/Send OTP ran AND (generateOtp success OR real OTP UI).
 * "Sent to" ONLY when generateOtp JSON succeeds for the SAME national-10 as filled.
 *
 * EMERGENCY: live Continue/Send-OTP is OFF unless BROWSER_PHARMACY_LOGIN=on|1|true.
 * One OTP request per login attempt max — never re-click Continue/resend while waiting.
 */
import type { Page } from "playwright";
import { partnerLabel } from "./playbooks";

export type PharmacyLoginStage =
    | "opening"
    | "homepage"
    | "login_page"
    | "phone_entered"
    | "otp_ready"
    | "already_logged_in"
    | "no_login_button"
    | "captcha"
    | "failed"
    | "disabled";

export type PharmacyLoginBootstrapResult =
    | { ok: true; status: "need_otp" | "already_logged_in"; stage: PharmacyLoginStage; message: string }
    | {
          ok: false;
          status: "error";
          stage: PharmacyLoginStage;
          failureReason: "captcha" | "no_login_button" | "site_slow" | "chromium_crash" | "timeout" | "disabled";
          message: string;
      };

export type PharmacyProgressFn = (stage: PharmacyLoginStage, detail: string) => void | Promise<void>;

const LOGIN_CLICK_TEXTS = /^(login|log in|sign in|signin|sign up|signup|login\/sign up|hello,\s*log in|account)$/i;
const CONTINUE_TEXTS = /^(continue|get otp|send otp|request otp|submit|proceed|next)$/i;
/** Never click these while waiting for user paste — causes SMS spam. */
const RESEND_TEXTS = /^(resend|re-send|send again|get (a )?new (otp|code)|request (a )?new)/i;

/** Live Continue/Send OTP — DEFAULT OFF (emergency SMS-spam kill). Set on|1|true to enable. */
export function isPharmacyLoginOtpSendEnabled(): boolean {
    const raw = (process.env.BROWSER_PHARMACY_LOGIN || "off").trim().toLowerCase();
    return raw === "on" || raw === "1" || raw === "true" || raw === "yes";
}

function indiaMobile10(phone: string): string {
    const d = phone.replace(/\D/g, "");
    return d.slice(-10);
}

function maskPhone(phone: string): string {
    const d = phone.replace(/\D/g, "");
    if (d.length < 4) return "••••";
    return `••••${d.slice(-4)}`;
}

async function pageBlob(page: Page): Promise<string> {
    try {
        return await page.evaluate(() => {
            const t = (document.body?.innerText || "").slice(0, 5000).toLowerCase();
            const title = (document.title || "").toLowerCase();
            return `${title}\n${t}`;
        });
    } catch {
        return "";
    }
}

async function looksCaptcha(page: Page): Promise<boolean> {
    const blob = await pageBlob(page);
    return /captcha|unusual traffic|are you a robot|cf-browser-verification|access denied|bot detection|cloudflare/i.test(
        blob,
    );
}

async function looksLoggedIn(page: Page): Promise<boolean> {
    const blob = await pageBlob(page);
    if (/hello,\s*log\s*in|sign\s*in\s*\/?\s*sign\s*up|login\s*\/?\s*sign\s*up/i.test(blob)) {
        return false;
    }
    try {
        const loginCta = page
            .getByRole("button", { name: /^(log\s*in|login|sign\s*in)$/i })
            .or(page.getByRole("link", { name: /^(log\s*in|login|sign\s*in|hello,\s*log\s*in)$/i }))
            .first();
        if ((await loginCta.count()) && (await loginCta.isVisible().catch(() => false))) {
            return false;
        }
    } catch {
        /* ignore */
    }
    if (/log\s*out|sign\s*out/i.test(blob)) return true;
    try {
        const logout = page.getByRole("button", { name: /log\s*out|sign\s*out/i }).first();
        if ((await logout.count()) && (await logout.isVisible().catch(() => false))) return true;
    } catch {
        /* ignore */
    }
    if (/hello,\s*[a-z][a-z]+/i.test(blob) && !/hello,\s*log/i.test(blob)) return true;
    return false;
}

async function otpFieldVisible(page: Page): Promise<boolean> {
    const sel =
        'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="OTP" i], input[placeholder*="one time" i], input[placeholder*="verification" i], input[aria-label*="otp" i]';
    let found = false;
    try {
        const el = page.locator(sel).first();
        if ((await el.count()) && (await el.isVisible().catch(() => false))) found = true;
    } catch {
        /* ignore */
    }
    if (!found) {
        try {
            const boxes = page.locator('input[maxlength="1"]');
            const n = await boxes.count();
            // Require at least one visible box — hidden maxlength=1 inputs are common false positives
            if (n >= 4 && n <= 8) {
                let vis = 0;
                for (let i = 0; i < Math.min(n, 8); i++) {
                    if (await boxes.nth(i).isVisible().catch(() => false)) vis++;
                }
                if (vis >= 4) found = true;
            }
        } catch {
            /* ignore */
        }
    }
    if (!found) {
        // Apollo: digit1..digit6 (type=tel, autocomplete=one-time-code, no maxlength=1)
        try {
            const digits = page.locator(
                'input[name^="digit"], input[id^="digit"], input[name*="otpDigit" i], input[data-testid*="otp" i]',
            );
            const n = await digits.count();
            if (n >= 4 && n <= 8) {
                let vis = 0;
                for (let i = 0; i < Math.min(n, 8); i++) {
                    if (await digits.nth(i).isVisible().catch(() => false)) vis++;
                }
                if (vis >= 4) found = true;
            }
        } catch {
            /* ignore */
        }
    }
    if (!found) return false;
    // Guard: digit inputs alone can exist off-screen; require OTP copy on page
    const blob = await pageBlob(page);
    if (
        /enter\s*otp|otp\s*sent|verification\s*code|one[-\s]?time|paste\s*(the\s*)?otp|login\s*code/i.test(
            blob,
        )
    ) {
        return true;
    }
    // Apollo digit1..digit6 with autocomplete=one-time-code is strong enough without copy
    try {
        const apolloDigits = page.locator(
            'input[name^="digit"][autocomplete="one-time-code"], input[id^="digit"][autocomplete="one-time-code"]',
        );
        const n = await apolloDigits.count();
        if (n >= 4) {
            const vis = await apolloDigits.first().isVisible().catch(() => false);
            if (vis) return true;
        }
    } catch {
        /* ignore */
    }
    return false;
}

/** Tick visible WhatsApp / T&C / consent checkboxes that gate Continue. */
async function tickLoginConsentCheckboxes(page: Page): Promise<void> {
    try {
        const boxes = page.locator('input[type="checkbox"]');
        const n = await boxes.count();
        for (let i = 0; i < Math.min(n, 12); i++) {
            const box = boxes.nth(i);
            if (!(await box.isVisible().catch(() => false))) continue;
            const meta = await box.evaluate((el: HTMLInputElement) => {
                const label =
                    (el.labels && el.labels[0] && el.labels[0].innerText) ||
                    el.parentElement?.innerText ||
                    el.getAttribute("aria-label") ||
                    el.name ||
                    "";
                return { checked: el.checked, label: label.slice(0, 160).toLowerCase() };
            });
            // Skip FAQ accordion checkboxes
            if (/faq|accordion|how to|delivery status/i.test(meta.label)) continue;
            const looksConsent =
                /whats?app|terms|t&c|privacy|agree|consent|otp|notify|sms|communication/i.test(
                    meta.label,
                );
            if (looksConsent && !meta.checked) {
                await box.check({ timeout: 2000 }).catch(() => box.click({ timeout: 2000 }));
            }
        }
    } catch {
        /* ignore */
    }
}

/**
 * Wait until Continue/Get OTP is enabled after phone fill (React validation).
 * Returns the locator if clickable, else null.
 */
async function waitContinueEnabled(page: Page, ms = 6000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        for (const role of ["button", "link"] as const) {
            try {
                const loc = page.getByRole(role, { name: CONTINUE_TEXTS }).first();
                if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
                    const disabled = await loc.isDisabled().catch(() => false);
                    const ariaDisabled = await loc.getAttribute("aria-disabled").catch(() => null);
                    if (!disabled && ariaDisabled !== "true") return true;
                }
            } catch {
                /* next */
            }
        }
        await page.waitForTimeout(250);
    }
    return false;
}

async function clickByName(page: Page, re: RegExp): Promise<boolean> {
    for (const role of ["button", "link"] as const) {
        try {
            const loc = page.getByRole(role, { name: re }).first();
            if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
                await loc.click({ timeout: 6000 });
                return true;
            }
        } catch {
            /* try next */
        }
    }
    try {
        const loc = page.getByText(re).first();
        if ((await loc.count()) && (await loc.isVisible().catch(() => false))) {
            await loc.click({ timeout: 6000 });
            return true;
        }
    } catch {
        /* ignore */
    }
    return false;
}

async function findPhoneInput(page: Page) {
    const selectors = [
        '#user-mobile-number',
        'input[name="user-mobile-number"]',
        'input[name*="mobile" i]',
        'input[name*="phone" i]',
        'input[id*="mobile" i]',
        'input[id*="phone" i]',
        'input[type="tel"]:not([name^="digit"]):not([id^="digit"]):not([autocomplete="one-time-code"])',
        'input[placeholder*="mobile" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="10" i]',
        'input[autocomplete="tel"]',
        'input[inputmode="numeric"]:not([name^="digit"]):not([autocomplete="one-time-code"])',
    ];
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            if ((await loc.count()) && (await loc.isVisible().catch(() => false))) return loc;
        } catch {
            /* next */
        }
    }
    return null;
}

/**
 * Click Login → fill elder WhatsApp phone → request OTP (at most once).
 * Soft-fails with typed reason so WA can explain CAPTCHA vs no-login vs timeout.
 */
export async function bootstrapPharmacyLogin(input: {
    page: Page;
    partner: string;
    loginPhone: string;
    onProgress?: PharmacyProgressFn;
    settleMs?: number;
    /** Abort check — return cancelled if true */
    isCancelled?: () => boolean;
    /**
     * One-shot gate for Continue/Send OTP. Return false to skip clicking
     * (already claimed this browserGeneration). Omit to always allow one click
     * inside this call (legacy). Prefer wiring claimPharmacyOtpSend.
     */
    claimOtpSend?: () => boolean;
}): Promise<PharmacyLoginBootstrapResult> {
    const { page, partner, loginPhone } = input;
    const label = partnerLabel(partner);
    const notify = async (stage: PharmacyLoginStage, detail: string) => {
        try {
            await input.onProgress?.(stage, detail);
        } catch {
            /* never block login on WA progress */
        }
    };

    // EMERGENCY KILL: do not send SMS OTP unless explicitly enabled
    if (!isPharmacyLoginOtpSendEnabled()) {
        console.warn(
            `[pharmacy-login] BROWSER_PHARMACY_LOGIN off — skipping Continue/Send OTP for ${label}`,
        );
        return {
            ok: false,
            status: "error",
            stage: "disabled",
            failureReason: "disabled",
            message:
                `${label} login is temporarily paused (SMS OTP send disabled while we fix the browser). ` +
                `Nothing was ordered. Reply *cancel* — no more codes should arrive from this attempt.`,
        };
    }

    if (input.isCancelled?.()) {
        return {
            ok: false,
            status: "error",
            stage: "failed",
            failureReason: "timeout",
            message: `${label} login cancelled.`,
        };
    }

    await notify("homepage", `on *${label}* homepage…`);
    await page.waitForTimeout(input.settleMs ?? 1200);

    if (await looksCaptcha(page)) {
        return {
            ok: false,
            status: "error",
            stage: "captcha",
            failureReason: "captcha",
            message: `${label} blocked the browser session (CAPTCHA / bot check). Reply *retry* or *cancel* — nothing was ordered.`,
        };
    }

    if (await otpFieldVisible(page)) {
        // Leftover OTP UI from a prior attempt — do NOT ask user (no Continue this turn → no new SMS)
        console.warn(`[pharmacy-login] OTP UI already open before Continue for ${label} — refusing false need_otp`);
        return {
            ok: false,
            status: "error",
            stage: "failed",
            failureReason: "site_slow",
            message:
                `${label} couldn't send a login code — a leftover code screen was open but SMS was not requested this attempt. ` +
                `Reply *retry* or *cancel* — nothing was ordered.`,
        };
    }

    if (await looksLoggedIn(page)) {
        await notify("already_logged_in", `*${label}* session already signed in — searching basket…`);
        return {
            ok: true,
            status: "already_logged_in",
            stage: "already_logged_in",
            message: `${label} already logged in`,
        };
    }

    const clickedLogin =
        (await clickByName(page, LOGIN_CLICK_TEXTS)) ||
        (await clickByName(page, /hello,\s*log\s*in/i)) ||
        (await clickByName(page, /login|sign\s*in|sign\s*up/i));
    if (clickedLogin) {
        await notify("login_page", `on *${label}* login page…`);
        await page.waitForTimeout(1000);
    }

    if (input.isCancelled?.()) {
        return {
            ok: false,
            status: "error",
            stage: "failed",
            failureReason: "timeout",
            message: `${label} login cancelled.`,
        };
    }

    if (await looksCaptcha(page)) {
        return {
            ok: false,
            status: "error",
            stage: "captcha",
            failureReason: "captcha",
            message: `${label} blocked the browser session (CAPTCHA / bot check). Reply *retry* or *cancel* — nothing was ordered.`,
        };
    }

    if (await otpFieldVisible(page)) {
        // Login click surfaced OTP UI without us sending — still no verified SMS this attempt
        console.warn(`[pharmacy-login] OTP UI after Login click without Continue for ${label}`);
        return {
            ok: false,
            status: "error",
            stage: "failed",
            failureReason: "site_slow",
            message:
                `${label} couldn't send a login code — code screen appeared before Continue. ` +
                `Reply *retry* or *cancel* — nothing was ordered.`,
        };
    }

    let sendAttempt: OtpSendAttempt = { clicked: false, apiConfirmed: false };
    const phoneInput = await findPhoneInput(page);
    if (!phoneInput) {
        if (!clickedLogin) {
            return {
                ok: false,
                status: "error",
                stage: "no_login_button",
                failureReason: "no_login_button",
                message: `${label} page loaded but I couldn't find a Login / phone field (layout changed or unavailable). Reply *retry* or *cancel* — nothing was ordered.`,
            };
        }
        await page.waitForTimeout(1500);
        const retryPhone = await findPhoneInput(page);
        if (!retryPhone) {
            // OTP UI without Continue this turn — never claim SMS / ask for paste
            if (await otpFieldVisible(page)) {
                console.warn(`[pharmacy-login] OTP UI without phone Continue for ${label}`);
                return {
                    ok: false,
                    status: "error",
                    stage: "failed",
                    failureReason: "site_slow",
                    message:
                        `${label} couldn't send a login code — code screen without Continue this attempt. ` +
                        `Reply *retry* or *cancel* — nothing was ordered.`,
                };
            }
            return {
                ok: false,
                status: "error",
                stage: "no_login_button",
                failureReason: "no_login_button",
                message: `${label} login opened but no phone field appeared. Reply *retry* or *cancel* — nothing was ordered.`,
            };
        }
        sendAttempt = await fillPhoneAndContinueOnce(
            page,
            retryPhone,
            loginPhone,
            label,
            notify,
            input.claimOtpSend,
        );
    } else {
        sendAttempt = await fillPhoneAndContinueOnce(
            page,
            phoneInput,
            loginPhone,
            label,
            notify,
            input.claimOtpSend,
        );
    }

    // Continue never happened — do NOT ask user for an OTP (SMS was never requested)
    if (!sendAttempt.clicked) {
        return {
            ok: false,
            status: "error",
            stage: "failed",
            failureReason: "site_slow",
            message:
                `${label} login paused — I couldn't tap Continue / Send OTP (button disabled or already used this attempt). ` +
                `No SMS is expected. Reply *retry* or *cancel* — nothing was ordered.`,
        };
    }

    // Wait for OTP UI — poll ONLY; never click Continue/resend again
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
        if (input.isCancelled?.()) {
            return {
                ok: false,
                status: "error",
                stage: "failed",
                failureReason: "timeout",
                message: `${label} login cancelled.`,
            };
        }
        if (await looksCaptcha(page)) {
            return {
                ok: false,
                status: "error",
                stage: "captcha",
                failureReason: "captcha",
                message: `${label} blocked the browser session (CAPTCHA / bot check). Reply *retry* or *cancel* — nothing was ordered.`,
            };
        }
        if (await otpFieldVisible(page)) {
            if (sendAttempt.rateLimited) {
                return {
                    ok: false,
                    status: "error",
                    stage: "failed",
                    failureReason: "site_slow",
                    message:
                        `${label} asked me to wait / try again later (OTP rate-limit or already-sent). ` +
                        `No new SMS is expected. Reply *retry* later or *cancel* — nothing was ordered.`,
                };
            }
            if (sendAttempt.phoneMismatch) {
                return {
                    ok: false,
                    status: "error",
                    stage: "failed",
                    failureReason: "site_slow",
                    message:
                        `${label} generateOtp echoed a different mobile than the one I filled. ` +
                        `I won't claim SMS was sent. Reply *retry* or *cancel* — nothing was ordered.`,
                };
            }
            // "Sent to" ONLY when generateOtp JSON clearly succeeded for the SAME national-10
            if (sendAttempt.apiConfirmed) {
                await notify(
                    "otp_ready",
                    `*${label}* login code sent to ${maskPhone(loginPhone)} — *paste the SMS OTP here*.`,
                );
                return {
                    ok: true,
                    status: "need_otp",
                    stage: "otp_ready",
                    message: [
                        `*${label}* is waiting for your login code — *paste the SMS OTP here*.`,
                        `(Sent to ${maskPhone(loginPhone)} — I never read your device SMS, only what you paste here.)`,
                        `If no SMS in ~60s, reply *cancel* (don't resend).`,
                    ].join("\n"),
                };
            }
            // OTP digit UI after Continue but API not confirmed — ask without "Sent to"
            await notify(
                "otp_ready",
                `*${label}* code screen is open — *paste the SMS OTP here* (send not API-confirmed).`,
            );
            return {
                ok: true,
                status: "need_otp",
                stage: "otp_ready",
                message: [
                    `I tapped Continue on *${label}*; if no SMS in 60s reply *cancel*.`,
                    `*Paste the SMS OTP here* if it arrives (I never read your device SMS).`,
                    `Don't ask me to resend — one Continue max this attempt.`,
                ].join("\n"),
            };
        }
        // Explicitly do NOT click RESEND_TEXTS / CONTINUE_TEXTS here
        void RESEND_TEXTS;
        await page.waitForTimeout(800);
    }

    if (sendAttempt.rateLimited) {
        return {
            ok: false,
            status: "error",
            stage: "failed",
            failureReason: "site_slow",
            message:
                `${label} hit an OTP rate-limit / try-again-later after Continue. ` +
                `No SMS is expected. Reply *retry* later or *cancel* — nothing was ordered.`,
        };
    }

    return {
        ok: false,
        status: "error",
        stage: "failed",
        failureReason: "site_slow",
        message:
            `${label} didn't send a login code — Continue was tapped but the OTP screen never appeared ` +
            `(site slow, unavailable, or SMS not dispatched). Reply *retry* or *cancel* — nothing was ordered.`,
    };
}

export type OtpSendAttempt = {
    /** True only when Continue/Get OTP was clicked (or Enter after enabled Continue). */
    clicked: boolean;
    /**
     * True only when generateOtp (or equiv) JSON clearly succeeds for the SAME national-10
     * that was filled into the phone field. Never from bare HTTP 200 / OTP UI alone.
     */
    apiConfirmed: boolean;
    /** Partner said try-again-later / already-sent / rate-limit. */
    rateLimited?: boolean;
    /** generateOtp echoed a mobile that does not match the filled national-10. */
    phoneMismatch?: boolean;
};

const OTP_SEND_URL_RE =
    /generateOtp|sendOtp|send_otp|requestOtp|otp\/send|auth-service\/generateOtp/i;

const OTP_RATE_LIMIT_RE =
    /try\s*again\s*later|too\s*many\s*(requests|attempts|otp)|rate\s*limit|otp\s*already\s*sent|already\s*sent|please\s*wait|wait\s*\d+\s*(sec|min|second|minute)|cooldown|frequently|after\s*some\s*time/i;

function sanitizeOtpLogSnippet(body: string): string {
    return body
        .replace(/"(accessToken|authToken|token|jwt|idToken|refreshToken)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280);
}

function nationalFromMaybePhone(raw: unknown): string {
    if (raw == null) return "";
    return String(raw).replace(/\D/g, "").slice(-10);
}

/** Parse partner OTP-send JSON; require same national-10 when mobile is echoed. */
function evaluateGenerateOtpBody(
    body: string,
    national: string,
): { confirmed: boolean; rateLimited: boolean; phoneMismatch: boolean; snippet: string } {
    const snippet = sanitizeOtpLogSnippet(body);
    if (OTP_RATE_LIMIT_RE.test(body)) {
        return { confirmed: false, rateLimited: true, phoneMismatch: false, snippet };
    }
    if (/success["']?\s*:\s*false|"success"\s*:\s*false|otp\s*not\s*sent|failed to send|unable to send/i.test(body)) {
        return { confirmed: false, rateLimited: false, phoneMismatch: false, snippet };
    }

    try {
        const j = JSON.parse(body) as Record<string, unknown>;
        const resp = (j.response && typeof j.response === "object" ? j.response : j) as Record<
            string,
            unknown
        >;
        const topCode = typeof j.code === "number" ? j.code : undefined;
        if (topCode != null && topCode !== 200) {
            const rate = OTP_RATE_LIMIT_RE.test(String(j.message ?? resp.message ?? "")) || topCode === 429;
            return {
                confirmed: false,
                rateLimited: rate || OTP_RATE_LIMIT_RE.test(body),
                phoneMismatch: false,
                snippet,
            };
        }
        const success =
            resp.success === true || j.success === true || (j as { sucess?: boolean }).sucess === true;
        const msg = String(resp.message ?? j.message ?? "");
        const mobileNat = nationalFromMaybePhone(
            resp.mobileNumber ?? resp.mobile ?? resp.phone ?? resp.phoneNumber,
        );
        const looksSent = /otp\s*sent|sent to the mobile/i.test(msg);

        if (!success || !looksSent) {
            return { confirmed: false, rateLimited: false, phoneMismatch: false, snippet };
        }
        if (mobileNat && mobileNat !== national) {
            return { confirmed: false, rateLimited: false, phoneMismatch: true, snippet };
        }
        // Apollo always echoes mobileNumber — require match when present; else require national in body
        if (mobileNat === national) {
            return { confirmed: true, rateLimited: false, phoneMismatch: false, snippet };
        }
        if (body.includes(national) || body.includes(`+91${national}`)) {
            return { confirmed: true, rateLimited: false, phoneMismatch: false, snippet };
        }
        return { confirmed: false, rateLimited: false, phoneMismatch: true, snippet };
    } catch {
        // Non-JSON: require explicit sent wording + national echo + success-ish
        const hasSent = /otp\s*sent|sent to the mobile/i.test(body);
        const hasSuccess = /"sucess"\s*:\s*true|success["']?\s*:\s*true/i.test(body);
        const hasPhone = body.includes(national) || body.includes(`+91${national}`);
        if (hasSent && hasSuccess && hasPhone) {
            return { confirmed: true, rateLimited: false, phoneMismatch: false, snippet };
        }
        if (hasSent && hasSuccess && !hasPhone) {
            return { confirmed: false, rateLimited: false, phoneMismatch: true, snippet };
        }
        return { confirmed: false, rateLimited: false, phoneMismatch: false, snippet };
    }
}

async function pageLooksOtpRateLimited(page: Page): Promise<boolean> {
    const blob = await pageBlob(page);
    return OTP_RATE_LIMIT_RE.test(blob);
}

/** Ensure the visible phone field holds exactly the 10-digit national (no +91 / 91 prefix). */
async function fillNationalPhoneOnly(
    phoneInput: import("playwright").Locator,
    national: string,
): Promise<string> {
    await phoneInput.click({ timeout: 5000 }).catch(() => undefined);
    await phoneInput.fill("");
    await phoneInput.fill(national);
    let current = (await phoneInput.inputValue().catch(() => "")).replace(/\D/g, "");
    // Reject +91 double-prefix / E.164 dumped into national field
    if (current !== national) {
        await phoneInput.fill("");
        await phoneInput.pressSequentially(national, { delay: 35 }).catch(async () => {
            await phoneInput.fill(national);
        });
        current = (await phoneInput.inputValue().catch(() => "")).replace(/\D/g, "");
    }
    if (current === `91${national}` || current.length > 10) {
        console.warn(
            `[pharmacy-login] phone field had non-national digits (len=${current.length}) — clearing to 10-digit`,
        );
        await phoneInput.fill("");
        await phoneInput.pressSequentially(national, { delay: 40 }).catch(async () => {
            await phoneInput.fill(national);
        });
        current = (await phoneInput.inputValue().catch(() => "")).replace(/\D/g, "");
    }
    return current;
}

/** Fill phone + click Continue/Get OTP at most ONCE. Never pretends SMS was sent. */
async function fillPhoneAndContinueOnce(
    page: Page,
    phoneInput: import("playwright").Locator,
    loginPhone: string,
    label: string,
    notify: (stage: PharmacyLoginStage, detail: string) => void | Promise<void>,
    claimOtpSend?: () => boolean,
): Promise<OtpSendAttempt> {
    const national = indiaMobile10(loginPhone) || loginPhone.replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(national)) {
        console.warn(`[pharmacy-login] phone not a valid IN mobile 10: ${national.slice(0, 4)}…`);
    }
    const fieldDigits = await fillNationalPhoneOnly(phoneInput, national);
    if (fieldDigits !== national) {
        console.warn(
            `[pharmacy-login] phone field still not national-10 after fill (len=${fieldDigits.length} last4=${fieldDigits.slice(-4)})`,
        );
    } else {
        console.info(`[pharmacy-login] phone field national-10 ok …${national.slice(-4)}`);
    }
    await tickLoginConsentCheckboxes(page);
    const enabled = await waitContinueEnabled(page, 7000);
    if (!enabled) {
        console.warn(`[pharmacy-login] Continue still disabled after phone fill for ${label}`);
        return { clicked: false, apiConfirmed: false };
    }
    // Generation-level one-shot — claim BEFORE click to block Gemini double-send
    if (claimOtpSend && !claimOtpSend()) {
        console.warn(`[pharmacy-login] OTP send already claimed — not re-clicking Continue for ${label}`);
        return { clicked: false, apiConfirmed: false };
    }

    let apiConfirmed = false;
    let rateLimited = false;
    let phoneMismatch = false;

    const onRequest = (req: import("playwright").Request) => {
        try {
            const u = req.url();
            if (!OTP_SEND_URL_RE.test(u)) return;
            const post = req.postData() || "";
            const snippet = sanitizeOtpLogSnippet(post);
            const postNat = nationalFromMaybePhone(post);
            const hasNat = post.includes(national) || post.includes(`+91${national}`) || postNat === national;
            console.info(
                `[pharmacy-login] OTP request ${u.slice(0, 120)} national_ok=${hasNat} body=${snippet}`,
            );
            if (post && !hasNat && /\d{10}/.test(post)) {
                phoneMismatch = true;
            }
        } catch {
            /* ignore */
        }
    };

    const onResponse = async (resp: import("playwright").Response) => {
        try {
            const u = resp.url();
            if (!OTP_SEND_URL_RE.test(u)) return;
            if (resp.status() < 200 || resp.status() >= 300) {
                const body = await resp.text().catch(() => "");
                const snippet = sanitizeOtpLogSnippet(body);
                console.warn(
                    `[pharmacy-login] OTP response HTTP ${resp.status()} ${u.slice(0, 100)} body=${snippet}`,
                );
                if (OTP_RATE_LIMIT_RE.test(body)) rateLimited = true;
                return;
            }
            const body = await resp.text().catch(() => "");
            const ev = evaluateGenerateOtpBody(body, national);
            console.info(
                `[pharmacy-login] OTP response HTTP ${resp.status()} confirmed=${ev.confirmed} ` +
                    `rateLimited=${ev.rateLimited} phoneMismatch=${ev.phoneMismatch} body=${ev.snippet}`,
            );
            if (ev.rateLimited) rateLimited = true;
            if (ev.phoneMismatch) phoneMismatch = true;
            if (ev.confirmed) apiConfirmed = true;
        } catch {
            /* ignore */
        }
    };
    page.on("request", onRequest);
    page.on("response", onResponse);

    const continued = await clickByName(page, CONTINUE_TEXTS);
    let clicked = continued;
    if (!continued) {
        // Enter only when Continue was enabled — never hammer Resend
        await page.keyboard.press("Enter").catch(() => undefined);
        clicked = true;
    }
    // Brief wait for OTP UI / generateOtp XHR
    const waitUntil = Date.now() + 5000;
    while (Date.now() < waitUntil && !apiConfirmed && !rateLimited) {
        if (await otpFieldVisible(page)) break;
        if (await pageLooksOtpRateLimited(page)) {
            rateLimited = true;
            break;
        }
        await page.waitForTimeout(300);
    }
    page.off("request", onRequest);
    page.off("response", onResponse);

    if (!clicked) {
        return { clicked: false, apiConfirmed: false };
    }

    if (!rateLimited && (await pageLooksOtpRateLimited(page))) {
        rateLimited = true;
    }
    // Rate-limit / mismatch beats a soft success claim
    if (rateLimited || phoneMismatch) {
        apiConfirmed = false;
    }

    await notify(
        "phone_entered",
        rateLimited
            ? `*${label}* asked to wait / try again later after Continue for ${maskPhone(loginPhone)}…`
            : apiConfirmed
              ? `requested *${label}* login code for ${maskPhone(loginPhone)}…`
              : `tapped Continue on *${label}* for ${maskPhone(loginPhone)} — waiting for the code screen…`,
    );
    return { clicked: true, apiConfirmed, rateLimited, phoneMismatch };
}
