/**
 * Deterministic Apollo / PharmEasy / 1mg login bootstrap (Playwright).
 * Prefer this over burning Gemini steps just to click Login + enter phone.
 * Returns need_otp once the OTP field is visible; otherwise a typed failure.
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
    try {
        const el = page.locator(sel).first();
        if ((await el.count()) && (await el.isVisible().catch(() => false))) return true;
    } catch {
        /* ignore */
    }
    try {
        const boxes = page.locator('input[maxlength="1"]');
        const n = await boxes.count();
        if (n >= 4 && n <= 8) return true;
    } catch {
        /* ignore */
    }
    // Apollo: digit1..digit6 (type=tel, autocomplete=one-time-code, no maxlength=1)
    try {
        const digits = page.locator(
            'input[name^="digit"], input[id^="digit"], input[name*="otpDigit" i], input[data-testid*="otp" i]',
        );
        const n = await digits.count();
        if (n >= 4 && n <= 8) {
            const firstVisible = await digits.first().isVisible().catch(() => false);
            if (firstVisible) return true;
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
        // Already on OTP screen — NEVER click Continue/resend
        await notify("otp_ready", `*${label}* login code screen is open — *paste the SMS OTP here*.`);
        return {
            ok: true,
            status: "need_otp",
            stage: "otp_ready",
            message: `*${label}* is waiting for your login code — *paste the SMS OTP here*.\n(I never read your device SMS — only what you send me on WhatsApp.)`,
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
        await notify("otp_ready", `*${label}* login code screen is open — *paste the SMS OTP here*.`);
        return {
            ok: true,
            status: "need_otp",
            stage: "otp_ready",
            message: `*${label}* is waiting for your login code — *paste the SMS OTP here*.\n(I never read your device SMS — only what you send me on WhatsApp.)`,
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
                message: `${label} page loaded but I couldn't find a Login / phone field (layout changed or blocked). Reply *retry* or *cancel* — nothing was ordered.`,
            };
        }
        await page.waitForTimeout(1500);
        const retryPhone = await findPhoneInput(page);
        if (!retryPhone) {
            // OTP UI without us clicking Continue this turn — only accept if field is truly open
            if (await otpFieldVisible(page)) {
                await notify("otp_ready", `*${label}* login code screen is open — *paste the SMS OTP here*.`);
                return {
                    ok: true,
                    status: "need_otp",
                    stage: "otp_ready",
                    message: `*${label}* is waiting for your login code — *paste the SMS OTP here*.`,
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
            await notify("otp_ready", `*${label}* login code screen is open — *paste the SMS OTP here*.`);
            return {
                ok: true,
                status: "need_otp",
                stage: "otp_ready",
                message: [
                    `*${label}* is waiting for your login code — *paste the SMS OTP here*.`,
                    `(Sent to ${maskPhone(loginPhone)} — I never read your device SMS, only what you paste here.)`,
                    sendAttempt.apiConfirmed
                        ? ``
                        : `(If no SMS arrives in ~30s, reply *retry* — the code screen opened but send wasn't confirmed.)`,
                ]
                    .filter((l) => l !== undefined && l !== "")
                    .join("\n"),
            };
        }
        // Explicitly do NOT click RESEND_TEXTS / CONTINUE_TEXTS here
        void RESEND_TEXTS;
        await page.waitForTimeout(800);
    }

    return {
        ok: false,
        status: "error",
        stage: "failed",
        failureReason: "site_slow",
        message:
            `${label} didn't send a login code — Continue was tapped but the OTP screen never appeared ` +
            `(site slow, blocked, or SMS not dispatched). Reply *retry* or *cancel* — nothing was ordered.`,
    };
}

export type OtpSendAttempt = {
    /** True only when Continue/Get OTP was clicked (or Enter after enabled Continue). */
    clicked: boolean;
    /** True when Apollo/PharmEasy-style generateOtp (or equivalent) returned success. */
    apiConfirmed: boolean;
};

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
    await phoneInput.click({ timeout: 5000 }).catch(() => undefined);
    await phoneInput.fill("");
    await phoneInput.fill(national);
    // React controlled inputs sometimes ignore fill() for enabling Continue
    const current = await phoneInput.inputValue().catch(() => "");
    if (current.replace(/\D/g, "").slice(-10) !== national) {
        await phoneInput.fill("");
        await phoneInput.pressSequentially(national, { delay: 35 }).catch(async () => {
            await phoneInput.fill(national);
        });
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

    // Watch partner OTP APIs so we only tell WA "requested" after a real send
    let apiConfirmed = false;
    const onResponse = async (resp: import("playwright").Response) => {
        try {
            const u = resp.url();
            if (!/generateOtp|sendOtp|send_otp|requestOtp|otp\/send|auth-service\/generate/i.test(u)) {
                return;
            }
            if (resp.status() < 200 || resp.status() >= 300) return;
            const body = await resp.text().catch(() => "");
            if (
                /otp sent|success["']?\s*:\s*true|successfully/i.test(body) ||
                body.trim() === "" ||
                resp.status() === 200
            ) {
                apiConfirmed = true;
            }
        } catch {
            /* ignore */
        }
    };
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
    while (Date.now() < waitUntil && !apiConfirmed) {
        if (await otpFieldVisible(page)) break;
        await page.waitForTimeout(300);
    }
    page.off("response", onResponse);

    if (!clicked) {
        return { clicked: false, apiConfirmed: false };
    }
    // ONLY now tell the user we requested a code (after Continue)
    await notify(
        "phone_entered",
        apiConfirmed
            ? `requested *${label}* login code for ${maskPhone(loginPhone)}…`
            : `tapped Continue on *${label}* for ${maskPhone(loginPhone)} — waiting for the code screen…`,
    );
    return { clicked: true, apiConfirmed };
}
