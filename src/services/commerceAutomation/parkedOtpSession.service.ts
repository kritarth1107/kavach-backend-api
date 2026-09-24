/**
 * Live Playwright park while WA waits for pharmacy/commerce OTP + per-user
 * generation so cancel aborts late stage pings / OTP asks.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import type { RunBrowserTaskInput } from "./browserWorker.service";

const PARK_TTL_MS = Math.min(
    Math.max(Number(process.env.BROWSER_OTP_PARK_TTL_MS) || 240_000, 60_000),
    600_000,
);
const PENDING_OTP_TTL_MS = 90_000;

export type ParkedBrowserOtpSession = {
    key: string;
    familyId: string;
    userId: string;
    partner: string;
    goal: string;
    generation: number;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    input: RunBrowserTaskInput;
    createdAt: number;
    expiresAt: number;
    aborted: boolean;
};

type PendingOtp = { otp: string; at: number };

const parked = new Map<string, ParkedBrowserOtpSession>();
const pendingOtps = new Map<string, PendingOtp>();
const generationByKey = new Map<string, number>();
const lastOtpAskByKey = new Map<string, { text: string; at: number }>();
/** One Continue/Send-OTP click per browserGeneration — blocks Gemini + relaunch spam. */
const otpSendClaimedByKey = new Map<string, number>();
/** One "Got the code — signing in" ACK per generation (dedupe webhook retries). */
const otpGotCodeAckByKey = new Map<string, number>();
/** Soft cancel marker so SLA "still working" cannot fire after cancel. */
const cancelledAtByKey = new Map<string, number>();
const cancelledAtByPhone = new Map<string, number>();
/** Active fire-and-forget slot: generation currently allowed to notify. */
const activeTaskGenerationByKey = new Map<string, number>();
const CANCEL_SUPPRESS_MS = 120_000;

export function browserSessionKey(familyId: string, userId: string): string {
    return `${familyId}:${userId}`;
}

export function currentBrowserGeneration(familyId: string, userId: string): number {
    return generationByKey.get(browserSessionKey(familyId, userId)) ?? 0;
}

export function beginBrowserGeneration(familyId: string, userId: string): number {
    const key = browserSessionKey(familyId, userId);
    const next = (generationByKey.get(key) ?? 0) + 1;
    generationByKey.set(key, next);
    otpSendClaimedByKey.delete(key);
    otpGotCodeAckByKey.delete(key);
    pendingOtps.delete(key); // never consume stale digits from a prior attempt
    cancelledAtByKey.delete(key);
    activeTaskGenerationByKey.set(key, next);
    void disposeParked(key);
    return next;
}

export function isBrowserGenerationCurrent(
    familyId: string,
    userId: string,
    generation: number,
): boolean {
    return currentBrowserGeneration(familyId, userId) === generation;
}

export function hasParkedBrowserOtpSession(familyId: string, userId: string): boolean {
    const key = browserSessionKey(familyId, userId);
    const row = parked.get(key);
    if (!row) return false;
    if (row.aborted || Date.now() > row.expiresAt) {
        void disposeParked(key);
        return false;
    }
    return true;
}

export function parkBrowserForOtp(input: {
    familyId: string;
    userId: string;
    partner: string;
    goal: string;
    generation: number;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    taskInput: RunBrowserTaskInput;
}): { earlyOtp?: string } {
    const key = browserSessionKey(input.familyId, input.userId);
    const prev = parked.get(key);
    if (prev) {
        void closeBrowserQuiet(prev);
        parked.delete(key);
    }
    const now = Date.now();
    parked.set(key, {
        key,
        familyId: input.familyId,
        userId: input.userId,
        partner: input.partner,
        goal: input.goal,
        generation: input.generation,
        browser: input.browser,
        context: input.context,
        page: input.page,
        input: input.taskInput,
        createdAt: now,
        expiresAt: now + PARK_TTL_MS,
        aborted: false,
    });
    const t = setTimeout(() => {
        const row = parked.get(key);
        if (row && row.createdAt === now) void disposeParked(key);
    }, PARK_TTL_MS + 500);
    t.unref?.();

    const pending = pendingOtps.get(key);
    if (pending && now - pending.at <= PENDING_OTP_TTL_MS) {
        pendingOtps.delete(key);
        return { earlyOtp: pending.otp };
    }
    return {};
}

export function queuePendingBrowserOtp(familyId: string, userId: string, otp: string): void {
    const key = browserSessionKey(familyId, userId);
    pendingOtps.set(key, { otp: otp.trim(), at: Date.now() });
    const t = setTimeout(() => {
        const row = pendingOtps.get(key);
        if (row && row.otp === otp.trim()) pendingOtps.delete(key);
    }, PENDING_OTP_TTL_MS + 500);
    t.unref?.();
}

export function takeParkedBrowserOtpSession(
    familyId: string,
    userId: string,
): ParkedBrowserOtpSession | null {
    const key = browserSessionKey(familyId, userId);
    const row = parked.get(key);
    if (!row) return null;
    parked.delete(key);
    if (row.aborted || Date.now() > row.expiresAt) {
        void closeBrowserQuiet(row);
        return null;
    }
    return row;
}

export async function abortBrowserSessionForUser(
    familyId: string,
    userId: string,
    opts?: { phone?: string },
): Promise<void> {
    const key = browserSessionKey(familyId, userId);
    generationByKey.set(key, (generationByKey.get(key) ?? 0) + 1);
    pendingOtps.delete(key);
    lastOtpAskByKey.delete(key);
    otpSendClaimedByKey.delete(key);
    otpGotCodeAckByKey.delete(key);
    activeTaskGenerationByKey.delete(key);
    const now = Date.now();
    cancelledAtByKey.set(key, now);
    if (opts?.phone) {
        const phone = opts.phone.replace(/\D/g, "");
        if (phone) cancelledAtByPhone.set(phone, now);
    }
    const row = parked.get(key);
    if (row) {
        row.aborted = true;
        parked.delete(key);
        await closeBrowserQuiet(row);
    }
}

async function disposeParked(key: string): Promise<void> {
    const row = parked.get(key);
    if (!row) return;
    parked.delete(key);
    row.aborted = true;
    await closeBrowserQuiet(row);
}

async function closeBrowserQuiet(row: ParkedBrowserOtpSession): Promise<void> {
    try {
        await row.context.close();
    } catch {
        /* ignore */
    }
    try {
        await row.browser.close();
    } catch {
        /* ignore */
    }
}

export async function closeTakenPark(row: ParkedBrowserOtpSession): Promise<void> {
    await closeBrowserQuiet(row);
}

export function shouldSuppressDuplicateOtpAsk(
    familyId: string,
    userId: string,
    text: string,
): boolean {
    const key = browserSessionKey(familyId, userId);
    const norm = text.replace(/\s+/g, " ").trim().slice(0, 160);
    const looksOtpAsk =
        /paste.*(otp|code|sms)|login code|otp here|6-digit|4-digit|verification code|share the \d-digit otp/i.test(
            norm,
        );
    if (!looksOtpAsk) return false;
    const prev = lastOtpAskByKey.get(key);
    const now = Date.now();
    if (prev && now - prev.at < 60_000) return true;
    lastOtpAskByKey.set(key, { text: norm, at: now });
    return false;
}

export function clearOtpAskDedupe(familyId: string, userId: string): void {
    lastOtpAskByKey.delete(browserSessionKey(familyId, userId));
}

export const OTP_INPUT_SELECTOR =
    'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="OTP" i], input[placeholder*="one time" i], input[placeholder*="verification" i], input[aria-label*="otp" i], input[type="tel"], input[inputmode="numeric"]';

export async function fillOtpOnPage(
    page: Page,
    otp: string,
): Promise<{ filled: boolean; reason?: string }> {
    try {
        const code = otp.replace(/\D/g, "").slice(0, 8);
        if (!code) return { filled: false, reason: "empty_otp" };

        // Apollo (and similar): separate digit1..digitN boxes without maxlength=1
        const namedDigits = page.locator(
            'input[name^="digit"], input[id^="digit"], input[name*="otpDigit" i]',
        );
        const namedCount = await namedDigits.count().catch(() => 0);
        if (namedCount >= 4 && namedCount <= 8) {
            for (let i = 0; i < Math.min(namedCount, code.length); i++) {
                const box = namedDigits.nth(i);
                await box.click({ timeout: 3000 }).catch(() => undefined);
                await box.fill("").catch(() => undefined);
                await box.fill(code[i]!).catch(() => undefined);
            }
            await page.keyboard.press("Enter").catch(() => undefined);
            const verify = page.getByRole("button", {
                name: /^(verify|continue|submit|confirm|login|log in)$/i,
            });
            if (await verify.count()) {
                await verify.first().click({ timeout: 3000 }).catch(() => undefined);
            }
            await page.waitForTimeout(1500);
            return { filled: true };
        }

        const boxes = page.locator('input[maxlength="1"], input[aria-label*="digit" i]');
        const boxCount = await boxes.count().catch(() => 0);
        if (boxCount >= 4 && boxCount <= 8) {
            for (let i = 0; i < Math.min(boxCount, code.length); i++) {
                await boxes.nth(i).fill(code[i]!).catch(() => undefined);
            }
            await page.keyboard.press("Enter").catch(() => undefined);
            await page.waitForTimeout(1500);
            return { filled: true };
        }

        const dedicated =
            'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="OTP" i], input[placeholder*="one time" i], input[placeholder*="verification" i], input[aria-label*="otp" i]';
        let el = page.locator(dedicated).first();
        if (!(await el.count()) || !(await el.isVisible().catch(() => false))) {
            el = page.locator(OTP_INPUT_SELECTOR).first();
        }
        if (!(await el.count())) return { filled: false, reason: "no_otp_field" };
        await el.click({ timeout: 5000 }).catch(() => undefined);
        await el.fill("");
        await el.fill(code);
        await page.keyboard.press("Enter").catch(() => undefined);
        const verify = page.getByRole("button", {
            name: /^(verify|continue|submit|confirm|login|log in)$/i,
        });
        if (await verify.count()) {
            await verify.first().click({ timeout: 3000 }).catch(() => undefined);
        }
        await page.waitForTimeout(1500);
        return { filled: true };
    } catch (err) {
        return {
            filled: false,
            reason: err instanceof Error ? err.message.slice(0, 120) : "fill_failed",
        };
    }
}


/**
 * Claim the single Continue/Send-OTP for this generation.
 * Returns true only once — subsequent calls (Gemini / relaunch) get false.
 */
export function claimPharmacyOtpSend(
    familyId: string,
    userId: string,
    generation: number,
): boolean {
    const key = browserSessionKey(familyId, userId);
    if (!isBrowserGenerationCurrent(familyId, userId, generation)) return false;
    const claimed = otpSendClaimedByKey.get(key);
    if (claimed === generation) return false;
    otpSendClaimedByKey.set(key, generation);
    return true;
}

export function hasPharmacyOtpSendBeenClaimed(
    familyId: string,
    userId: string,
    generation: number,
): boolean {
    const key = browserSessionKey(familyId, userId);
    return otpSendClaimedByKey.get(key) === generation;
}

/** Drop send-claim after a failed bootstrap so WA won't treat digits as a real OTP paste. */
export function releasePharmacyOtpSendClaim(
    familyId: string,
    userId: string,
    generation: number,
): void {
    const key = browserSessionKey(familyId, userId);
    if (otpSendClaimedByKey.get(key) === generation) {
        otpSendClaimedByKey.delete(key);
    }
}

/**
 * Claim the single "Got the code — signing in" WhatsApp ACK for this generation.
 * Returns true only once — duplicate inbound OTP / webhook retries get false.
 */
export function claimGotCodeAck(
    familyId: string,
    userId: string,
    generation?: number,
): boolean {
    const key = browserSessionKey(familyId, userId);
    const gen = generation ?? currentBrowserGeneration(familyId, userId);
    if (gen <= 0) return false;
    if (!isBrowserGenerationCurrent(familyId, userId, gen)) return false;
    if (otpGotCodeAckByKey.get(key) === gen) return false;
    otpGotCodeAckByKey.set(key, gen);
    return true;
}

export function markBrowserCancelledForPhone(phone: string): void {
    const digits = phone.replace(/\D/g, "");
    if (digits) cancelledAtByPhone.set(digits, Date.now());
}

export function wasBrowserCancelledRecently(
    familyId: string,
    userId: string,
    withinMs = CANCEL_SUPPRESS_MS,
): boolean {
    const at = cancelledAtByKey.get(browserSessionKey(familyId, userId));
    return Boolean(at && Date.now() - at < withinMs);
}

export function wasBrowserCancelledRecentlyByPhone(
    phone: string,
    withinMs = CANCEL_SUPPRESS_MS,
): boolean {
    const digits = phone.replace(/\D/g, "");
    const at = cancelledAtByPhone.get(digits);
    return Boolean(at && Date.now() - at < withinMs);
}

/** True when a parked OTP page or draft should suppress "still working" SLA spam. */
export function shouldSuppressStillWorkingFallback(input: {
    phone?: string;
    familyId?: string;
    userId?: string;
    browserTaskPhase?: string | null;
    hasPendingCommerceOtp?: boolean;
    hasPharmacyDraft?: boolean;
}): boolean {
    if (input.phone && wasBrowserCancelledRecentlyByPhone(input.phone)) return true;
    if (
        input.familyId &&
        input.userId &&
        wasBrowserCancelledRecently(input.familyId, input.userId)
    ) {
        return true;
    }
    if (
        input.familyId &&
        input.userId &&
        hasParkedBrowserOtpSession(input.familyId, input.userId)
    ) {
        return true;
    }
    const phase = (input.browserTaskPhase || "").toLowerCase();
    if (phase === "awaiting_otp" || phase === "running" || phase === "awaiting_confirm") {
        return true;
    }
    if (input.hasPendingCommerceOtp) return true;
    // Pharmacy draft mid-flight (confirm kicked browser) — avoid still-working loop
    if (input.hasPharmacyDraft) return true;
    return false;
}

export function isActiveBrowserTaskGeneration(
    familyId: string,
    userId: string,
    generation: number,
): boolean {
    const key = browserSessionKey(familyId, userId);
    return activeTaskGenerationByKey.get(key) === generation;
}

export function clearActiveBrowserTask(familyId: string, userId: string, generation: number): void {
    const key = browserSessionKey(familyId, userId);
    if (activeTaskGenerationByKey.get(key) === generation) {
        activeTaskGenerationByKey.delete(key);
    }
}

export function _parkedSessionCountForTests(): number {
    return parked.size;
}
