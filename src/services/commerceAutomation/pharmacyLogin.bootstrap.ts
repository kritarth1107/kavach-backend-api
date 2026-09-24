/**
 * Deterministic Apollo / PharmEasy / 1mg login bootstrap (Playwright).
 * Prefer this over burning Gemini steps just to click Login + enter phone.
 * Returns need_otp once the OTP field is visible; otherwise a typed failure.
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
    | "failed";

export type PharmacyLoginBootstrapResult =
    | { ok: true; status: "need_otp" | "already_logged_in"; stage: PharmacyLoginStage; message: string }
    | {
          ok: false;
          status: "error";
          stage: PharmacyLoginStage;
          failureReason: "captcha" | "no_login_button" | "site_slow" | "chromium_crash" | "timeout";
          message: string;
      };

export type PharmacyProgressFn = (stage: PharmacyLoginStage, detail: string) => void | Promise<void>;

const LOGIN_CLICK_TEXTS = /^(login|log in|sign in|signin|sign up|signup|login\/sign up|hello,\s*log in|account)$/i;
const CONTINUE_TEXTS = /^(continue|get otp|send otp|request otp|submit|proceed|next|verify)$/i;

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
    // PharmEasy marketing CTA is literally "Hello, Log in" — that is NOT logged in.
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
    // Greeting with a real name (not "Log in")
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
    // 4–6 discrete digit boxes
    try {
        const boxes = page.locator('input[maxlength="1"]');
        const n = await boxes.count();
        if (n >= 4 && n <= 8) return true;
    } catch {
        /* ignore */
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
        'input[type="tel"]',
        'input[name*="mobile" i]',
        'input[name*="phone" i]',
        'input[id*="mobile" i]',
        'input[id*="phone" i]',
        'input[placeholder*="mobile" i]',
        'input[placeholder*="phone" i]',
        'input[placeholder*="10" i]',
        'input[autocomplete="tel"]',
        'input[inputmode="numeric"]',
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
 * Click Login → fill elder WhatsApp phone → request OTP.
 * Soft-fails with typed reason so WA can explain CAPTCHA vs no-login vs timeout.
 */
export async function bootstrapPharmacyLogin(input: {
    page: Page;
    partner: string;
    loginPhone: string;
    onProgress?: PharmacyProgressFn;
    settleMs?: number;
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

    // Open login UI
    const clickedLogin =
        (await clickByName(page, LOGIN_CLICK_TEXTS)) ||
        (await clickByName(page, /hello,\s*log\s*in/i)) ||
        (await clickByName(page, /login|sign\s*in|sign\s*up/i));
    if (clickedLogin) {
        await notify("login_page", `on *${label}* login page…`);
        await page.waitForTimeout(1000);
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

    const phoneInput = await findPhoneInput(page);
    if (!phoneInput) {
        // Maybe login click opened a different surface — one more Login attempt then fail typed
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
            if (await otpFieldVisible(page)) {
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
        await fillPhoneAndContinue(page, retryPhone, loginPhone, label, notify);
    } else {
        await fillPhoneAndContinue(page, phoneInput, loginPhone, label, notify);
    }

    // Wait for OTP UI (site SMS send)
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
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
                ].join("\n"),
            };
        }
        await page.waitForTimeout(800);
    }

    return {
        ok: false,
        status: "error",
        stage: "failed",
        failureReason: "site_slow",
        message: `${label} accepted the phone but the login-code screen didn't appear in time (site slow or blocked). Reply *retry* or *cancel* — nothing was ordered.`,
    };
}

async function fillPhoneAndContinue(
    page: Page,
    phoneInput: import("playwright").Locator,
    loginPhone: string,
    label: string,
    notify: (stage: PharmacyLoginStage, detail: string) => void | Promise<void>,
): Promise<void> {
    const national = indiaMobile10(loginPhone) || loginPhone.replace(/\D/g, "").slice(-10);
    await phoneInput.click({ timeout: 5000 }).catch(() => undefined);
    await phoneInput.fill("");
    // IN pharmacy modals almost always want the 10-digit national mobile
    await phoneInput.fill(national);
    await notify("phone_entered", `requested *${label}* login code for ${maskPhone(loginPhone)}…`);
    const continued = await clickByName(page, CONTINUE_TEXTS);
    if (!continued) {
        await page.keyboard.press("Enter").catch(() => undefined);
    }
    await page.waitForTimeout(1200);
}
