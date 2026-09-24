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
    /** Resume after OTP paste */
    otp?: string;
    /** Resume after WhatsApp confirm */
    userConfirmed?: boolean;
    /** Cap Gemini/playwright steps */
    maxSteps?: number;
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
        const browser = await pw.chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage"],
        });
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

class DryRunBrowserWorker implements BrowserWorker {
    readonly mode = "dry_run" as const;

    async runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
        const playbook = resolvePlaybook(input.partner, input.goal);
        try {
            await getOrCreateBrowserProfile(input.familyId, input.userId);
        } catch {
            /* offline smoke */
        }

        if (input.otp && !input.userConfirmed) {
            return {
                status: "need_user_confirm",
                mode: "dry_run",
                partner: String(playbook.partner),
                steps: 1,
                url: playbook.startUrl,
                message: [
                    `*${partnerLabel(String(playbook.partner))} basket* — confirm before pay:`,
                    `• ${input.goal.slice(0, 120)}`,
                    ``,
                    `Deliver to: your saved address`,
                    `Total: I'll show the live total when Chromium checkout is live`,
                    ``,
                    `Reply *confirm* to continue checkout, or *cancel*.`,
                    `_Dry-run mode: browser worker is stubbed on this host (no Chromium). OTP recorded; payment still needs your explicit confirm._`,
                ].join("\n"),
                confirm: {
                    items: [input.goal.slice(0, 80)],
                    totalLabel: "TBD",
                    addressLabel: "saved address",
                },
            };
        }

        if (input.userConfirmed) {
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

        // Fresh goal → ask for OTP (Instinct-like login) then confirm
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
        const playbook = resolvePlaybook(input.partner, input.goal);
        const profile = await getOrCreateBrowserProfile(input.familyId, input.userId);

        let pw: typeof import("playwright");
        try {
            pw = await import("playwright");
        } catch (err) {
            console.warn("playwright import failed, falling back to dry_run", err);
            return new DryRunBrowserWorker().runBrowserTask(input);
        }

        const browser = await pw.chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        });

        let context: import("playwright").BrowserContext | null = null;
        let modelUsed: string | undefined;
        let steps = 0;

        try {
            const storageState = profile.storageStateJson
                ? (JSON.parse(profile.storageStateJson) as object)
                : undefined;

            context = await browser.newContext({
                storageState: storageState as import("playwright").BrowserContextOptions["storageState"],
                viewport: { width: 1280, height: 720 },
                userAgent:
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            });
            const page = await context.newPage();
            await page.goto(playbook.startUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

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
                        return {
                            status: gated.status!,
                            message: gated.message!,
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
            const lines = [
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

        // Safety: never click pay without confirm
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

/** Public API — per-user profile + run */
export async function runBrowserTask(input: RunBrowserTaskInput): Promise<BrowserTaskResult> {
    const worker = await getBrowserWorker();
    return worker.runBrowserTask(input);
}

export { DryRunBrowserWorker, PlaywrightBrowserWorker, TINY_PNG_B64 };
