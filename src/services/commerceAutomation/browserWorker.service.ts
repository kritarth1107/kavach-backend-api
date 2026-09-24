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

export type BrowserTaskStatus =
    | "running"
    | "need_otp"
    | "need_user_confirm"
    | "done"
    | "error"
    | "cancelled";

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
};

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

function browserTaskDeadlineMs(input?: { deadlineMs?: number }): number {
    const raw =
        input?.deadlineMs ??
        Number(process.env.BROWSER_TASK_DEADLINE_MS) ??
        28_000;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 28_000;
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

        try {
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
                await this.persist(context, input, playbook.partner, page.url());
                return {
                    status: "error",
                    message: earlyBlock,
                    steps: 0,
                    url: page.url(),
                    mode: "playwright",
                    partner: String(playbook.partner),
                };
            }

            // If OTP provided, try typing into focused/OTP field first
            if (input.otp) {
                try {
                    const otpSel =
                        'input[autocomplete="one-time-code"], input[name*="otp" i], input[placeholder*="OTP" i], input[type="tel"]';
                    const el = page.locator(otpSel).first();
                    if (await el.count()) {
                        await el.fill(input.otp);
                        await page.keyboard.press("Enter").catch(() => undefined);
                        await page.waitForTimeout(1200);
                    }
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
                    playbookHint: `${playbook.searchHint} ${playbook.confirmHint}`,
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
            try {
                await context?.close();
            } catch {
                /* ignore */
            }
            await browser.close().catch(() => undefined);
        }
    }

    private async persist(
        context: import("playwright").BrowserContext,
        input: RunBrowserTaskInput,
        partner: string,
        url: string,
    ): Promise<void> {
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
    return {
        // steps:0 signals follow-up formatter: OTP page likely never reached
        status: "need_otp",
        mode: "playwright",
        partner: String(playbook.partner),
        steps: 0,
        url: playbook.startUrl,
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
                    `*${label}* didn't finish login in time (site slow, blocked, or browser busy).`,
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
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out/i.test(msg)) {
            return progressNeedOtpResult(input, msg);
        }
        console.warn("runBrowserTask failed:", msg);
        return {
            status: "error",
            mode: "playwright",
            partner: String(input.partner || "generic"),
            steps: 0,
            message: `Browser task failed: ${msg.slice(0, 180)}. You can retry, paste an OTP if you have one, or *cancel*.`,
        };
    }
}

export { DryRunBrowserWorker, PlaywrightBrowserWorker, TINY_PNG_B64 };
