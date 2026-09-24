/**
 * Browser worker interface + Playwright (prod Cloud Run + local) + DryRun fallback.
 *
 * Env:
 *   BROWSER_WORKER_MODE=playwright|dry_run|auto  (default auto)
 *   auto → playwright if Chromium launchable, else dry_run
 * Cloud Run image installs Chromium (bookworm + playwright --with-deps); prefer auto|playwright in prod.
 */
import type { BrowserAction } from "./geminiComputerUse.service";
import { planBrowserActions } from "./geminiComputerUse.service";
import {
    getOrCreateBrowserProfile,
    saveBrowserProfileState,
} from "./browserProfile.service";
import { resolvePlaybook, partnerLabel } from "./playbooks";
import type { CommercePartnerKey } from "./types";
import {
    bootstrapPharmacyLogin,
    type PharmacyLoginStage,
} from "./pharmacyLogin.bootstrap";
import {
    beginBrowserGeneration,
    closeTakenPark,
    fillOtpOnPage,
    hasParkedBrowserOtpSession,
    isBrowserGenerationCurrent,
    parkBrowserForOtp,
    takeParkedBrowserOtpSession,
} from "./parkedOtpSession.service";

export type BrowserTaskStatus =
    | "running"
    | "need_otp"
    | "need_user_confirm"
    | "done"
    | "error"
    | "cancelled";

export type BrowserFailureReason =
    | "captcha"
    | "timeout"
    | "no_login_button"
    | "chromium_crash"
    | "site_slow"
    | "busy"
    | "disabled"
    | "unknown";

export type BrowserTaskResult = {
    status: BrowserTaskStatus;
    message: string;
    steps: number;
    url?: string;
    modelUsed?: string;
    mode: "playwright" | "dry_run";
    confirm?: {
        items?: string[];
        totalLabel?: string;
        addressLabel?: string;
    };
    partner?: string;
    /** Typed soft-failure for WA copy (CAPTCHA vs timeout vs no login UI). */
    failureReason?: BrowserFailureReason;
    /** Optional local screenshot path when a step failed (Cloud Run /tmp). */
    screenshotPath?: string;
};

export type BrowserProgressStage =
    | "queued"
    | "launching"
    | "opening"
    | "homepage"
    | "login_page"
    | "phone_entered"
    | "otp_ready"
    | "searching"
    | "busy";

export type RunBrowserTaskInput = {
    familyId: string;
    userId: string;
    goal: string;
    partner?: CommercePartnerKey | "generic";
    /** Override playbook start URL (product link or resolved domain). */
    startUrl?: string;
    /** Resume after OTP paste */
    otp?: string;
    /** Resume after WhatsApp confirm */
    userConfirmed?: boolean;
    /** Cap Gemini/playwright steps */
    maxSteps?: number;
    /** Soft care tips for confirm card (already formatted or raw). */
    healthHintCopy?: string;
    /** Hard wall-clock deadline for this task (WhatsApp SLA). Default ~28s. */
    deadlineMs?: number;
    /**
     * Elder WhatsApp / account phone for pharmacy (and ride) OTP request.
     * Prefer E.164; bootstrap uses last 10 digits for IN sites.
     */
    loginPhone?: string;
    /** Live WA stage updates while Chromium works (non-blocking). */
    onProgress?: (stage: BrowserProgressStage, detail: string) => void | Promise<void>;
    /** Per-user generation — stale tasks no-op after cancel. */
    browserGeneration?: number;
};

export interface BrowserWorker {
    readonly mode: "playwright" | "dry_run";
    runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult>;
}

function configuredMode(): "playwright" | "dry_run" | "auto" {
    const raw = (process.env.BROWSER_WORKER_MODE || "auto").trim().toLowerCase();
    if (raw === "playwright" || raw === "dry_run" || raw === "auto") return raw;
    return "auto";
}

let playwrightAvailable: boolean | null = null;

/** Serialize Playwright sessions in-process (Cloud Run concurrency=1 still allows overlapping fire-and-forget). */
let browserGate: Promise<void> = Promise.resolve();

async function withBrowserGate<T>(
    fn: () => Promise<T>,
    onQueued?: () => void | Promise<void>,
): Promise<T> {
    const prev = browserGate;
    let release!: () => void;
    browserGate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const waited = Promise.race([
        prev.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 400)),
    ]);
    if (await waited) {
        try {
            await onQueued?.();
        } catch {
            /* ignore */
        }
    }
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

async function notifyProgress(
    input: RunBrowserTaskInput,
    stage: BrowserProgressStage,
    detail: string,
): Promise<void> {
    if (
        input.browserGeneration != null &&
        !isBrowserGenerationCurrent(input.familyId, input.userId, input.browserGeneration)
    ) {
        return;
    }
    try {
        await input.onProgress?.(stage, detail);
    } catch (err) {
        console.warn(
            "browser onProgress failed:",
            err instanceof Error ? err.message : err,
        );
    }
}

function isTaskCancelled(input: RunBrowserTaskInput): boolean {
    return (
        input.browserGeneration != null &&
        !isBrowserGenerationCurrent(input.familyId, input.userId, input.browserGeneration)
    );
}

async function saveFailureScreenshot(
    page: import("playwright").Page | null | undefined,
    tag: string,
): Promise<string | undefined> {
    if (!page) return undefined;
    try {
        const fs = await import("fs/promises");
        const pathMod = await import("path");
        const dir = process.env.BROWSER_SCREENSHOT_DIR || "/tmp/saheli-browser-fail";
        await fs.mkdir(dir, { recursive: true });
        const file = pathMod.join(dir, `${tag}-${Date.now()}.png`);
        await page.screenshot({ path: file, fullPage: false, type: "png" });
        console.warn("browser failure screenshot:", file);
        return file;
    } catch (err) {
        console.warn(
            "browser failure screenshot failed:",
            err instanceof Error ? err.message : err,
        );
        return undefined;
    }
}

/** Race a promise against a hard deadline; clears timer either way. */
export async function raceWithDeadline<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} timed out after ${ms}ms`)),
                    ms,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function browserTaskDeadlineMs(input?: {
    deadlineMs?: number;
    partner?: string;
    goal?: string;
}): number {
    const envN = Number(process.env.BROWSER_TASK_DEADLINE_MS);
    const pharmacy =
        isPharmacyPartnerKey(String(input?.partner || "")) ||
        /\b(apollo|pharmeasy|1\s*mg|medicine|vitamin)\b/i.test(input?.goal || "");
    const fallback = pharmacy ? 75_000 : 28_000;
    const raw = input?.deadlineMs ?? (Number.isFinite(envN) ? envN : fallback);
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    // Pharmacy cold Chromium + login needs more headroom than rides' WA SLA.
    return Math.min(Math.max(n, 5_000), 90_000);
}

async function canLaunchChromium(): Promise<boolean> {
    if (playwrightAvailable != null) return playwrightAvailable;
    if (configuredMode() === "dry_run") {
        playwrightAvailable = false;
        return false;
    }
    if (configuredMode() === "playwright") {
        playwrightAvailable = true;
        return true;
    }
    try {
        // Dynamic import so Cloud Run alpine builds don't hard-fail without playwright
        const pw = await import("playwright");
        const launchProbeMs = Math.min(
            Number(process.env.BROWSER_LAUNCH_PROBE_MS) || 8_000,
            20_000,
        );
        const browser = await raceWithDeadline(
            pw.chromium.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-dev-shm-usage"],
            }),
            launchProbeMs,
            "Playwright Chromium launch probe",
        );
        await browser.close();
        playwrightAvailable = true;
        return true;
    } catch (err) {
        console.warn(
            "Playwright Chromium unavailable — using dry_run browser worker:",
            err instanceof Error ? err.message : err,
        );
        playwrightAvailable = false;
        return false;
    }
}

/** Tiny 1x1 PNG so dry-run / fallback still has a valid multimodal payload shape. */
const TINY_PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function attachHealthHints(
    input: RunBrowserTaskInput,
    message: string,
    itemNames: string[],
): Promise<string> {
    if (input.healthHintCopy) {
        return message.includes("Saheli tip") ? message : `${message}${input.healthHintCopy}`;
    }
    try {
        const {
            buildCommerceHealthSuggestions,
            formatCommerceHealthSuggestionsForCopy,
        } = await import("../saheliCommerceHealthHints.service");
        const tips = await buildCommerceHealthSuggestions({
            familyId: input.familyId,
            recipientUserId: input.userId,
            cartItemNames: itemNames.length ? itemNames : [input.goal.slice(0, 120)],
        });
        const copy = formatCommerceHealthSuggestionsForCopy(tips);
        if (!copy) return message;
        return message.includes("Saheli tip") ? message : `${message}${copy}`;
    } catch {
        return message;
    }
}


function isRideGoal(goal: string, partner?: string): boolean {
    if (partner === "uber" || partner === "ola" || partner === "rapido") return true;
    return /\bBOOK_RIDE\b/i.test(goal) || /\b(book|need)\s+(a\s+)?(cab|ride|uber)\b/i.test(goal);
}

function dryRunRideFaresMessage(goal: string, partnerLabelStr: string): {
    message: string;
    confirm: BrowserTaskResult["confirm"];
} {
    const pickup = goal.match(/pickup=([^|]+)/i)?.[1]?.trim() || "pickup";
    const drop = goal.match(/drop=([^|]+)/i)?.[1]?.trim() || "drop";
    const items = [
        "UberX ≈ ₹180–220 · 8 min",
        "Comfort ≈ ₹240–280 · 10 min",
        "Premier ≈ ₹320–380 · 12 min",
    ];
    const message = [
        `*${partnerLabelStr} fares* — confirm before book:`,
        `Route: ${pickup} → ${drop}`,
        ...items.map((i) => `• ${i}`),
        ``,
        `Reply *book* / *confirm* for UberX, or *cancel*.`,
        `_Dry-run mode: fares stubbed; nothing booked until you confirm._`,
    ].join("\n");
    return {
        message,
        confirm: {
            items,
            totalLabel: "≈ ₹180–220",
            addressLabel: `${pickup} → ${drop}`,
        },
    };
}

function extractItemGuess(goal: string): string[] {
    const cleaned = goal
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/\b(order|buy|get|purchase|from|on|via|please|for me)\b/gi, " ")
        .replace(
            /\b(amazon|flipkart|myntra|bigbasket|big basket|jiomart|dmart|blinkit|apollo|instamart|swiggy|zepto|pharmeasy|1mg)\b/gi,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
    return cleaned ? [cleaned.slice(0, 80)] : [goal.slice(0, 80)];
}



function isPharmacyPartnerKey(partner: string): boolean {
    return /^(apollo|pharmeasy|tata_1mg)$/i.test(partner);
}

/** Detect CAPTCHA / bot walls / geo-unavailable on ride or pharmacy pages. */
async function detectCommerceSiteBlock(
    page: import("playwright").Page,
    partner: string,
    goal: string,
): Promise<string | null> {
    const ride = isRideGoal(goal, partner);
    const pharmacy = isPharmacyPartnerKey(partner) || /\b(apollo|pharmeasy|1\s*mg)\b/i.test(goal);
    if (!ride && !pharmacy) return null;
    const label = partnerLabel(partner);
    try {
        const blob = await page.evaluate(() => {
            const t = (document.body?.innerText || "").slice(0, 4000).toLowerCase();
            const title = (document.title || "").toLowerCase();
            return `${title}\n${t}`;
        });
        if (/captcha|unusual traffic|are you a robot|cf-browser-verification|access denied|bot detection|cloudflare/i.test(blob)) {
            if (ride) {
                return "Uber blocked the browser session (CAPTCHA / bot check). Try again later or book in the Uber app — nothing was booked.";
            }
            return `${label} blocked the browser session (CAPTCHA / bot check). Reply *retry* or *cancel* — nothing was ordered.`;
        }
        if (
            ride &&
            /not available in (your|this) (area|region|city)|service (is )?unavailable|we don't operate|doesn't operate here|no cars? available|couldn't find a ride/.test(
                blob,
            )
        ) {
            return "Uber isn't available for that area right now (geo / no cars). Nothing was booked — try a different pickup or the Uber app.";
        }
    } catch {
        /* ignore */
    }
    return null;
}

/** @deprecated use detectCommerceSiteBlock */
async function detectRideSiteBlock(
    page: import("playwright").Page,
): Promise<string | null> {
    return detectCommerceSiteBlock(page, "uber", "BOOK_RIDE provider=uber");
}

class DryRunBrowserWorker implements BrowserWorker {
    readonly mode = "dry_run" as const;

    async runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
        const playbook = resolvePlaybook(input.partner, input.goal, input.startUrl);
        try {
            await getOrCreateBrowserProfile(input.familyId, input.userId);
        } catch {
            /* offline smoke */
        }

        if (input.otp && !input.userConfirmed) {
            if (isRideGoal(input.goal, String(playbook.partner))) {
                const fare = dryRunRideFaresMessage(
                    input.goal,
                    partnerLabel(String(playbook.partner)),
                );
                return {
                    status: "need_user_confirm",
                    mode: "dry_run",
                    partner: String(playbook.partner),
                    steps: 1,
                    url: playbook.startUrl,
                    message: fare.message,
                    confirm: fare.confirm,
                };
            }
            const items = extractItemGuess(input.goal);
            let message = [
                `*${partnerLabel(String(playbook.partner))} basket* — confirm before pay:`,
                `• ${items[0] || input.goal.slice(0, 120)}`,
                ``,
                `Deliver to: your saved address`,
                `Total: I'll show the live total when Chromium checkout is live`,
                ``,
                `Reply *confirm* to continue checkout, or *cancel*.`,
                `_Dry-run mode: browser worker is stubbed on this host (no Chromium). OTP recorded; payment still needs your explicit confirm._`,
            ].join("\n");
            message = await attachHealthHints(input, message, items);
            return {
                status: "need_user_confirm",
                mode: "dry_run",
                partner: String(playbook.partner),
                steps: 1,
                url: playbook.startUrl,
                message,
                confirm: {
                    items,
                    totalLabel: "TBD",
                    addressLabel: "saved address",
                },
            };
        }

        if (input.userConfirmed) {
            if (isRideGoal(input.goal, String(playbook.partner))) {
                return {
                    status: "done",
                    mode: "dry_run",
                    partner: String(playbook.partner),
                    steps: 2,
                    url: playbook.startUrl,
                    message: [
                        `Booked *UberX* — driver on the way.`,
                        `• Driver: *Ravi K.*`,
                        `• Car: White Swift Dzire`,
                        `• Plate: *KA-01-AB-4231*`,
                        `• ETA: ~8 min`,
                        `_Dry-run: no real trip created. No silent book — you confirmed in chat._`,
                    ].join("\n"),
                };
            }
            return {
                status: "done",
                mode: "dry_run",
                partner: String(playbook.partner),
                steps: 2,
                url: playbook.startUrl,
                message: [
                    `Confirmed — I'll complete ${partnerLabel(String(playbook.partner))} checkout when live Chromium is available on this host.`,
                    `If UPI is required, open the partner app and pay the pending order, or wait for Saheli browser pay support.`,
                    `_No silent pay — you confirmed in chat._`,
                ].join("\n"),
            };
        }

        // Fresh goal → ask for OTP (Instinct-like login) then confirm / fare
        if (isRideGoal(input.goal, String(playbook.partner))) {
            return {
                status: "need_otp",
                mode: "dry_run",
                partner: String(playbook.partner),
                steps: 0,
                url: playbook.startUrl,
                message: [
                    `Opening *${partnerLabel(String(playbook.partner))}* for your ride…`,
                    ``,
                    `${partnerLabel(String(playbook.partner))} may text a 4-digit code — *forward or paste it here*.`,
                    `(I never read your device SMS — only what you send me on WhatsApp.)`,
                    ``,
                    `Reply *cancel* to stop — nothing booked yet.`,
                ].join("\n"),
            };
        }
        return {
            status: "need_otp",
            mode: "dry_run",
            partner: String(playbook.partner),
            steps: 0,
            url: playbook.startUrl,
            message: [
                `Opening *${partnerLabel(String(playbook.partner))}* for: ${input.goal.slice(0, 120)}`,
                ``,
                `${partnerLabel(String(playbook.partner))} may text a login code — *paste the SMS OTP here*.`,
                `(I never read your device SMS — only what you send me on WhatsApp.)`,
                ``,
                `Reply *cancel* to stop.`,
            ].join("\n"),
        };
    }
}

class PlaywrightBrowserWorker implements BrowserWorker {
    readonly mode = "playwright" as const;

    async runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
        const maxSteps = Math.min(input.maxSteps ?? 20, 30);
        const playbook = resolvePlaybook(input.partner, input.goal, input.startUrl);
        const profile = await getOrCreateBrowserProfile(input.familyId, input.userId);

        let pw: typeof import("playwright");
        try {
            pw = await import("playwright");
        } catch (err) {
            console.warn("playwright import failed, falling back to dry_run", err);
            return new DryRunBrowserWorker().runBrowserTask(input);
        }

        const launchMs = Math.min(Number(process.env.BROWSER_LAUNCH_MS) || 15_000, 45_000);
        const browser = await raceWithDeadline(
            pw.chromium.launch({
                headless: true,
                args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            }),
            launchMs,
            "Playwright chromium.launch",
        );

        let context: import("playwright").BrowserContext | null = null;
        let modelUsed: string | undefined;
        let steps = 0;
        let retainBrowser = false;

        try {
            if (isTaskCancelled(input)) {
                await browser.close().catch(() => undefined);
                return {
                    status: "cancelled",
                    message: "Cancelled.",
                    steps: 0,
                    mode: "playwright",
                    partner: String(playbook.partner),
                };
            }
            const storageState = profile.storageStateJson
                ? (JSON.parse(profile.storageStateJson) as object)
                : undefined;

            const ride = isRideGoal(input.goal, String(playbook.partner));
            const mobileUa =
                "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
            const desktopUa =
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
            context = await browser.newContext({
                storageState: storageState as import("playwright").BrowserContextOptions["storageState"],
                viewport: ride
                    ? { width: 390, height: 844 }
                    : { width: 1280, height: 720 },
                userAgent: ride ? mobileUa : desktopUa,
                isMobile: ride,
                hasTouch: ride,
            });
            const page = await context.newPage();
            await page.goto(playbook.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

            // Clear CAPTCHA / bot / geo blocks before burning Gemini steps (rides + pharmacy)
            const earlyBlock = await detectCommerceSiteBlock(
                page,
                String(playbook.partner),
                input.goal,
            ).catch(() => null);
            if (earlyBlock) {
                const shot = await saveFailureScreenshot(page, `block-${playbook.partner}`);
                await this.persist(context, input, playbook.partner, page.url());
                return {
                    status: "error",
                    message: earlyBlock,
                    steps: 0,
                    url: page.url(),
                    mode: "playwright",
                    partner: String(playbook.partner),
                    failureReason: "captcha",
                    screenshotPath: shot,
                };
            }

            const pharmacyPartner =
                isPharmacyPartnerKey(String(playbook.partner)) ||
                /\b(apollo|pharmeasy|1\s*mg|medicine|vitamin)\b/i.test(input.goal);

            // Deterministic pharmacy Login → phone → OTP (before Gemini burns the deadline)
            if (pharmacyPartner && !input.otp && !input.userConfirmed && input.loginPhone) {
                await notifyProgress(
                    input,
                    "homepage",
                    `still opening *${partnerLabel(String(playbook.partner))}*…`,
                );
                const boot = await bootstrapPharmacyLogin({
                    page,
                    partner: String(playbook.partner),
                    loginPhone: input.loginPhone,
                    isCancelled: () => isTaskCancelled(input),
                    onProgress: async (stage: PharmacyLoginStage, detail: string) => {
                        const mapped =
                            stage === "login_page"
                                ? "login_page"
                                : stage === "phone_entered"
                                  ? "phone_entered"
                                  : stage === "otp_ready"
                                    ? "otp_ready"
                                    : stage === "homepage"
                                      ? "homepage"
                                      : "opening";
                        await notifyProgress(input, mapped as BrowserProgressStage, detail);
                    },
                });
                if (boot.ok && boot.status === "need_otp") {
                    await this.persist(context, input, playbook.partner, page.url());
                    if (context && !isTaskCancelled(input)) {
                        const gen =
                            input.browserGeneration ??
                            beginBrowserGeneration(input.familyId, input.userId);
                        const early = parkBrowserForOtp({
                            familyId: input.familyId,
                            userId: input.userId,
                            partner: String(playbook.partner),
                            goal: input.goal,
                            generation: gen,
                            browser,
                            context,
                            page,
                            taskInput: input,
                        });
                        retainBrowser = true;
                        context = null;
                        if (early.earlyOtp) {
                            const filled = await fillOtpOnPage(page, early.earlyOtp);
                            if (filled.filled) {
                                (input as { otp?: string }).otp = early.earlyOtp;
                                retainBrowser = false;
                                const taken = takeParkedBrowserOtpSession(
                                    input.familyId,
                                    input.userId,
                                );
                                if (taken) context = taken.context;
                            }
                        }
                        if (retainBrowser) {
                            return {
                                status: "need_otp",
                                message: boot.message,
                                steps: 1,
                                url: page.url(),
                                mode: "playwright",
                                partner: String(playbook.partner),
                            };
                        }
                    } else {
                        return {
                            status: "need_otp",
                            message: boot.message,
                            steps: 1,
                            url: page.url(),
                            mode: "playwright",
                            partner: String(playbook.partner),
                        };
                    }
                }
                if (!boot.ok) {
                    const shot =
                        boot.failureReason === "disabled"
                            ? undefined
                            : await saveFailureScreenshot(
                                  page,
                                  `login-${playbook.partner}-${boot.failureReason}`,
                              );
                    await this.persist(context, input, playbook.partner, page.url());
                    return {
                        status: "error",
                        message: boot.message,
                        steps: 0,
                        url: page.url(),
                        mode: "playwright",
                        partner: String(playbook.partner),
                        failureReason:
                            boot.failureReason === "disabled"
                                ? "disabled"
                                : boot.failureReason,
                        screenshotPath: shot,
                    };
                }
                // already_logged_in → fall through to Gemini search/cart loop
                await notifyProgress(
                    input,
                    "searching",
                    `*${partnerLabel(String(playbook.partner))}* signed in — finding your medicines…`,
                );
            } else if (pharmacyPartner && !input.otp && !input.userConfirmed && !input.loginPhone) {
                console.warn(
                    "pharmacy browser task missing loginPhone — Gemini must find Login unaided",
                );
            }

            // If OTP provided, try typing into focused/OTP field first
            if (input.otp) {
                try {
                    await fillOtpOnPage(page, input.otp);
                } catch {
                    /* continue to AI loop */
                }
            }

            let userConfirmed = Boolean(input.userConfirmed);

            while (steps < maxSteps) {
                steps += 1;
                const screenshot = await page.screenshot({ type: "png", fullPage: false });
                const url = page.url();
                const title = await page.title().catch(() => "");
                let accessibilityHint = "";
                try {
                    accessibilityHint = await page.evaluate(() => {
                        const texts = Array.from(document.querySelectorAll("h1,h2,button,a,[role=button]"))
                            .slice(0, 40)
                            .map((n) => (n.textContent || "").trim().slice(0, 60))
                            .filter(Boolean);
                        return texts.join(" | ").slice(0, 800);
                    });
                } catch {
                    /* ignore */
                }

                {
                    const midBlock = await detectCommerceSiteBlock(
                        page,
                        String(playbook.partner),
                        input.goal,
                    ).catch(() => null);
                    if (midBlock) {
                        await this.persist(context, input, playbook.partner, page.url());
                        return {
                            status: "error",
                            message: midBlock,
                            steps,
                            url: page.url(),
                            modelUsed,
                            mode: "playwright",
                            partner: String(playbook.partner),
                        };
                    }
                }

                const planned = await planBrowserActions({
                    screenshotBase64: screenshot.toString("base64"),
                    mimeType: "image/png",
                    url,
                    title,
                    accessibilityHint,
                    goal: input.goal,
                    playbookHint: `${playbook.searchHint} ${playbook.otpHint} ${playbook.confirmHint}${
                        input.loginPhone ? ` login_phone=${input.loginPhone}` : ""
                    }`,
                    step: steps,
                    maxSteps,
                    otpProvided: Boolean(input.otp),
                    userConfirmed,
                });
                modelUsed = planned.modelUsed;

                for (const action of planned.actions) {
                    const gated = await this.applyAction(page, action, {
                        userConfirmed,
                        goal: input.goal,
                    });
                    if (gated.halt) {
                        await this.persist(context, input, playbook.partner, page.url());
                        let msg = gated.message!;
                        if (gated.status === "need_user_confirm") {
                            msg = await attachHealthHints(
                                input,
                                msg,
                                gated.confirm?.items ?? extractItemGuess(input.goal),
                            );
                        }
                        if (
                            gated.status === "need_otp" &&
                            context &&
                            !isTaskCancelled(input)
                        ) {
                            const gen =
                                input.browserGeneration ??
                                beginBrowserGeneration(input.familyId, input.userId);
                            parkBrowserForOtp({
                                familyId: input.familyId,
                                userId: input.userId,
                                partner: String(playbook.partner),
                                goal: input.goal,
                                generation: gen,
                                browser,
                                context,
                                page,
                                taskInput: input,
                            });
                            retainBrowser = true;
                            context = null;
                        }
                        return {
                            status: gated.status!,
                            message: msg,
                            steps,
                            url: page.url(),
                            modelUsed,
                            mode: "playwright",
                            confirm: gated.confirm,
                            partner: String(playbook.partner),
                        };
                    }
                    if (action.type === "need_user_confirm") {
                        // Should have halted above
                    }
                }
            }

            await this.persist(context, input, playbook.partner, page.url());
            return {
                status: "error",
                message: "I hit the step limit before finishing — reply with the goal again or *cancel*.",
                steps,
                url: page.url(),
                modelUsed,
                mode: "playwright",
                partner: String(playbook.partner),
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn("Playwright browser task failed:", msg);
            return {
                status: "error",
                message: `Browser task failed: ${msg.slice(0, 200)}. You can retry or *cancel*.`,
                steps,
                modelUsed,
                mode: "playwright",
                partner: String(playbook.partner),
            };
        } finally {
            if (!retainBrowser) {
                try {
                    await context?.close();
                } catch {
                    /* ignore */
                }
                await browser.close().catch(() => undefined);
            }
        }
    }

    private async persist(
        context: import("playwright").BrowserContext | null,
        input: RunBrowserTaskInput,
        partner: string,
        url: string,
    ): Promise<void> {
        if (!context) return;
        try {
            const state = await context.storageState();
            await saveBrowserProfileState({
                familyId: input.familyId,
                userId: input.userId,
                storageStateJson: JSON.stringify(state),
                lastPartner: partner,
                lastUrl: url,
            });
        } catch (err) {
            console.warn(
                "persist browser profile failed:",
                err instanceof Error ? err.message : err,
            );
        }
    }

    private async applyAction(
        page: import("playwright").Page,
        action: BrowserAction,
        ctx: { userConfirmed: boolean; goal: string },
    ): Promise<{
        halt: boolean;
        status?: BrowserTaskStatus;
        message?: string;
        confirm?: BrowserTaskResult["confirm"];
    }> {
        if (action.type === "need_otp") {
            return {
                halt: true,
                status: "need_otp",
                message:
                    action.message ||
                    "Paste the SMS OTP here (I don't read your phone SMS).",
            };
        }
        if (action.type === "need_user_confirm") {
            if (ctx.userConfirmed) {
                return { halt: false };
            }
            const items = action.confirm?.items?.length
                ? action.confirm.items
                : [ctx.goal.slice(0, 80)];
            const ride = isRideGoal(ctx.goal);
            const lines = ride
                ? [
                      `*Confirm before book:*`,
                      ...items.map((i) => `• ${i}`),
                      ``,
                      action.confirm?.addressLabel
                          ? `Route: ${action.confirm.addressLabel}`
                          : "",
                      action.confirm?.totalLabel
                          ? `Selected: ${action.confirm.totalLabel}`
                          : "",
                      ``,
                      `Reply *book* / *confirm* to request the ride, or *cancel*.`,
                      `_No silent book — nothing is booked until you confirm._`,
                      action.message ? `\n${action.message}` : "",
                  ]
                : [
                      `*Confirm before pay:*`,
                      ...items.map((i) => `• ${i}`),
                      ``,
                      `Total: ${action.confirm?.totalLabel || "see site"}`,
                      `Deliver to: ${action.confirm?.addressLabel || "your saved address"}`,
                      ``,
                      `Reply *confirm* to continue, or *cancel*.`,
                      action.message ? `\n${action.message}` : "",
                  ];
            return {
                halt: true,
                status: "need_user_confirm",
                message: lines.filter(Boolean).join("\n"),
                confirm: action.confirm ?? { items },
            };
        }
        if (action.type === "done") {
            return {
                halt: true,
                status: "done",
                message: action.message || "Done.",
            };
        }

        // Safety: never click pay / request-ride without confirm
        if (!ctx.userConfirmed && (action.type === "click" || action.type === "press")) {
            const t = `${action.text || ""} ${action.selector || ""} ${action.message || ""}`.toLowerCase();
            if (/\b(pay now|place order|confirm.*pay|upi)\b/.test(t)) {
                return {
                    halt: true,
                    status: "need_user_confirm",
                    message:
                        "Ready to pay — reply *confirm* with item/total/address check, or *cancel*.",
                };
            }
            if (
                isRideGoal(ctx.goal) &&
                /\b(request\s*(uber|ride)?|confirm\s*(ride|booking|trip)|book\s*(now|ride|uber)|schedule\s*ride)\b/.test(
                    t,
                )
            ) {
                return {
                    halt: true,
                    status: "need_user_confirm",
                    message:
                        "Ready to book — reply *book* / *confirm* with fare + ride type check, or *cancel*.",
                };
            }
        }

        try {
            switch (action.type) {
                case "goto":
                    if (action.url) {
                        await page.goto(action.url, {
                            waitUntil: "domcontentloaded",
                            timeout: 45000,
                        });
                    }
                    break;
                case "click": {
                    if (action.selector) {
                        await page.locator(action.selector).first().click({ timeout: 8000 });
                    } else if (typeof action.x === "number" && typeof action.y === "number") {
                        const vp = page.viewportSize() || { width: 1280, height: 720 };
                        const cx = Math.round((action.x / 1000) * vp.width);
                        const cy = Math.round((action.y / 1000) * vp.height);
                        await page.mouse.click(cx, cy);
                    }
                    break;
                }
                case "type":
                    if (action.selector) {
                        await page.locator(action.selector).first().fill(action.text || "");
                    } else {
                        await page.keyboard.type(action.text || "", { delay: 20 });
                    }
                    break;
                case "press":
                    await page.keyboard.press(action.key || "Enter");
                    break;
                case "scroll":
                    await page.mouse.wheel(0, action.direction === "up" ? -600 : 600);
                    break;
                case "wait":
                    await page.waitForTimeout(action.ms ?? 800);
                    break;
                default:
                    break;
            }
        } catch (err) {
            console.warn(
                "browser action failed:",
                action.type,
                err instanceof Error ? err.message : err,
            );
        }
        return { halt: false };
    }
}

let cachedWorker: BrowserWorker | null = null;

export async function getBrowserWorker(): Promise<BrowserWorker> {
    if (cachedWorker) return cachedWorker;
    const ok = await canLaunchChromium();
    cachedWorker = ok ? new PlaywrightBrowserWorker() : new DryRunBrowserWorker();
    console.log(`Saheli browser worker mode: ${cachedWorker.mode}`);
    return cachedWorker;
}

function progressNeedOtpResult(input: RunBrowserTaskInput, reason: string): BrowserTaskResult {
    const playbook = resolvePlaybook(input.partner, input.goal, input.startUrl);
    const label = partnerLabel(String(playbook.partner));
    console.warn("Browser task deadline/fallback:", reason);
    const ride = isRideGoal(input.goal, String(playbook.partner));
    const pharmacy =
        isPharmacyPartnerKey(String(playbook.partner)) ||
        /\b(apollo|pharmeasy|1\s*mg|medicine|vitamin)\b/i.test(input.goal);
    const busy = /browser gate|queued|busy/i.test(reason);
    const crash = /chromium|launch|Target closed|browser has been closed/i.test(reason);
    const failureReason: BrowserFailureReason = crash
        ? "chromium_crash"
        : busy
          ? "busy"
          : "timeout";
    return {
        // steps:0 signals follow-up formatter: OTP page likely never reached
        status: "need_otp",
        mode: "playwright",
        partner: String(playbook.partner),
        steps: 0,
        url: playbook.startUrl,
        failureReason,
        message: ride
            ? [
                  `Opening *${label}* for your ride…`,
                  ``,
                  `This is taking a moment — if you get an SMS OTP, *paste it here*.`,
                  `(I never read your device SMS — only what you send me on WhatsApp.)`,
                  ``,
                  `Reply *cancel* to stop — nothing is booked yet.`,
              ].join("\n")
            : pharmacy
              ? [
                    failureReason === "chromium_crash"
                        ? `*${label}* browser crashed before login (Chromium).`
                        : failureReason === "busy"
                          ? `*${label}* is waiting — browser was busy with another task and hit the time limit.`
                          : `*${label}* didn't reach the login-code step in time (site slow or login UI not reached).`,
                    `No SMS from ${label} is expected until login actually starts.`,
                    ``,
                    `Reply *retry* to try again, or *cancel* to stop.`,
                    `If a code arrives later, you can still *paste the OTP here*.`,
                ].join("\n")
              : [
                    `Opening *${label}* for: ${input.goal.slice(0, 120)}`,
                    ``,
                    `This is taking a moment — if you get an SMS OTP, *paste it here*.`,
                    `(I never read your device SMS — only what you send me on WhatsApp.)`,
                    ``,
                    `Or reply *cancel* to stop. I can also take a medicine list / pharmacy confirm without waiting on the browser.`,
                ].join("\n"),
    };
}

/** Public API — per-user profile + run. Always respects a hard WhatsApp-facing deadline. */
export async function runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
    const deadlineMs = browserTaskDeadlineMs(input);
    try {
        return await withBrowserGate(
            async () => {
                await notifyProgress(input, "launching", "still opening the browser…");
                const worker = await raceWithDeadline(
                    getBrowserWorker(),
                    Math.min(10_000, deadlineMs),
                    "getBrowserWorker",
                );
                return await raceWithDeadline(
                    worker.runBrowserTask(input),
                    deadlineMs,
                    "runBrowserTask",
                );
            },
            async () => {
                await notifyProgress(
                    input,
                    "busy",
                    "browser busy with another task — still opening…",
                );
            },
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out/i.test(msg)) {
            return progressNeedOtpResult(input, msg);
        }
        console.warn("runBrowserTask failed:", msg);
        const crash = /chromium|launch|Target closed|browser has been closed/i.test(msg);
        return {
            status: "error",
            mode: "playwright",
            partner: String(input.partner || "generic"),
            steps: 0,
            failureReason: crash ? "chromium_crash" : "unknown",
            message: `Browser task failed: ${msg.slice(0, 180)}. You can retry, paste an OTP if you have one, or *cancel*.`,
        };
    }
}



/** Inject WA-pasted OTP into a parked live Playwright page. Null if no park. */
export async function submitParkedBrowserOtp(input: {
    familyId: string;
    userId: string;
    otp: string;
}): Promise<BrowserTaskResult | null> {
    const parked = takeParkedBrowserOtpSession(input.familyId, input.userId);
    if (!parked || parked.aborted) {
        if (parked) await closeTakenPark(parked);
        return null;
    }
    if (
        parked.generation != null &&
        !isBrowserGenerationCurrent(input.familyId, input.userId, parked.generation)
    ) {
        await closeTakenPark(parked);
        return null;
    }
    try {
        const filled = await fillOtpOnPage(parked.page, input.otp.trim());
        if (!filled.filled) {
            parkBrowserForOtp({
                familyId: parked.familyId,
                userId: parked.userId,
                partner: parked.partner,
                goal: parked.goal,
                generation: parked.generation,
                browser: parked.browser,
                context: parked.context,
                page: parked.page,
                taskInput: parked.input,
            });
            return {
                status: "need_otp",
                mode: "playwright",
                partner: parked.partner,
                steps: 1,
                message:
                    `Couldn't find the OTP box on the open *${partnerLabel(parked.partner)}* page. ` +
                    `Paste the code again, or reply *retry* / *cancel*.`,
            };
        }
        try {
            const state = await parked.context.storageState();
            await saveBrowserProfileState({
                familyId: input.familyId,
                userId: input.userId,
                storageStateJson: JSON.stringify(state),
                lastPartner: parked.partner,
                lastUrl: parked.page.url(),
            });
        } catch {
            /* ignore */
        }
        const items = extractItemGuess(parked.goal);
        return {
            status: "need_user_confirm",
            mode: "playwright",
            partner: parked.partner,
            steps: 1,
            url: parked.page.url(),
            message: [
                `Got the code — signed in to *${partnerLabel(parked.partner)}*.`,
                `Next I'll find: ${items[0] || parked.goal.slice(0, 80)}`,
                ``,
                `Reply *confirm* when I show item+total+address (no silent pay), or *cancel*.`,
            ].join("\n"),
            confirm: {
                items,
                totalLabel: "TBD",
                addressLabel: "saved address",
            },
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            status: "error",
            mode: "playwright",
            partner: parked.partner,
            steps: 0,
            failureReason: /closed|Target/i.test(msg) ? "chromium_crash" : "unknown",
            message: `OTP submit failed: ${msg.slice(0, 160)}. Reply *retry* or *cancel*.`,
        };
    } finally {
        if (!hasParkedBrowserOtpSession(input.familyId, input.userId)) {
            await closeTakenPark(parked);
        }
    }
}

export { DryRunBrowserWorker, PlaywrightBrowserWorker, TINY_PNG_B64 };
