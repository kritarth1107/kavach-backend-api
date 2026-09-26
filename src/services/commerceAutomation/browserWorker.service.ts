/**
 * Browser worker interface + Playwright (prod Cloud Run + local) + DryRun fallback.
 *
 * Env:
 *   BROWSER_WORKER_MODE=playwright|dry_run|auto  (default auto)
 *   auto → playwright if Chromium launchable, else dry_run
 * Cloud Run image installs Chromium (bookworm + playwright --with-deps); prefer auto|playwright in prod.
 */
import { runGenericCodCheckout, verifyGenericCart } from "./agentLayer/stepEngine";
import { debugPortArgs, pickDebugPort, registerBrowserDebugPort } from "./agentLayer/cdpRegistry";
import { guardComputerUseClick } from "./agentLayer/guardrails";
import type { BrowserAction } from "./geminiComputerUse.service";
import { planBrowserActions } from "./geminiComputerUse.service";
import { StallDetector, actionSignature, browserRunawayMs, hashOf } from "./agentLayer/stallDetector";
import { dishFromGoal, isSwiggyRestaurantUrl, swiggyNeedsLogin, swiggyScriptedAddToCart, swiggyScriptedLogin } from "./swiggyRestaurantAdd";
import {
    getOrCreateBrowserProfile,
    saveBrowserProfileState,
} from "./browserProfile.service";
import { resolvePlaybook, partnerLabel } from "./playbooks";
import { isAllowedOrderSite, refuseSiteCopy } from "./siteAllowlist";
import { addressMatches } from "./kavachAddress";
import { splitAddress, storeAddressMatchesPlace } from "../familyAddressBook.service";
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
    claimPharmacyOtpSend,
    hasPharmacyOtpSendBeenClaimed,
    releasePharmacyOtpSendClaim,
    clearActiveBrowserTask,
    currentBrowserGeneration,
    parkBrowserForCheckout,
    takeParkedCheckout,
    peekParkedCheckout,
    closeCheckoutSession,
    checkoutParkTtlMs,
    type ParkedCheckoutSession,
} from "./parkedOtpSession.service";
import {
    addressHintsFrom,
    CART_REMOVE_BLOCK_RE,
    describeClickTarget,
    rupeesFromLabel,
    runApolloCodCheckout,
    type ApolloCheckoutOutcome,
} from "./apolloCheckout";
import {
    addExactSkuToApolloCart,
    cartLineMatchesSku,
    checkCartExactlySku,
    describeCartLines,
    emptyApolloCart,
    extractPincode,
    formatApolloConfirmCard,
    isOtpScreenVisible,
    parseExactSkuFromGoal,
    readApolloCart,
    readCartLines,
    waitForCartSnapshot,
    APOLLO_CART_URL,
    waitForOtpAccepted,
} from "./apolloPostOtp";
import { addressTargetFrom } from "./apolloAddress";
import { captureCheckoutDiagnostic } from "./checkoutDiagnostics.service";

/** Kavach user's display name (care recipient on a new Apollo address). Never invented. */
async function lookupKavachUserName(userId?: string): Promise<string | undefined> {
    if (!userId) return undefined;
    try {
        const User = (await import("../../models/users.model")).default;
        const u = (await User.findOne({ userId }).lean()) as { firstName?: string; lastName?: string; displayName?: string } | null;
        const name = [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || u?.displayName?.trim();
        return name && /[a-z]/i.test(name) ? name.slice(0, 40) : undefined;
    } catch {
        return undefined;
    }
}

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
    /** Signed in fine, but the exact SKU is out of stock / unavailable at the pincode. */
    | "out_of_stock"
    /** Apollo rejected the pasted code or kept showing the code screen. */
    | "otp_rejected"
    /** Signed in, but cart / confirm didn't finish inside the WA deadline. */
    | "post_otp_timeout"
    /** Apollo cart already had other items and they could not be removed + verified. */
    | "cart_not_empty"
    /** Cart doesn't hold exactly the confirmed product at qty 1 (confirm card withheld). */
    | "cart_mismatch"
    /** Site outside the hard allowlist (siteAllowlist.ts). */
    | "not_allowed"
    /** Hit the runaway safety ceiling (default 200 steps / 20 min) — should almost never happen. */
    | "step_limit"
    /** Truly stuck: same action on an unchanged page ~6× in a row, or no page change for minutes. */
    | "stalled"
    /** Site showed a block / "access denied" page mid-flow. */
    | "site_blocked"
    /** Scripted login tapped Login but the site refused / showed no code screen (message says why). */
    | "login_failed"
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
        /** Id of the parked signed-in checkout page this card belongs to. */
        cardId?: string;
    };
    partner?: string;
    /** Typed soft-failure for WA copy (CAPTCHA vs timeout vs no login UI). */
    failureReason?: BrowserFailureReason;
    /** Optional local screenshot path when a step failed (Cloud Run /tmp). */
    screenshotPath?: string;
    /** Last page-loop actions (type + URL path only; no typed text) for failure logs. */
    lastSteps?: string[];
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
    | "busy"
    /** One-shot "still working on it" (the only step line that reaches WhatsApp besides the OTP ask). */
    | "still_working";

export type RunBrowserTaskInput = {
    familyId: string;
    userId: string;
    goal: string;
    partner?: CommercePartnerKey | "generic";
    /** Override playbook start URL (product link or resolved domain). */
    startUrl?: string;
    /** Exact SKU product page (guest search) — used after login to add that SKU deterministically. */
    productUrl?: string;
    /** Full delivery address (pincode drives per-pincode stock + address pick). */
    deliveryAddress?: string;
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
    /** Mutable — last WA progress stage (avoids stale "didn't reach login" after sign-in). */
    lastProgressStage?: BrowserProgressStage;
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
    input.lastProgressStage = stage;
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
    // No fixed short deadline any more: runs stop on stall detection (agentLayer/stallDetector).
    // The only wall clock is the generous runaway ceiling (BROWSER_RUNAWAY_MS, default 20 min);
    // legacy BROWSER_TASK_DEADLINE_MS / caller deadlineMs can only raise it, never shorten it.
    void input?.partner;
    const runaway = browserRunawayMs();
    const asked = Number(input?.deadlineMs);
    return Number.isFinite(asked) && asked > runaway ? Math.min(asked, 3_600_000) : runaway;
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
        .replace(/\|\s*login_phone=\S*/gi, " ")
        .replace(/\blogin_phone=\S*/gi, " ").replace(/\|\s*login_phone=(?=\s|$)/gi, " ")
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/\b(order|buy|get|purchase|from|on|via|please|for me|exact sku)\b/gi, " ")
        .replace(
            /\b(amazon|flipkart|myntra|bigbasket|big basket|jiomart|dmart|blinkit|apollo|instamart|swiggy|zepto|pharmeasy|1mg)\b/gi,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
    return cleaned ? [cleaned.slice(0, 80)] : ["your item"];
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
        const taskStartedAt = Date.now();
        // No fixed step cap: stop only when stuck (StallDetector) or at the runaway ceiling.
        const stall = new StallDetector();
        const maxSteps = stall.cfg.runawaySteps;
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
        const debugPort = pickDebugPort();
        // Sites that block our datacenter IP render on the remote India-proxy Chrome (BROWSER_REMOTE=browseruse),
        // with this family's own profile for this store; everything else is the local headless Chromium.
        const { launchBrowserFor, remoteInfo, useRemoteBrowserFor } = await import("./remoteBrowser");
        const remoteWanted = useRemoteBrowserFor(String(playbook.partner));
        const browser = await raceWithDeadline(
            launchBrowserFor(pw, {
                partner: String(playbook.partner),
                familyId: input.familyId,
                launch: {
                    headless: true,
                    // Local-only CDP port so the Stagehand fallback can attach to this same browser.
                    args: [
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                        // Swiggy renders a blank menu for navigator.webdriver browsers (same flags as swiggyGuest).
                        "--disable-blink-features=AutomationControlled",
                        ...debugPortArgs(debugPort),
                    ],
                },
            }),
            remoteWanted ? launchMs + 60_000 : launchMs,
            "Playwright chromium.launch",
        );
        const remote = remoteInfo(browser).remote;
        if (!remote) registerBrowserDebugPort(browser, debugPort);

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
            if (remote && !ride && browser.contexts()[0]) {
                // Remote: the default context carries this family's Browser Use profile for this store
                // (login survives between orders); our own encrypted cookies are layered on top.
                context = browser.contexts()[0]!;
                const saved = (storageState as { cookies?: Parameters<import("playwright").BrowserContext["addCookies"]>[0] } | undefined)?.cookies;
                if (saved?.length) await context.addCookies(saved).catch(() => undefined);
            } else context = await browser.newContext({
                storageState: storageState as import("playwright").BrowserContextOptions["storageState"],
                viewport: ride
                    ? { width: 390, height: 844 }
                    : { width: 1280, height: 720 },
                userAgent: ride ? mobileUa : desktopUa,
                isMobile: ride,
                hasTouch: ride,
            });
            await context
                .addInitScript(() => {
                    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
                })
                .catch(() => undefined);
            const page = (remote && !ride && context.pages()[0]) || (await context.newPage());
            if (remote && !ride) await page.setViewportSize({ width: 1280, height: 720 }).catch(() => undefined);
            await page.goto(playbook.startUrl, { waitUntil: "domcontentloaded", timeout: remote ? 60000 : 45000 });

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
                    claimOtpSend: () =>
                        claimPharmacyOtpSend(
                            input.familyId,
                            input.userId,
                            input.browserGeneration ??
                                currentBrowserGeneration(input.familyId, input.userId),
                        ),
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
                    // Continue may have been claimed but SMS never confirmed — don't accept WA digits as OTP
                    releasePharmacyOtpSendClaim(
                        input.familyId,
                        input.userId,
                        input.browserGeneration ??
                            currentBrowserGeneration(input.familyId, input.userId),
                    );
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
                // already_logged_in → deterministic exact-SKU add (Apollo), else Gemini search/cart loop
                await notifyProgress(
                    input,
                    "searching",
                    String(playbook.partner) === "apollo"
                        ? `*Apollo* signed in ✓ — checking your cart first (I'll remove anything else in it), then adding your item…`
                        : `*${partnerLabel(String(playbook.partner))}* signed in ✓ — adding your item to cart…`,
                );
                if (String(playbook.partner) === "apollo") {
                    const det = await apolloExactSkuToConfirm({
                        page,
                        goal: input.goal,
                        startUrl: input.startUrl,
                        productUrl: input.productUrl,
                        deliveryAddress: input.deliveryAddress,
                        deadlineAt: taskStartedAt + browserTaskDeadlineMs(input) - 6_000,
                        isCancelled: () => isTaskCancelled(input),
                        progress: async (d) => notifyProgress(input, "searching", d),
                    });
                    if (det) {
                        await this.persist(context, input, playbook.partner, page.url());
                        if (det.status === "need_user_confirm" && context && !isTaskCancelled(input)) {
                            parkSignedInCheckout({
                                result: det,
                                browser,
                                context,
                                page,
                                taskInput: input,
                                partner: String(playbook.partner),
                                goal: input.goal,
                                generation:
                                    input.browserGeneration ??
                                    currentBrowserGeneration(input.familyId, input.userId),
                            });
                            retainBrowser = true;
                            context = null;
                        }
                        return det;
                    }
                }
            } else if (pharmacyPartner && !input.otp && !input.userConfirmed && !input.loginPhone) {
                console.warn(
                    "pharmacy browser task missing loginPhone — Gemini must find Login unaided",
                );
            }

            // Fixed scripted Swiggy restaurant step: search the confirmed dish on the restaurant
            // page → ADD → default customisation → cart. Gemini only takes over if this fails.
            let scriptedHint = "";
            if (
                String(playbook.partner) === "swiggy" &&
                !input.otp &&
                !input.userConfirmed &&
                isSwiggyRestaurantUrl(page.url()) &&
                dishFromGoal(input.goal)
            ) {
                const dish = dishFromGoal(input.goal)!;
                await notifyProgress(input, "searching", `adding *${dish.slice(0, 60)}* to the Swiggy cart…`);
                const added = await swiggyScriptedAddToCart(page, {
                    dish,
                    isCancelled: () => isTaskCancelled(input),
                    log: (event, extra) => console.log(`[swiggy-scripted] ${event} ${extra ? JSON.stringify(extra) : ""}`.trim()),
                }).catch((err): { ok: false; reason: string; steps: string[] } => ({
                    ok: false,
                    reason: `error:${err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80)}`,
                    steps: [],
                }));
                if (isTaskCancelled(input)) {
                    return { status: "cancelled", message: "Cancelled.", steps: 0, mode: "playwright", partner: String(playbook.partner) };
                }
                if (added.ok) {
                    stall.markProgress();
                    scriptedHint = ` The dish "${dish}" is ALREADY in the Swiggy cart (quantity 1) and the cart/checkout page is open — do NOT add it again. Next: log in if asked, pick the delivery address, then emit need_user_confirm with the real item, total and address.`;
                    await notifyProgress(input, "searching", `*${dish.slice(0, 60)}* is in the cart ✓ — opening checkout…`);
                    // Fixed login on Swiggy checkout: LOG IN → phone → Login (Swiggy texts the OTP once).
                    if (input.loginPhone && (await swiggyNeedsLogin(page))) {
                        const gen = input.browserGeneration ?? currentBrowserGeneration(input.familyId, input.userId);
                        const login = await swiggyScriptedLogin(page, {
                            loginPhone: input.loginPhone,
                            claimOtpSend: () => claimPharmacyOtpSend(input.familyId, input.userId, gen),
                            isCancelled: () => isTaskCancelled(input),
                            log: (event, extra) => console.log(`[swiggy-scripted] ${event} ${extra ? JSON.stringify(extra) : ""}`.trim()),
                        }).catch((err): { status: "failed"; reason: string; steps: string[] } => ({
                            status: "failed",
                            reason: `error:${err instanceof Error ? err.message.slice(0, 60) : "x"}`,
                            steps: [],
                        }));
                        if (isTaskCancelled(input)) {
                            return { status: "cancelled", message: "Cancelled.", steps: 0, mode: "playwright", partner: String(playbook.partner) };
                        }
                        if (login.status === "otp_sent" && context) {
                            await this.persist(context, input, playbook.partner, page.url());
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
                            return {
                                status: "need_otp",
                                message: `🔐 *Swiggy* has sent a login code to your phone — please *paste the SMS OTP here*. Your ${dish.slice(0, 60)} is already in the cart.`,
                                steps: 2,
                                url: page.url(),
                                mode: "playwright",
                                partner: String(playbook.partner),
                            };
                        }
                        if (login.status === "failed") {
                            console.warn(`[swiggy-scripted] login: ${login.reason}`);
                            const sent = /otp_screen_not_shown|rate_limited|phone_rejected|no_swiggy_account/.test(login.reason);
                            if (sent) {
                                // Login was tapped but no OTP box: never let later digits count as an OTP.
                                releasePharmacyOtpSendClaim(input.familyId, input.userId, gen);
                                await captureCheckoutDiagnostic(page, {
                                    familyId: input.familyId,
                                    userId: input.userId,
                                    flow: "pre_checkout",
                                    stage: "swiggy_login",
                                    reason: login.reason,
                                }).catch(() => null);
                                await this.persist(context, input, playbook.partner, page.url());
                                return {
                                    status: "error",
                                    message:
                                        login.reason === "no_swiggy_account"
                                            ? "Swiggy says this phone number has no Swiggy account yet, so I can't log in. Nothing was ordered."
                                            : login.reason === "rate_limited"
                                              ? "Swiggy says too many login attempts — please try again in a while. Nothing was ordered."
                                              : "I tapped Login on Swiggy but it didn't show the code screen. Nothing was ordered.",
                                    steps: 2,
                                    url: page.url(),
                                    mode: "playwright",
                                    partner: String(playbook.partner),
                                    failureReason: "login_failed",
                                };
                            }
                            // Never got to the phone field → Gemini fallback below.
                        }
                    }
                } else {
                    console.warn(`[swiggy-scripted] fallback to Gemini: ${added.reason}`);
                }
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
            const lastSteps: string[] = [];
            let stopVerdict: { reason: string; detail: string } | null = null;
            const urlPath = (u: string) => {
                try {
                    return new URL(u).pathname.slice(0, 80);
                } catch {
                    return "";
                }
            };

            for (;;) {
                if (isTaskCancelled(input)) {
                    return { status: "cancelled", message: "Cancelled.", steps, mode: "playwright", partner: String(playbook.partner) };
                }
                const timeVerdict = stall.checkTime();
                if (timeVerdict.stop) {
                    stopVerdict = timeVerdict;
                    break;
                }
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
                        await captureCheckoutDiagnostic(page, {
                            familyId: input.familyId,
                            userId: input.userId,
                            flow: "pre_checkout",
                            stage: `page_loop:${urlPath(page.url())}`,
                            reason: "site_blocked",
                        }).catch(() => null);
                        await this.persist(context, input, playbook.partner, page.url());
                        return {
                            status: "error",
                            message: midBlock,
                            steps,
                            url: page.url(),
                            modelUsed,
                            mode: "playwright",
                            partner: String(playbook.partner),
                            failureReason: "site_blocked",
                            lastSteps,
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
                    }${scriptedHint}`,
                    step: steps,
                    maxSteps,
                    otpProvided: Boolean(input.otp),
                    userConfirmed,
                });
                modelUsed = planned.modelUsed;
                if (isTaskCancelled(input)) {
                    return { status: "cancelled", message: "Cancelled.", steps, mode: "playwright", partner: String(playbook.partner) };
                }
                {
                    const verdict = stall.observe({
                        url,
                        // Digits collapsed so countdowns / timers don't look like page changes.
                        domHash: hashOf(`${title}|${accessibilityHint.replace(/\d+/g, "#")}`),
                        shotHash: hashOf(screenshot),
                        actionSig: actionSignature(planned.actions as unknown[]),
                    });
                    if (verdict.stop) {
                        stopVerdict = verdict;
                        lastSteps.push(`${steps}:${urlPath(url)}:stop:${verdict.reason}`);
                        break;
                    }
                }
                lastSteps.push(
                    `${steps}:${urlPath(url)}:${planned.actions.map((a) => String((a as { type?: string }).type || "?")).join("+") || "none"}`,
                );
                if (lastSteps.length > 8) lastSteps.shift();

                for (const action of planned.actions) {
                    const gated = await this.applyAction(page, action, {
                        userConfirmed,
                        goal: input.goal,
                        blockPharmacyOtpSend:
                            Boolean(pharmacyPartner) ||
                            hasPharmacyOtpSendBeenClaimed(
                                input.familyId,
                                input.userId,
                                input.browserGeneration ??
                                    currentBrowserGeneration(input.familyId, input.userId),
                            ),
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
                        const out: BrowserTaskResult = {
                            status: gated.status!,
                            message: msg,
                            steps,
                            url: page.url(),
                            modelUsed,
                            mode: "playwright",
                            confirm: gated.confirm,
                            partner: String(playbook.partner),
                        };
                        if (
                            gated.status === "need_user_confirm" &&
                            context &&
                            !isTaskCancelled(input) &&
                            isGenericCheckoutPartner(String(playbook.partner), input.goal)
                        ) {
                            const replaced = await parkGenericConfirm({
                                result: out,
                                browser,
                                context,
                                page,
                                taskInput: input,
                                partner: String(playbook.partner),
                                goal: input.goal,
                                generation: input.browserGeneration ?? currentBrowserGeneration(input.familyId, input.userId),
                            });
                            if (replaced) return replaced;
                            retainBrowser = true;
                            context = null;
                        }
                        return out;
                    }
                    if (action.type === "need_user_confirm") {
                        // Should have halted above
                    }
                }
            }

            // Stopped because truly stuck (or the runaway ceiling): masked screenshot + page text for the peek.
            const runaway = stopVerdict?.reason === "runaway_steps" || stopVerdict?.reason === "runaway_time";
            const why = runaway ? "step_limit" : "stalled";
            console.log(
                JSON.stringify({
                    severity: "WARNING",
                    event: "browser_task_stopped",
                    message: `browser_task_stopped ${String(playbook.partner)} ${stopVerdict?.reason || "unknown"}`,
                    store: String(playbook.partner),
                    rule: stopVerdict?.reason || "unknown",
                    detail: stopVerdict?.detail || "",
                    steps,
                    elapsedMs: Date.now() - taskStartedAt,
                }),
            );
            await captureCheckoutDiagnostic(page, {
                familyId: input.familyId,
                userId: input.userId,
                flow: "pre_checkout",
                stage: `page_loop:${urlPath(page.url())}`,
                reason: why,
            }).catch(() => null);
            await this.persist(context, input, playbook.partner, page.url());
            return {
                status: "error",
                message: runaway
                    ? "This is taking far longer than it should, so I stopped to be safe — reply *retry* or *cancel*."
                    : `I got stuck on the page (${stopVerdict?.detail || "nothing changed"}) — reply *retry* or *cancel*.`,
                steps,
                url: page.url(),
                modelUsed,
                mode: "playwright",
                partner: String(playbook.partner),
                failureReason: why,
                lastSteps,
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

    /**
     * After OTP is filled on a parked page: run Gemini search/cart until confirm/done.
     * Keeps the same Chromium session (no re-login / no second SMS).
     */
    async continueParkedAfterOtp(args: {
        browser: import("playwright").Browser;
        context: import("playwright").BrowserContext;
        page: import("playwright").Page;
        input: RunBrowserTaskInput;
        partner: string;
        generation: number;
        goal: string;
        /** Absolute epoch ms — loop stops ~8s before and returns an honest error. */
        deadlineAt?: number;
        /** Extra instruction for Gemini (e.g. "cart already has the SKU; select address"). */
        extraHint?: string;
    }): Promise<{ result: BrowserTaskResult; retainBrowser: boolean }> {
        const { page, context, browser, input } = args;
        const stall = new StallDetector();
        const deadlineAt = args.deadlineAt ?? stall.runawayDeadlineAt;
        const playbook = resolvePlaybook(
            input.partner || (args.partner as CommercePartnerKey),
            args.goal,
            input.startUrl,
        );
        const maxSteps = stall.cfg.runawaySteps;
        let steps = 0;
        let stopVerdict: { reason: string; detail: string } | null = null;
        let modelUsed: string | undefined;
        let userConfirmed = Boolean(input.userConfirmed);
        let retainBrowser = false;

        await page.waitForTimeout(800).catch(() => undefined);

        // Swiggy: still on the restaurant page after login → scripted dish add first.
        let scriptedHint = "";
        const dish = dishFromGoal(args.goal);
        if (String(playbook.partner) === "swiggy" && dish && isSwiggyRestaurantUrl(page.url())) {
            const added = await swiggyScriptedAddToCart(page, {
                dish,
                isCancelled: () =>
                    args.generation != null && !isBrowserGenerationCurrent(input.familyId, input.userId, args.generation),
                log: (event, extra) => console.log(`[swiggy-scripted] ${event} ${extra ? JSON.stringify(extra) : ""}`.trim()),
            }).catch(() => ({ ok: false as const, reason: "error", steps: [] as string[] }));
            if (added.ok) {
                stall.markProgress();
                scriptedHint = ` The dish "${dish}" is ALREADY in the cart (qty 1) and checkout is open — do NOT add it again.`;
            } else {
                console.warn(`[swiggy-scripted] post-OTP fallback to Gemini: ${added.reason}`);
            }
        }

        if (!scriptedHint && String(playbook.partner) === "swiggy" && dish && /swiggy\.com\/checkout/i.test(page.url())) {
            scriptedHint = ` Signed in on Swiggy checkout; "${dish}" is ALREADY in the cart (qty 1) — do NOT add or remove items. Pick the delivery address that matches the recipient's address/pincode, then emit need_user_confirm with the real item, total and address.`;
        }

        for (;;) {
            if (
                args.generation != null &&
                !isBrowserGenerationCurrent(input.familyId, input.userId, args.generation)
            ) {
                return {
                    retainBrowser: false,
                    result: {
                        status: "cancelled",
                        mode: "playwright",
                        partner: args.partner,
                        steps,
                        message: "Cancelled.",
                    },
                };
            }
            if (Date.now() > deadlineAt - 8_000) {
                stopVerdict = { reason: "runaway_time", detail: "safety ceiling reached" };
                break;
            }
            {
                const tv = stall.checkTime();
                if (tv.stop) {
                    stopVerdict = tv;
                    break;
                }
            }
            steps += 1;
            const screenshot = await page.screenshot({ type: "png", fullPage: false, timeout: 10_000 });
            const url = page.url();
            const title = await page.title().catch(() => "");
            let accessibilityHint = "";
            try {
                accessibilityHint = await page.evaluate(() => {
                    const texts = Array.from(
                        document.querySelectorAll("h1,h2,button,a,[role=button]"),
                    )
                        .slice(0, 40)
                        .map((n) => (n.textContent || "").trim().slice(0, 60))
                        .filter(Boolean);
                    return texts.join(" | ").slice(0, 800);
                });
            } catch {
                /* ignore */
            }

            const midBlock = await detectCommerceSiteBlock(
                page,
                String(playbook.partner),
                input.goal,
            ).catch(() => null);
            if (midBlock) {
                await this.persist(context, input, playbook.partner, page.url());
                return {
                    retainBrowser: false,
                    result: {
                        status: "error",
                        message: midBlock,
                        steps,
                        url: page.url(),
                        modelUsed,
                        mode: "playwright",
                        partner: String(playbook.partner),
                        failureReason: "captcha",
                    },
                };
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
                }. Already signed in — search SKU, add to cart, stop at confirm-before-pay. NEVER click Send OTP/Resend.${
                    args.extraHint ? ` ${args.extraHint}` : ""
                }${scriptedHint}`,
                step: steps,
                maxSteps,
                otpProvided: true,
                userConfirmed,
            });
            modelUsed = planned.modelUsed;
            if (args.generation != null && !isBrowserGenerationCurrent(input.familyId, input.userId, args.generation)) {
                return {
                    retainBrowser: false,
                    result: { status: "cancelled", mode: "playwright", partner: args.partner, steps, message: "Cancelled." },
                };
            }
            {
                const verdict = stall.observe({
                    url,
                    domHash: hashOf(`${title}|${accessibilityHint.replace(/\d+/g, "#")}`),
                    shotHash: hashOf(screenshot),
                    actionSig: actionSignature(planned.actions as unknown[]),
                });
                if (verdict.stop) {
                    stopVerdict = verdict;
                    break;
                }
            }

            // Signed in: only guard Continue/Send-OTP clicks while an OTP box is actually on screen
            // (post-login "Continue"/"Proceed" buttons on cart/checkout are legitimate).
            const otpVisibleNow = await isOtpScreenVisible(page).catch(() => false);
            for (const action of planned.actions) {
                const gated = await this.applyAction(page, action, {
                    userConfirmed,
                    goal: input.goal,
                    blockPharmacyOtpSend: otpVisibleNow,
                });
                if (gated.halt && gated.status === "need_otp" && !otpVisibleNow) {
                    // Gemini hiccup / HTTP fallback says "paste OTP" but we're past login —
                    // never re-ask for a code (and never go silent); keep going until deadline.
                    console.warn("[pharmacy-login] post-OTP: ignoring bogus need_otp (no OTP field visible)");
                    continue;
                }
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
                    if (gated.status === "need_otp") {
                        parkBrowserForOtp({
                            familyId: input.familyId,
                            userId: input.userId,
                            partner: String(playbook.partner),
                            goal: input.goal,
                            generation: args.generation,
                            browser,
                            context,
                            page,
                            taskInput: input,
                        });
                        retainBrowser = true;
                    }
                    return {
                        retainBrowser,
                        result: {
                            status: gated.status!,
                            message: msg,
                            steps,
                            url: page.url(),
                            modelUsed,
                            mode: "playwright",
                            confirm: gated.confirm,
                            partner: String(playbook.partner),
                        },
                    };
                }
            }
        }

        console.log(
            JSON.stringify({
                severity: "WARNING",
                event: "browser_task_stopped",
                message: `browser_task_stopped ${args.partner} post_otp ${stopVerdict?.reason || "unknown"}`,
                store: args.partner,
                phase: "post_otp",
                rule: stopVerdict?.reason || "unknown",
                detail: stopVerdict?.detail || "",
                steps,
            }),
        );
        await this.persist(context, input, playbook.partner, page.url());
        return {
            retainBrowser: false,
            result: {
                status: "error",
                message:
                    `Signed in to *${partnerLabel(args.partner)}* ✓ but got stuck on the cart/confirm step (${stopVerdict?.detail || "no progress"}). ` +
                    `Reply *retry* (no new code needed if Apollo keeps you signed in) or *cancel* — nothing was ordered.`,
                steps,
                url: page.url(),
                modelUsed,
                mode: "playwright",
                partner: args.partner,
                failureReason: "post_otp_timeout",
            },
        };
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
        ctx: { userConfirmed: boolean; goal: string; blockPharmacyOtpSend?: boolean },
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
                      `Deliver to: ${
                          action.confirm?.addressLabel ||
                          (ctx.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim() ||
                              "your saved address")
                      }`,
                      `Payment: prefer *COD* (no silent pay / UPI until you confirm).`,
                      ``,
                      `Reply *confirm* to place with COD if offered, or *cancel*.`,
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

        // Pharmacy: never let Gemini re-click Continue / Send OTP / Resend (SMS spam)
        if (
            ctx.blockPharmacyOtpSend &&
            (action.type === "click" || action.type === "press")
        ) {
            const t = `${action.text || ""} ${action.selector || ""} ${action.message || ""}`.toLowerCase();
            if (
                /\b(send\s*otp|get\s*otp|request\s*otp|resend|re-?send|continue|get\s*(a\s*)?new\s*(otp|code))\b/.test(
                    t,
                )
            ) {
                console.warn("blocked Gemini pharmacy OTP-send click:", t.slice(0, 80));
                return {
                    halt: true,
                    status: "need_otp",
                    message:
                        action.message ||
                        "Paste the SMS OTP here (I don't read your phone SMS).",
                };
            }
        }

        // Cart items are only ever removed by deterministic code (pre-add cleanup) — never Gemini.
        if (action.type === "click" && !isRideGoal(ctx.goal)) {
            const target = await describeClickTarget(page, action).catch(() => "remove");
            if (CART_REMOVE_BLOCK_RE.test(target)) {
                console.warn("blocked Gemini cart remove/delete click:", target.replace(/\s+/g, " ").slice(0, 100));
                return { halt: false };
            }
        }

        // Hard guardrail (always, confirmed or not): the model never clicks non-COD payment,
        // memberships/upsells, or Place order. Placement is deterministic code in the step engine.
        if ((action.type === "click" || action.type === "press") && !isRideGoal(ctx.goal)) {
            const target = await describeClickTarget(page, action).catch(() => "");
            const t = `${target} ${action.text || ""} ${action.selector || ""}`;
            const verdict = guardComputerUseClick(t);
            if (!verdict.ok) {
                console.warn(`blocked Gemini ${verdict.reason} click:`, verdict.matched, t.replace(/\s+/g, " ").slice(0, 100));
                if (verdict.reason === "place_order") {
                    return {
                        halt: true,
                        status: ctx.userConfirmed ? "error" : "need_user_confirm",
                        message: ctx.userConfirmed
                            ? "I stopped before placing the order — placing is only done by my checked COD step. Nothing was ordered or paid."
                            : "Ready to place — reply *confirm* with item/total/address check, or *cancel*.",
                    };
                }
                return { halt: false };
            }
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
                        try {
                            await page.locator(action.selector).first().click({ timeout: 5000 });
                        } catch (err) {
                            // Model guessed the tag (e.g. button:has-text("LOG IN") when it's a <div>):
                            // retry the same visible text on any element, then the model's x/y.
                            const txt =
                                action.selector.match(/has-text\(\s*["'](.+?)["']\s*\)/i)?.[1] ||
                                action.selector.match(/^text\s*=\s*["']?(.+?)["']?$/i)?.[1] ||
                                action.text;
                            let clicked = false;
                            if (txt && txt.trim().length >= 2) {
                                const exact = page.getByText(txt.trim(), { exact: true });
                                const loose = page.getByText(txt.trim());
                                for (const loc of [exact, loose]) {
                                    const n = Math.min(await loc.count().catch(() => 0), 6);
                                    for (let i = 0; i < n && !clicked; i++) {
                                        if (await loc.nth(i).isVisible().catch(() => false)) {
                                            clicked = await loc.nth(i).click({ timeout: 4000 }).then(() => true).catch(() => false);
                                        }
                                    }
                                    if (clicked) break;
                                }
                            }
                            if (!clicked && typeof action.x === "number" && typeof action.y === "number") {
                                const vp = page.viewportSize() || { width: 1280, height: 720 };
                                await page.mouse.click(Math.round((action.x / 1000) * vp.width), Math.round((action.y / 1000) * vp.height));
                                clicked = true;
                            }
                            if (!clicked) throw err;
                        }
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
    const stage = input.lastProgressStage || "";
    const postLogin =
        Boolean(input.otp) ||
        stage === "searching" ||
        stage === "otp_ready";
    // Never claim "didn't reach login" after successful sign-in / OTP paste.
    if (postLogin && !ride) {
        return {
            status: "error",
            mode: "playwright",
            partner: String(playbook.partner),
            steps: 1,
            url: playbook.startUrl,
            failureReason: crash ? "chromium_crash" : busy ? "busy" : "site_slow",
            message: [
                `*${label}* signed in but timed out before confirm-before-pay (search/cart slow).`,
                `Nothing was ordered or paid.`,
                ``,
                `Reply *retry* to continue, or *cancel* to stop.`,
            ].join("\n"),
        };
    }
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
                    `Opening *${label}* for: ${input.goal.replace(/\|\s*login_phone=\S*/gi, "").replace(/\|\s*delivery_address=[^|]*/gi, "").slice(0, 120)}`,
                    ``,
                    `This is taking a moment — if you get an SMS OTP, *paste it here*.`,
                    `(I never read your device SMS — only what you send me on WhatsApp.)`,
                    ``,
                    `Or reply *cancel* to stop.`,
                ].join("\n"),
    };
}

/** Public API — per-user profile + run. Always respects a hard WhatsApp-facing deadline. */
export async function runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
    // HARD allowlist — refuse before Chromium ever opens.
    const allowPartner = resolvePlaybook(input.partner, input.goal, input.startUrl).partner;
    if (!isAllowedOrderSite(String(allowPartner))) {
        return {
            status: "error",
            mode: "playwright",
            partner: String(allowPartner || "generic"),
            steps: 0,
            failureReason: "not_allowed",
            message: refuseSiteCopy(String(allowPartner)),
        };
    }
    const result = await runBrowserTaskInner(input);
    logBrowserTaskFailure(input, result);
    return result;
}

/**
 * One structured Cloud Logging line per failed browser task (jsonPayload). Store / stage /
 * reason / URL path / last steps only — no phone, address, goal text, or OTP.
 */
export function logBrowserTaskFailure(
    input: Pick<RunBrowserTaskInput, "partner">,
    result: BrowserTaskResult,
): void {
    if (result.status !== "error") return;
    try {
        let path = "";
        try {
            path = result.url ? new URL(result.url).pathname.slice(0, 120) : "";
        } catch {
            path = "";
        }
        let host = "";
        try {
            host = result.url ? new URL(result.url).host : "";
        } catch {
            host = "";
        }
        console.log(
            JSON.stringify({
                severity: "WARNING",
                message: `browser_task_failed ${String(result.partner || input.partner || "generic")} ${result.failureReason || "unknown"}`,
                event: "browser_task_failed",
                store: String(result.partner || input.partner || "generic"),
                reason: result.failureReason || "unknown",
                stage: path ? `page:${path}` : "before_page",
                host,
                steps: result.steps ?? 0,
                lastSteps: (result.lastSteps || []).slice(-8),
                mode: result.mode,
                hasScreenshot: Boolean(result.screenshotPath),
            }),
        );
    } catch {
        /* never block */
    }
}

async function runBrowserTaskInner(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
    const deadlineMs = browserTaskDeadlineMs(input);
    const { startStillWorkingTimer, STILL_WORKING_TEXT } = await import("./browserProgressNotify.service");
    // Long run → ONE "still working" WhatsApp after ~2 min (notifyProgress drops it after cancel).
    const stopNotice = startStillWorkingTimer(() => notifyProgress(input, "still_working", STILL_WORKING_TEXT));
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
        if (/^runBrowserTask timed out/i.test(msg)) {
            // Only the runaway ceiling (default 20 min) can get here now.
            return {
                status: "error",
                mode: "playwright",
                partner: String(input.partner || "generic"),
                steps: 0,
                failureReason: "step_limit",
                message: "This is taking far longer than it should, so I stopped to be safe — reply *retry* or *cancel*.",
            };
        }
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
    } finally {
        stopNotice();
    }
}



/** Budget for everything after the OTP paste — the runaway ceiling (stall detection stops real stalls). */
/** Runaway ceiling only (default 20 min) — real stops come from stall detection. */
export const POST_OTP_BUDGET_MS = browserRunawayMs();

function logPostOtp(event: string, extra?: Record<string, unknown>): void {
    try {
        console.log(`[pharmacy-login] post-OTP ${event} ${extra ? JSON.stringify(extra) : ""}`.trim());
    } catch {
        /* ignore */
    }
}

/**
 * Apollo exact-SKU: product page → stock check at pincode → Add 1 → cart → confirm card.
 * Returns null when the deterministic path couldn't add (caller falls back to Gemini).
 */
export async function apolloExactSkuToConfirm(args: {
    page: import("playwright").Page;
    goal: string;
    startUrl?: string;
    productUrl?: string;
    deliveryAddress?: string;
    deadlineAt: number;
    isCancelled?: () => boolean;
    progress?: (detail: string) => Promise<void>;
}): Promise<BrowserTaskResult | null> {
    const sku = parseExactSkuFromGoal(args.goal, args.productUrl || args.startUrl);
    if (!sku?.productUrl) {
        logPostOtp("no_exact_sku", { hasProductUrl: Boolean(args.productUrl || args.startUrl), goal: args.goal.slice(0, 80) });
        return null;
    }
    const addressLabel =
        args.deliveryAddress?.trim() || args.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim();
    const pincode = extractPincode(addressLabel);
    const label = partnerLabel("apollo");
    const shortName = sku.name.replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 60);

    // 1) Empty the user's existing Apollo cart FIRST (deterministic code only — never Gemini),
    //    so nothing that was already in the cart can ride along with this order.
    const cleanup = await emptyApolloCart(args.page, { deadlineAt: args.deadlineAt, log: logPostOtp });
    logPostOtp("cart_cleanup", {
        status: cleanup.status,
        removed: cleanup.removed,
        ms: cleanup.ms,
        detail: cleanup.status === "failed" ? cleanup.detail : undefined,
    });
    if (args.isCancelled?.()) {
        return { status: "cancelled", mode: "playwright", partner: "apollo", steps: 1, message: "Cancelled." };
    }
    if (cleanup.status === "failed") {
        const left = cleanup.remaining.length ? ` Still in the cart: ${describeCartLines(cleanup.remaining)}.` : "";
        return {
            status: "error",
            mode: "playwright",
            partner: "apollo",
            steps: 1,
            url: args.page.url(),
            failureReason: "cart_not_empty",
            message:
                `Signed in to *${label}* ✓ — but your Apollo cart already had other item(s) and I couldn't clear it safely ` +
                `(${cleanup.detail}${cleanup.removed ? `; removed ${cleanup.removed}` : ""}).${left}\n` +
                `I stopped before adding *${shortName}* — nothing was ordered or paid, and I won't send a confirm card for a mixed cart.`,
        };
    }
    // An older line of this same product was cleared too (re-added fresh at qty 1) — not "other".
    const sameWasThere = cleanup.status === "emptied" && cleanup.removedNames.some((n) => cartLineMatchesSku(n, sku.name));
    const othersRemoved = cleanup.status === "emptied" ? Math.max(0, cleanup.removed - (sameWasThere ? 1 : 0)) : 0;
    if (cleanup.status === "emptied") {
        await args.progress?.(
            (othersRemoved
                ? `your Apollo cart had ${othersRemoved} other item${othersRemoved === 1 ? "" : "s"} — removed ✓`
                : `cleared the old cart line`) +
                `${sameWasThere ? ` (plus an earlier ${shortName} line, re-adding it at qty 1)` : ""} — cart is empty now. Adding ${shortName}…`,
        );
    }

    // 2) Add exactly 1 of the confirmed product.
    const added = await addExactSkuToApolloCart(args.page, sku, { deadlineAt: args.deadlineAt, pincode });
    logPostOtp("add_to_cart", { status: added.status, detail: added.detail });
    if (args.isCancelled?.()) {
        return { status: "cancelled", mode: "playwright", partner: "apollo", steps: 2, message: "Cancelled." };
    }
    if (added.status === "out_of_stock") {
        return {
            status: "error",
            mode: "playwright",
            partner: "apollo",
            steps: 2,
            url: args.page.url(),
            failureReason: "out_of_stock",
            message:
                `Signed in to *${label}* ✓ — but *${sku.name}* is ${added.detail}` +
                `${pincode && !/pincode/.test(added.detail) ? ` (delivery ${pincode})` : ""}. Nothing was added or ordered.`,
        };
    }
    if (added.status !== "added") return null;
    await args.progress?.(`added ✓ — checking the cart total & delivery address…`);
    const cart = await readApolloCart(args.page, sku, { deadlineAt: args.deadlineAt, pincode, addressLabel });
    logPostOtp("cart", {
        itemSeen: cart?.itemSeen,
        total: cart?.totalLabel,
        addrPin: cart?.addressMatchesPincode,
        addrEvidence: cart?.addressEvidence,
        cod: cart?.codMentioned,
    });
    // 3) Hard guard: the cart must hold EXACTLY one line — this product at qty 1.
    const exact = checkCartExactlySku(cart?.cartLines ?? (await readCartLines(args.page)), sku.name);
    logPostOtp("cart_exact_guard", exact.ok ? { ok: true, line: exact.line.name.slice(0, 60) } : { ok: false, reason: exact.reason });
    if (!exact.ok) {
        return {
            status: "error",
            mode: "playwright",
            partner: "apollo",
            steps: 3,
            url: args.page.url(),
            failureReason: "cart_mismatch",
            message:
                `I added *${shortName}* on *${label}*, but the cart doesn't hold exactly 1 × that item (${exact.reason}` +
                `${exact.lines.length ? `: ${describeCartLines(exact.lines)}` : ""}).\n` +
                `So I did *not* send a confirm card — nothing was ordered or paid.`,
        };
    }
    const card = formatApolloConfirmCard({
        sku,
        cart,
        addressLabel,
        removedCount: othersRemoved,
        cartVerifiedExact: true,
    });
    return {
        status: "need_user_confirm",
        mode: "playwright",
        partner: "apollo",
        steps: 3,
        url: args.page.url(),
        message: card.message,
        confirm: { items: card.items, totalLabel: card.totalLabel, addressLabel: card.addressLabel },
    };
}

/**
 * Before any Apollo confirm card that did NOT come from the deterministic path: open the
 * cart and require exactly one line (the confirmed product when known) at qty 1.
 * Anything else → no card, honest error (nothing placed).
 */
export async function guardApolloConfirmCart(
    page: import("playwright").Page,
    result: BrowserTaskResult,
    skuName: string | undefined,
    deadlineAt: number,
): Promise<BrowserTaskResult> {
    await page
        .goto(APOLLO_CART_URL, { waitUntil: "domcontentloaded", timeout: Math.max(2_000, Math.min(20_000, deadlineAt - Date.now() - 3_000)) })
        .catch(() => undefined);
    const snap = await waitForCartSnapshot(page, Math.min(deadlineAt - 2_000, Date.now() + 12_000));
    let ok = false;
    let reason = "";
    if (skuName) {
        const chk = checkCartExactlySku(snap, skuName);
        ok = chk.ok;
        if (!chk.ok) reason = `${chk.reason}${chk.lines.length ? `: ${describeCartLines(chk.lines)}` : ""}`;
    } else {
        ok = snap.state === "loaded" && snap.lines.length === 1 && snap.lines[0]!.qty === 1;
        if (!ok) reason = snap.state === "loaded" ? `cart has ${describeCartLines(snap.lines)}` : "couldn't read the Apollo cart";
    }
    logPostOtp("gemini_card_cart_guard", { ok, reason: reason.slice(0, 160) });
    if (ok) return result;
    return {
        status: "error",
        mode: "playwright",
        partner: "apollo",
        steps: result.steps,
        url: page.url(),
        failureReason: "cart_mismatch",
        message:
            `The Apollo cart doesn't hold exactly 1 × the item you asked for (${reason}). ` +
            `I did *not* send a confirm card — nothing was ordered or paid.`,
    };
}

/**
 * Inject WA-pasted OTP into a parked live Playwright page, make sure Apollo accepted it,
 * then (same page) add the exact SKU → read cart → need_user_confirm.
 * ALWAYS resolves within POST_OTP_BUDGET_MS with an honest result (never hangs / never silent).
 */
export async function submitParkedBrowserOtp(input: {
    familyId: string;
    userId: string;
    otp: string;
    /** Progress lines (activity log); stage "still_working" is the one WhatsApp-worthy line. */
    onProgress?: (detail: string, stage?: string) => void | Promise<void>;
    budgetMs?: number;
}): Promise<BrowserTaskResult | null> {
    const parked = takeParkedBrowserOtpSession(input.familyId, input.userId);
    if (!parked || parked.aborted) {
        logPostOtp("no_parked_session", { aborted: parked?.aborted ?? null });
        if (parked) await closeTakenPark(parked);
        return null;
    }
    if (
        parked.generation != null &&
        !isBrowserGenerationCurrent(input.familyId, input.userId, parked.generation)
    ) {
        logPostOtp("stale_generation", { parkedGen: parked.generation });
        await closeTakenPark(parked);
        return null;
    }
    const startedAt = Date.now();
    const budgetMs = input.budgetMs ?? POST_OTP_BUDGET_MS;
    const deadlineAt = startedAt + budgetMs;
    const state = { retain: false, timedOut: false };
    const cancelled = () =>
        parked.generation != null &&
        !isBrowserGenerationCurrent(input.familyId, input.userId, parked.generation);
    const progress = async (detail: string) => {
        if (state.timedOut || cancelled()) return;
        try {
            await input.onProgress?.(detail);
        } catch {
            /* ignore */
        }
    };
    const repark = () => {
        if (state.timedOut) return;
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
        state.retain = true;
    };
    const label = partnerLabel(parked.partner);
    logPostOtp("start", { partner: parked.partner, gen: parked.generation, url: parked.page.url(), budgetMs });

    const work = async (): Promise<BrowserTaskResult> => {
        const filled = await fillOtpOnPage(parked.page, input.otp.trim());
        logPostOtp("filled", { filled: filled.filled, reason: filled.reason });
        if (!filled.filled) {
            repark();
            return {
                status: "need_otp",
                mode: "playwright",
                partner: parked.partner,
                steps: 1,
                message:
                    `Couldn't find the code box on the open *${label}* page — please paste the code again, or reply *retry* / *cancel*.`,
            };
        }

        const acceptance = await waitForOtpAccepted(parked.page, {
            deadlineAt,
            maxWaitMs: 18_000,
            isCancelled: cancelled,
        });
        logPostOtp("acceptance", { status: acceptance.status, clicked: acceptance.clicked, url: parked.page.url() });
        if (cancelled()) {
            return { status: "cancelled", mode: "playwright", partner: parked.partner, steps: 1, message: "Cancelled." };
        }
        if (acceptance.status === "invalid" || acceptance.status === "still_otp") {
            repark();
            return {
                status: "need_otp",
                mode: "playwright",
                partner: parked.partner,
                steps: 1,
                failureReason: "otp_rejected",
                message:
                    acceptance.status === "invalid"
                        ? `*${label}* said that code is wrong or expired — please paste the newest SMS code, or reply *retry* / *cancel*.`
                        : `I entered the code${acceptance.clicked.length ? ` and tapped *${acceptance.clicked[0]}*` : ""}, but *${label}* is still showing the code screen (code may have expired). ` +
                          `Please paste the newest SMS code here, or reply *retry* / *cancel*.`,
            };
        }

        try {
            const st = await parked.context.storageState();
            await saveBrowserProfileState({
                familyId: input.familyId,
                userId: input.userId,
                storageStateJson: JSON.stringify(st),
                lastPartner: parked.partner,
                lastUrl: parked.page.url(),
            });
        } catch {
            /* ignore */
        }

        const sku = parseExactSkuFromGoal(parked.goal, parked.input.productUrl || parked.input.startUrl);
        const addressLabel =
            parked.input.deliveryAddress?.trim() || parked.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim();
        const pincode = extractPincode(addressLabel);
        const shortName = sku ? sku.name.replace(/\s*\(.*?\)\s*/g, " ").trim().slice(0, 60) : "your item";
        await progress(
            parked.partner === "apollo"
                ? `signed in ✓ — checking your Apollo cart first (I'll remove anything else in it), then adding ${shortName}…`
                : `signed in ✓ — adding ${shortName} to cart…`,
        );

        const taskInput: RunBrowserTaskInput = {
            ...parked.input,
            otp: input.otp.trim(),
            familyId: input.familyId,
            userId: input.userId,
            goal: parked.goal,
            partner: (parked.input.partner || parked.partner) as RunBrowserTaskInput["partner"],
            browserGeneration: parked.generation,
        };
        const worker = new PlaywrightBrowserWorker();

        // Deterministic Apollo path: exact product page → Add → cart → confirm card
        if (parked.partner === "apollo") {
            const det = await apolloExactSkuToConfirm({
                page: parked.page,
                goal: parked.goal,
                startUrl: parked.input.startUrl,
                productUrl: parked.input.productUrl,
                deliveryAddress: parked.input.deliveryAddress,
                deadlineAt,
                isCancelled: cancelled,
                progress,
            });
            if (det) return det;
            await progress(`still working — finding *${shortName}* on ${label}…`);
        }

        const continued = await worker.continueParkedAfterOtp({
            browser: parked.browser,
            context: parked.context,
            page: parked.page,
            input: taskInput,
            partner: parked.partner,
            generation: parked.generation,
            goal: parked.goal,
            deadlineAt,
            extraHint: sku
                ? `Exact SKU: "${sku.name}"${sku.productUrl ? ` (product page ${sku.productUrl})` : ""}. Add quantity 1 only; select delivery address${pincode ? ` with pincode ${pincode}` : ""}; prefer COD; then emit need_user_confirm with real item, total and address.`
                : undefined,
        });
        if (continued.retainBrowser) state.retain = true;
        logPostOtp("gemini_done", { status: continued.result.status, steps: continued.result.steps });
        if (parked.partner === "apollo" && continued.result.status === "need_user_confirm") {
            // Gemini-built card: same hard guard as the deterministic path (exactly 1 line, qty 1).
            return guardApolloConfirmCart(parked.page, continued.result, sku?.name, deadlineAt);
        }
        return continued.result;
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const { startStillWorkingTimer, STILL_WORKING_TEXT } = await import("./browserProgressNotify.service");
    const stopNotice = startStillWorkingTimer(async () => {
        if (state.timedOut || cancelled()) return;
        await input.onProgress?.(STILL_WORKING_TEXT, "still_working");
    });
    try {
        const timeout = new Promise<BrowserTaskResult>((resolve) => {
            timer = setTimeout(() => {
                state.timedOut = true;
                logPostOtp("timeout", { budgetMs, url: (() => { try { return parked.page.url(); } catch { return ""; } })() });
                resolve({
                    status: "error",
                    mode: "playwright",
                    partner: parked.partner,
                    steps: 0,
                    failureReason: "post_otp_timeout",
                    message:
                        `I entered your code on *${label}*, but the cart step didn't finish within ${Math.round(budgetMs / 1000)}s. ` +
                        `Nothing was ordered or paid.`,
                });
            }, budgetMs);
        });
        // Cancel stops the run immediately (closing Chromium in finally aborts any page op).
        let cancelPoll: ReturnType<typeof setInterval> | undefined;
        const cancelledP = new Promise<BrowserTaskResult>((resolve) => {
            cancelPoll = setInterval(() => {
                if (!cancelled()) return;
                state.timedOut = true;
                logPostOtp("cancelled_mid_run");
                resolve({ status: "cancelled", mode: "playwright", partner: parked.partner, steps: 0, message: "Cancelled." });
            }, 1000);
        });
        const result = await Promise.race([work(), timeout, cancelledP]).finally(() => {
            if (cancelPoll) clearInterval(cancelPoll);
        });
        logPostOtp("result", { status: result.status, reason: result.failureReason, ms: Date.now() - startedAt });
        if (result.status === "error" && parked.partner === "apollo") {
            await captureCheckoutDiagnostic(parked.page, {
                familyId: input.familyId,
                userId: input.userId,
                flow: "post_otp",
                stage: result.failureReason || "error",
                reason: result.message.slice(0, 200),
            }).catch(() => null);
        }
        // Non-Apollo sites: verify the cart in code, then park for the step-engine checkout.
        if (
            result.status === "need_user_confirm" &&
            result.mode === "playwright" &&
            !state.timedOut &&
            !cancelled() &&
            isGenericCheckoutPartner(parked.partner, parked.goal)
        ) {
            const replaced = await parkGenericConfirm({
                result,
                browser: parked.browser,
                context: parked.context,
                page: parked.page,
                taskInput: parked.input,
                partner: parked.partner,
                goal: parked.goal,
                generation: parked.generation,
            }).catch(() => null);
            if (replaced) return replaced;
            if (peekParkedCheckout(input.familyId, input.userId)) state.retain = true;
        }
        // Keep the signed-in page (cart built) for the user's "confirm" — never re-login for checkout.
        if (
            result.status === "need_user_confirm" &&
            result.mode === "playwright" &&
            !state.timedOut &&
            !cancelled() &&
            parked.partner === "apollo"
        ) {
            try {
                parkSignedInCheckout({
                    result,
                    browser: parked.browser,
                    context: parked.context,
                    page: parked.page,
                    taskInput: parked.input,
                    partner: parked.partner,
                    goal: parked.goal,
                    generation: parked.generation,
                });
                state.retain = true;
            } catch (err) {
                logPostOtp("checkout_park_failed", { msg: err instanceof Error ? err.message : String(err) });
            }
        }
        return result;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logPostOtp("error", { msg: msg.slice(0, 200) });
        return {
            status: "error",
            mode: "playwright",
            partner: parked.partner,
            steps: 0,
            failureReason: /closed|Target/i.test(msg) ? "chromium_crash" : "unknown",
            message: `Something broke after I entered your code on *${label}* (${msg.slice(0, 120)}). Nothing was ordered or paid.`,
        };
    } finally {
        if (timer) clearTimeout(timer);
        stopNotice();
        if (state.timedOut || (!state.retain && !hasParkedBrowserOtpSession(input.familyId, input.userId))) {
            // Closing Chromium also unblocks any still-running page op in work()
            await closeTakenPark(parked);
        }
    }
}

/**
 * Park the signed-in page (cart built, confirm card about to be sent) for checkout.
 * Stamps the card id onto the result so the WA draft can only confirm THIS card.
 */
function parkSignedInCheckout(args: {
    result: BrowserTaskResult;
    browser: import("playwright").Browser;
    context: import("playwright").BrowserContext;
    page: import("playwright").Page;
    taskInput: RunBrowserTaskInput;
    partner: string;
    goal: string;
    generation: number;
}): ParkedCheckoutSession {
    const row = parkBrowserForCheckout({
        familyId: args.taskInput.familyId,
        userId: args.taskInput.userId,
        partner: args.partner,
        goal: args.goal,
        generation: args.generation,
        browser: args.browser,
        context: args.context,
        page: args.page,
        taskInput: args.taskInput,
        confirm: args.result.confirm,
    });
    args.result.confirm = { ...(args.result.confirm || {}), cardId: row.cardId };
    const mins = Math.max(1, Math.round(checkoutParkTtlMs() / 60_000));
    args.result.message =
        `${args.result.message}\n_I'm keeping ${partnerLabel(args.partner)} signed in with this cart for ~${mins} min, so *confirm* places it without a new code._`;
    return row;
}

/** Non-Apollo commerce sites whose confirm → checkout runs through the agent-layer step engine. */
function isGenericCheckoutPartner(partner: string, goal: string): boolean {
    return partner !== "apollo" && partner !== "uber" && isAllowedOrderSite(partner) && !isRideGoal(goal);
}

/**
 * Non-Apollo confirm card: verify the live cart in code (exactly the item ×1, no membership)
 * and park the signed-in page for checkout. Returns a replacement error result when the cart
 * can't be verified (fail closed — no card), or null when parked OK.
 */
async function parkGenericConfirm(args: {
    result: BrowserTaskResult;
    browser: import("playwright").Browser;
    context: import("playwright").BrowserContext;
    page: import("playwright").Page;
    taskInput: RunBrowserTaskInput;
    partner: string;
    goal: string;
    generation: number;
}): Promise<BrowserTaskResult | null> {
    const label = partnerLabel(args.partner);
    const skuName = args.result.confirm?.items?.[0]?.replace(/\s*×\d+.*$/, "").trim() || null;
    const v = await verifyGenericCart(args.page, { partner: args.partner, skuName, log: logCheckout }).catch(() => null);
    if (!v || !v.ok) {
        return {
            ...args.result,
            status: "error",
            failureReason: "cart_mismatch",
            confirm: undefined,
            message: v
                ? `I stopped before checkout on *${label}* — the cart didn't look right (${v.detail}). Nothing was ordered or paid.`
                : `I couldn't double-check the *${label}* cart, so I stopped here. Nothing was ordered or paid.`,
        };
    }
    const shownAddr = args.result.confirm?.addressLabel;
    const savedAddr = args.taskInput.deliveryAddress?.trim() || args.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim();
    // The store must show the family-book place (pincode + flat/street line) — never a
    // store-account default like an old Gurugram address.
    const target = savedAddr ? splitAddress(savedAddr) : null;
    const matches = Boolean(
        savedAddr && shownAddr && addressMatches(shownAddr, savedAddr) && (!target || storeAddressMatchesPlace(shownAddr, target)),
    );
    if (!matches) {
        return {
            ...args.result,
            status: "error",
            failureReason: "cart_mismatch",
            confirm: undefined,
            message: shownAddr
                ? `I stopped on *${label}* — it had a different delivery address selected, not the one from your address book. Nothing was ordered or paid.`
                : `I stopped on *${label}* — I couldn't see which delivery address it selected, so I didn't continue. Nothing was ordered or paid.`,
        };
    }
    if (v.payableTotal && !args.result.confirm?.totalLabel) {
        args.result.confirm = { ...(args.result.confirm || {}), totalLabel: v.payableTotal };
    }
    parkSignedInCheckout(args);
    return null;
}

/**
 * Hard wall-clock budget for confirm → placed order. Runs async (WhatsApp gets progress lines
 * and the result); the address step (select saved / add new on Apollo) can take ~40-60s.
 */
/** Runaway ceiling only (default 20 min) — checkout stops on no-progress / guardrails, not a short timer. */
export const CHECKOUT_BUDGET_MS = browserRunawayMs();

function logCheckout(event: string, extra?: Record<string, unknown>): void {
    try {
        console.log(`[pharmacy-checkout] ${event} ${extra ? JSON.stringify(extra) : ""}`.trim());
    } catch {
        /* ignore */
    }
}

export type ParkedCheckoutRun = {
    /** No usable parked signed-in session (expired / other instance / card mismatch). */
    noSession?: boolean;
    outcome?: ApolloCheckoutOutcome;
    /** True when the page was re-parked (user may reply confirm again on the same session). */
    reparked?: boolean;
    /** New card id when re-parked for a re-confirm (e.g. amount changed). */
    cardId?: string;
    message: string;
    status: "placed" | "placed_unverified" | "need_user_confirm" | "failed" | "no_session";
    orderIds?: string;
    totalLabel?: string;
};

/**
 * User replied "confirm" to the exact confirm card → continue checkout on the parked
 * signed-in page and place a Cash-on-Delivery order. Never logs in again, never sends
 * an SMS, never selects a payment method other than COD.
 */
export async function continueParkedCheckout(input: Parameters<typeof continueParkedCheckoutInner>[0]): Promise<ParkedCheckoutRun> {
    const partner = peekParkedCheckout(input.familyId, input.userId)?.partner;
    const run = await continueParkedCheckoutInner(input);
    if (partner && partner !== "apollo") {
        // Checkout copy below was written for Apollo; name the real site for others.
        const label = partnerLabel(partner);
        run.message = run.message.replace(/\bApollo(?: Pharmacy)?\b/g, label);
    }
    return run;
}

async function continueParkedCheckoutInner(input: {
    familyId: string;
    userId: string;
    cardId?: string;
    /** Care recipient (Kavach user) — their name goes on a newly added Apollo address. */
    recipientUserId?: string;
    /** Progress lines (activity log); stage "still_working" is the one WhatsApp-worthy line. */
    onProgress?: (detail: string, stage?: string) => void | Promise<void>;
    budgetMs?: number;
}): Promise<ParkedCheckoutRun> {
    const session = takeParkedCheckout(input.familyId, input.userId);
    const expiredMsg =
        "The Apollo login session expired, so I couldn't place the order — nothing was ordered or paid.\n" +
        "Reply *order again* to restart — it will need a new OTP.";
    if (!session) {
        logCheckout("no_parked_session", { familyId: input.familyId, userId: input.userId });
        return { noSession: true, status: "no_session", message: expiredMsg };
    }
    if (input.cardId && session.cardId !== input.cardId) {
        logCheckout("card_mismatch", { parked: session.cardId, draft: input.cardId });
        await closeCheckoutSession(session);
        return { noSession: true, status: "no_session", message: expiredMsg };
    }
    if (!isBrowserGenerationCurrent(input.familyId, input.userId, session.generation)) {
        logCheckout("stale_generation", { gen: session.generation });
        await closeCheckoutSession(session);
        return { noSession: true, status: "no_session", message: expiredMsg };
    }
    if (session.placeClicked) {
        await closeCheckoutSession(session);
        return {
            status: "placed_unverified",
            message:
                "I already tapped *Place order (Cash on Delivery)* on this Apollo cart earlier. " +
                "Please check Apollo → My Orders — I won't place it again, so you don't get a duplicate.",
        };
    }

    const budgetMs = input.budgetMs ?? CHECKOUT_BUDGET_MS;
    const startedAt = Date.now();
    const state = { timedOut: false, placeClicked: false };
    const cancelled = () =>
        state.timedOut || !isBrowserGenerationCurrent(input.familyId, input.userId, session.generation);
    const progress = async (d: string) => {
        if (state.timedOut) return;
        try {
            await input.onProgress?.(d);
        } catch {
            /* ignore */
        }
    };
    const sku = parseExactSkuFromGoal(session.goal, session.input.productUrl || session.input.startUrl);
    const addressLabel =
        session.confirm?.addressLabel ||
        session.input.deliveryAddress?.trim() ||
        session.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim();
    const pincode = extractPincode(addressLabel);
    const confirmedTotalRupees = rupeesFromLabel(session.confirm?.totalLabel);
    const addressTarget = addressTargetFrom(addressLabel);
    const recipientName = await lookupKavachUserName(input.recipientUserId || input.userId);
    const accountPhone = session.input.loginPhone || session.goal.match(/login_phone=(\S+)/i)?.[1];
    logCheckout("start", {
        card: session.cardId,
        url: (() => {
            try {
                return session.page.url();
            } catch {
                return "";
            }
        })(),
        pincode,
        confirmedTotalRupees,
        budgetMs,
        addressTarget: addressTarget ? { line1: addressTarget.line1, pincode: addressTarget.pincode, queries: addressTarget.searchQueries.length } : null,
        recipientName: recipientName ? "kavach" : null,
        accountPhone: accountPhone ? "set" : null,
    });

    const runner =
        session.partner === "apollo"
            ? runApolloCodCheckout
            : (page: import("playwright").Page, o: Parameters<typeof runApolloCodCheckout>[1]) =>
                  runGenericCodCheckout(page, { ...o, partner: session.partner });
    const workPromise = runner(session.page, {
        deadlineAt: startedAt + budgetMs - 3_000,
        pincode,
        addressHints: addressHintsFrom(addressLabel),
        addressTarget,
        recipientName,
        accountPhone,
        confirmedTotalRupees,
        skuName: sku?.name || session.confirm?.items?.[0]?.replace(/\s*×\d+.*$/, "").trim() || undefined,
        priorAddressVerified: session.addressVerified,
        mayPlace: () => !cancelled() && Date.now() < startedAt + budgetMs - 8_000,
        isCancelled: cancelled,
        progress,
        onPlaceClicked: () => {
            state.placeClicked = true;
            session.placeClicked = true;
        },
        geminiMaxSteps: 12,
        log: logCheckout,
    }).catch(
        (err): ApolloCheckoutOutcome => ({
            status: "stuck",
            stage: "unknown",
            url: "",
            detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
        }),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budgetMs);
    });
    const { startStillWorkingTimer, STILL_WORKING_TEXT } = await import("./browserProgressNotify.service");
    const stopNotice = startStillWorkingTimer(async () => {
        if (cancelled()) return;
        await input.onProgress?.(STILL_WORKING_TEXT, "still_working");
    });
    // Cancel before Place order stops immediately; after the Place tap we never claim "cancelled".
    let cancelPoll: ReturnType<typeof setInterval> | undefined;
    const cancelledP = new Promise<"cancelled">((resolve) => {
        cancelPoll = setInterval(() => {
            if (!state.timedOut && !state.placeClicked && !isBrowserGenerationCurrent(input.familyId, input.userId, session.generation)) {
                resolve("cancelled");
            }
        }, 1000);
    });
    const raced = await Promise.race([workPromise, timeout, cancelledP]);
    if (cancelPoll) clearInterval(cancelPoll);
    stopNotice();
    let outcome: ApolloCheckoutOutcome | null =
        raced === "cancelled" ? { status: "cancelled", url: "", detail: "cancelled by user" } : raced;
    if (timer) clearTimeout(timer);
    let workSettled = raced !== "cancelled";
    if (raced === "cancelled") {
        state.timedOut = true; // stops progress + makes the runner's isCancelled() true
        logCheckout("cancelled_mid_run", {});
    }
    if (!outcome) {
        state.timedOut = true;
        logCheckout("timeout", { budgetMs, placeClicked: state.placeClicked });
        const settled = await Promise.race([
            workPromise,
            new Promise<null>((r) => setTimeout(() => r(null), 6_000)),
        ]);
        workSettled = Boolean(settled);
        outcome = state.placeClicked
            ? {
                  status: "placed_unverified",
                  url: "",
                  detail: "Place order (COD) was tapped but the confirmation didn't load in time",
              }
            : {
                  status: "stuck",
                  stage: "unknown",
                  url: "",
                  detail: `checkout didn't finish within ${Math.round(budgetMs / 1000)}s`,
              };
    }
    logCheckout("outcome", { status: outcome.status, detail: outcome.detail.slice(0, 160), ms: Date.now() - startedAt });
    if (outcome.status !== "placed" && outcome.status !== "cancelled" && !session.page.isClosed()) {
        // Screenshot + trimmed text of whatever screen checkout stopped on (log + mock peek).
        await captureCheckoutDiagnostic(session.page, {
            familyId: session.familyId,
            userId: session.userId,
            flow: "checkout",
            stage: "stage" in outcome ? String(outcome.stage) : outcome.status,
            reason: `${outcome.status}: ${outcome.detail}`,
        }).catch(() => null);
    }

    const label = partnerLabel(session.partner);
    const item = session.confirm?.items?.[0] || sku?.name || "your item";
    const mins = Math.max(1, Math.round(checkoutParkTtlMs() / 60_000));
    const repark = (
        confirm?: ParkedCheckoutSession["confirm"],
        newCard = false,
        addressVerified?: ParkedCheckoutSession["addressVerified"],
    ) => {
        const row = parkBrowserForCheckout({
            familyId: session.familyId,
            userId: session.userId,
            partner: session.partner,
            goal: session.goal,
            generation: session.generation,
            browser: session.browser,
            context: session.context,
            page: session.page,
            taskInput: session.input,
            cardId: newCard ? undefined : session.cardId,
            confirm: confirm ?? session.confirm,
            placeClicked: session.placeClicked,
            addressVerified: addressVerified ?? session.addressVerified,
        });
        return row.cardId;
    };
    const canRepark = workSettled && !state.placeClicked && !session.page.isClosed();

    switch (outcome.status) {
        case "placed": {
            await closeCheckoutSession(session);
            const addr = addressLabel || "your saved Apollo address";
            const lines = [
                `✅ *Order placed on ${label}* — Cash on Delivery`,
                `• ${item}`,
                ``,
                outcome.orderIds
                    ? `Apollo order ID: *${outcome.orderIds}*`
                    : `Apollo didn't show the order ID on screen — it will be in Apollo → My Orders.`,
                outcome.totalLabel ? `Pay on delivery: *${outcome.totalLabel}* (cash)` : `Pay on delivery (cash) — amount as shown by Apollo.`,
                `Deliver to: ${addr}${outcome.addressVerified === "full" ? "" : pincode ? ` _(Apollo checkout showed pincode ${pincode})_` : ""}`,
                ``,
                `Track or cancel it in Apollo → My Orders.`,
            ];
            return {
                outcome,
                status: "placed",
                orderIds: outcome.orderIds,
                totalLabel: outcome.totalLabel,
                message: lines.join("\n"),
            };
        }
        case "placed_unverified":
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "placed_unverified",
                totalLabel: outcome.totalLabel,
                message:
                    `I tapped *Place order (Cash on Delivery)* on ${label}${outcome.totalLabel ? ` for ${outcome.totalLabel}` : ""}, ` +
                    `but Apollo's confirmation page didn't load in time, so I can't show the order number.\n` +
                    `Please check Apollo → My Orders before ordering again — I won't retry, so you don't get a duplicate order.`,
            };
        case "amount_changed": {
            if (canRepark) {
                const cardId = repark(
                    { ...(session.confirm || {}), totalLabel: `${outcome.payableLabel} (Apollo payable, Cash on Delivery)` },
                    true,
                    outcome.addressVerified,
                );
                return {
                    outcome,
                    status: "need_user_confirm",
                    reparked: true,
                    cardId,
                    message:
                        `*Confirm before pay — ${label}:*\n• ${item}\n\n` +
                        `Apollo now shows *${outcome.payableLabel}* to pay on delivery ` +
                        `(the earlier card said ${session.confirm?.totalLabel?.replace(/\s*\(.*\)\s*$/, "") || "less"}). Nothing is placed yet.\n\n` +
                        `Reply *confirm* to place it for ${outcome.payableLabel} with *Cash on Delivery*, or *cancel*.`,
                };
            }
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "failed",
                message: `Apollo's payable amount changed to ${outcome.payableLabel}, so I stopped — nothing was ordered or paid. Reply *order again* to restart (new OTP), or *cancel*.`,
            };
        }
        case "cod_unavailable":
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "failed",
                message:
                    `*${label}* isn't offering *Cash on Delivery* for this order (${outcome.detail.slice(0, 140)}).\n` +
                    `I did *not* place it and I won't use UPI or card. Nothing was ordered or paid.\n` +
                    `Reply *cancel*, or try another item / pharmacy.`,
            };
        case "session_expired":
            await closeCheckoutSession(session);
            return { outcome, status: "failed", noSession: true, message: expiredMsg };
        case "rx_required":
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "failed",
                message: `*${label}* wants a prescription review before this order, so I stopped — nothing was ordered or paid. Reply *cancel*.`,
            };
        case "order_failed":
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "failed",
                message:
                    `*${label}* showed a problem after *Place order (Cash on Delivery)*: ${outcome.detail.slice(0, 140)}\n` +
                    `Please check Apollo → My Orders — I won't retry automatically, so you don't get a duplicate.`,
            };
        case "cart_mismatch":
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "failed",
                // Keep the WA draft so *order again* can rebuild the single-item cart.
                noSession: true,
                message:
                    `I stopped before *Place order* on ${label}: the cart doesn't hold exactly 1 × ${item.replace(/\s+—\s+₹.*$/, "")} ` +
                    `(${outcome.detail.slice(0, 180)}).\n` +
                    `Nothing was ordered or paid. Reply *order again* to rebuild the cart (it will need a new OTP), or *cancel*.`,
            };
        case "cancelled":
            await closeCheckoutSession(session);
            return { outcome, status: "failed", message: "Cancelled — nothing was ordered." };
        case "address_unverified":
        case "stuck":
        case "dry_run_stop":
        default: {
            const why =
                outcome.status === "address_unverified"
                    ? `I couldn't set the delivery address${pincode ? ` (${pincode})` : ""} on Apollo — ${outcome.detail.replace(/\s*\[step:[^\]]*\]\s*$/, "").slice(0, 160)}`
                    : `I couldn't finish Apollo checkout (${outcome.detail.slice(0, 100)})`;
            if (canRepark) {
                repark();
                return {
                    outcome,
                    status: "failed",
                    reparked: true,
                    cardId: session.cardId,
                    message:
                        `${why}, so I stopped — nothing was ordered or paid.\n` +
                        `Your cart is still open and signed in for ~${mins} min: reply *confirm* to try again (no new code), or *cancel*.`,
                };
            }
            await closeCheckoutSession(session);
            return {
                outcome,
                status: "failed",
                message: `${why}, so I stopped — nothing was ordered or paid. Reply *order again* to restart (it will need a new OTP), or *cancel*.`,
            };
        }
    }
}

export { DryRunBrowserWorker, PlaywrightBrowserWorker, TINY_PNG_B64 };
