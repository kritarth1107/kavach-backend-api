/**
 * Step engine: deterministic step first, Stagehand self-healing fallback second — with code
 * guardrails around every agent action. The irreversible parts (cart check, COD selection,
 * total check, Place order ×1) are code decisions; the model only locates / reads.
 */
import type { Page } from "playwright";
import { z } from "zod";
import type { ApolloCheckoutOptions, ApolloCheckoutOutcome } from "../apolloCheckout";
import {
    CART_UPSELL_LINE_RE,
    COD_RE,
    NON_COD_PAYMENT_RE,
    PLACE_ORDER_RE,
    isCodSelection,
    parseRupees,
    totalWithinConfirmed,
    validateCartLines,
} from "./guardrails";
import { siteConfig, type CheckoutStepKey } from "./siteConfigs";
import { stagehandExtract, stagehandLocate, stagehandStep, type AgentStepResult } from "./stagehandFallback.service";

type Log = (event: string, extra?: Record<string, unknown>) => void;

/** Run one step: deterministic handler first; if it didn't make progress, the agent fallback. */
export async function runStep(
    page: Page,
    args: {
        partner: string;
        step?: CheckoutStepKey;
        goal?: string;
        deterministic?: () => Promise<boolean>;
        log?: Log;
    },
): Promise<{ by: "code" | "agent" | "none"; agent?: AgentStepResult }> {
    const log = args.log ?? (() => undefined);
    if (args.deterministic) {
        const ok = await args.deterministic().catch(() => false);
        if (ok) return { by: "code" };
    }
    const cfg = siteConfig(args.partner);
    const goal = args.goal || (args.step && cfg ? cfg.goals[args.step] : "");
    if (!goal) return { by: "none" };
    const agent = await stagehandStep(page, { goal, log });
    return { by: agent.status === "acted" ? "agent" : "none", agent };
}

const safeUrl = (page: Page) => {
    try {
        return page.url();
    } catch {
        return "";
    }
};
const remaining = (deadlineAt: number) => deadlineAt - Date.now();
const nap = (page: Page, ms: number) => page.waitForTimeout(ms).catch(() => undefined);

const screenSchema = z.object({
    screen: z
        .enum(["cart", "address", "payment", "upsell_popup", "order_success", "login", "other"])
        .describe("Which checkout screen is showing"),
    cartItems: z
        .array(z.object({ name: z.string(), quantity: z.number().nullable() }))
        .describe("Every product line in the cart/bill (not fees). Empty if not visible."),
    billLines: z.array(z.string()).describe("Every line of the bill summary, e.g. 'Item total ₹120', 'Delivery fee ₹25', 'Swiggy One ₹99'"),
    payableTotal: z.string().nullable().describe("Final amount to pay, exactly as shown, e.g. '₹145'"),
    selectedPaymentMethod: z.string().nullable().describe("The payment method currently selected, exactly as shown, or null"),
    orderId: z.string().nullable().describe("Order id if an order confirmation is shown"),
    eta: z.string().nullable().describe("Delivery ETA if shown"),
});
type Screen = z.infer<typeof screenSchema>;

async function readScreen(page: Page, log: Log): Promise<Screen | null> {
    return stagehandExtract<Screen>(page, {
        instruction:
            "Read this shopping checkout page. Report the screen type, cart product lines with quantities, bill lines, final payable total, the selected payment method and any order confirmation.",
        schema: screenSchema,
        log,
    });
}

function hasUpsellBillLine(s: Screen): string | null {
    const all = [...(s.billLines || []), ...(s.cartItems || []).map((c) => c.name)];
    return all.find((l) => CART_UPSELL_LINE_RE.test(l)) ?? null;
}

/**
 * Generic COD checkout for non-Apollo sites (signed-in page with the confirmed cart).
 * Same outcome contract as runApolloCodCheckout so the WhatsApp layer is unchanged.
 */
export async function runGenericCodCheckout(
    page: Page,
    opts: ApolloCheckoutOptions & { partner: string },
): Promise<ApolloCheckoutOutcome> {
    const log = opts.log ?? (() => undefined);
    const cfg = siteConfig(opts.partner);
    const say = async (d: string) => {
        try {
            await opts.progress?.(d);
        } catch {
            /* ignore */
        }
    };
    if (!cfg || cfg.kind === "ride") {
        return { status: "stuck", stage: "unknown", url: safeUrl(page), detail: "no checkout config for this site" };
    }
    if (cfg.cartUrl) {
        await page.goto(cfg.cartUrl, { waitUntil: "domcontentloaded", timeout: 25_000 }).catch(() => undefined);
        await nap(page, 1500);
    } else {
        await runStep(page, { partner: opts.partner, step: "open_cart", log });
        await nap(page, 1200);
    }
    await say("checking your cart…");

    let screen = await readScreen(page, log);
    if (!screen) {
        // Fail closed: without a verified read of the cart we never proceed to pay.
        return { status: "stuck", stage: "cart", url: safeUrl(page), detail: "couldn't read the cart (agent layer unavailable)" };
    }
    if (screen.screen === "login") return { status: "session_expired", url: safeUrl(page), detail: "site asked to sign in again" };
    if (screen.cartItems?.length) {
        const cart = validateCartLines(
            screen.cartItems.map((c) => ({ name: c.name, qty: c.quantity })),
            opts.skuName,
        );
        if (!cart.ok) return { status: "cart_mismatch", url: safeUrl(page), detail: cart.detail };
    } else {
        return { status: "cart_mismatch", url: safeUrl(page), detail: "cart looks empty" };
    }

    // Walk to the payment screen (bounded).
    for (let i = 0; i < 8 && screen && screen.screen !== "payment"; i++) {
        if (opts.isCancelled?.()) return { status: "cancelled", url: safeUrl(page), detail: "cancelled by user" };
        if (remaining(opts.deadlineAt) < 30_000) break;
        const step: CheckoutStepKey =
            screen.screen === "upsell_popup"
                ? "dismiss_upsell"
                : screen.screen === "cart"
                  ? "proceed_checkout"
                  : screen.screen === "address"
                    ? "select_address"
                    : "reach_payment";
        const r = await runStep(page, { partner: opts.partner, step, log });
        log("generic_step", { step, by: r.by, agent: r.agent?.status });
        await nap(page, 1800);
        screen = await readScreen(page, log);
        if (screen?.screen === "login") return { status: "session_expired", url: safeUrl(page), detail: "site asked to sign in again" };
    }
    if (!screen || screen.screen !== "payment") {
        return { status: "stuck", stage: "payment", url: safeUrl(page), detail: "couldn't reach the payment screen" };
    }
    await say("choosing Cash on Delivery…");

    // COD selection: model locates, CODE validates the live element text and clicks it.
    if (!isCodSelection(screen.selectedPaymentMethod)) {
        const cands = await stagehandLocate(page, {
            goal: `Find the '${cfg.codLabels.join("' / '")}' payment option (cash / pay on delivery). Only that option.`,
            log,
        });
        const cod = cands.find((c) => COD_RE.test(c.liveText) && !PLACE_ORDER_RE.test(c.liveText) && isCodSelection(c.liveText));
        if (!cod) return { status: "cod_unavailable", url: safeUrl(page), detail: "no Cash/Pay on Delivery option found" };
        await page.locator(cod.selector).first().click({ timeout: 8000 }).catch(() => undefined);
        await nap(page, 1500);
        screen = await readScreen(page, log);
        if (!screen || !isCodSelection(screen.selectedPaymentMethod)) {
            return { status: "cod_unavailable", url: safeUrl(page), detail: `COD not selected (shows: ${screen?.selectedPaymentMethod ?? "unknown"})` };
        }
    }

    // Final code checks before Place order — on a FRESH read of the page.
    screen = await readScreen(page, log);
    if (!screen) return { status: "stuck", stage: "payment", url: safeUrl(page), detail: "couldn't re-read the payment screen" };
    if (!isCodSelection(screen.selectedPaymentMethod)) {
        return { status: "cod_unavailable", url: safeUrl(page), detail: `COD not selected (shows: ${screen.selectedPaymentMethod ?? "unknown"})` };
    }
    const upsell = hasUpsellBillLine(screen);
    if (upsell) return { status: "cart_mismatch", url: safeUrl(page), detail: `bill has a membership/plan line: ${upsell.slice(0, 60)}` };
    if (screen.cartItems?.length) {
        const cart = validateCartLines(screen.cartItems.map((c) => ({ name: c.name, qty: c.quantity })), opts.skuName);
        if (!cart.ok) return { status: "cart_mismatch", url: safeUrl(page), detail: cart.detail };
    }
    const payable = parseRupees(screen.payableTotal);
    if (!totalWithinConfirmed(payable, opts.confirmedTotalRupees)) {
        return {
            status: "amount_changed",
            payableLabel: screen.payableTotal || "unknown",
            addressVerified: "none",
            url: safeUrl(page),
            detail: `payable ${screen.payableTotal ?? "?"} vs confirmed ₹${opts.confirmedTotalRupees ?? "?"}`,
        };
    }
    if (opts.dryRun) {
        return { status: "dry_run_stop", stage: "payment", payableLabel: screen.payableTotal || undefined, url: safeUrl(page), detail: "dry run: stopped before Place order" };
    }
    if (opts.isCancelled?.()) return { status: "cancelled", url: safeUrl(page), detail: "cancelled by user" };

    const placeCands = await stagehandLocate(page, { goal: "Find the final 'Place order' / 'Confirm order' button.", log });
    const place = placeCands.find((c) => PLACE_ORDER_RE.test(c.liveText) && !NON_COD_PAYMENT_RE.test(c.liveText));
    if (!place) return { status: "stuck", stage: "payment", url: safeUrl(page), detail: "couldn't find a COD Place order button" };
    if (opts.mayPlace && !opts.mayPlace()) return { status: "cancelled", url: safeUrl(page), detail: "not allowed to place (timeout/cancel)" };
    opts.onPlaceClicked?.();
    log("generic_place_click", { text: place.liveText.slice(0, 60) });
    await page.locator(place.selector).first().click({ timeout: 8000 }).catch(() => undefined);
    await nap(page, 6000);
    const after = await readScreen(page, log);
    if (after?.screen === "order_success") {
        return {
            status: "placed",
            orderIds: after.orderId || undefined,
            totalLabel: screen.payableTotal || undefined,
            addressVerified: "none",
            url: safeUrl(page),
            detail: `placed (COD)${after.eta ? `; ETA ${after.eta}` : ""}`,
        };
    }
    return { status: "placed_unverified", totalLabel: screen.payableTotal || undefined, url: safeUrl(page), detail: "clicked Place order (COD) but no confirmation page yet" };
}

/**
 * Before a non-Apollo confirm card is shown: read the live cart and require exactly the
 * confirmed item ×1 and no membership line. null = couldn't read (caller fails closed).
 */
export async function verifyGenericCart(
    page: Page,
    args: { partner: string; skuName?: string | null; log?: Log },
): Promise<{ ok: true; payableTotal: string | null } | { ok: false; detail: string } | null> {
    const log = args.log ?? (() => undefined);
    const screen = await readScreen(page, log);
    if (!screen) return null;
    if (!screen.cartItems?.length) {
        // Cart may be a drawer on this screen — open it once and re-read.
        await runStep(page, { partner: args.partner, step: "open_cart", log });
        await nap(page, 1200);
        const again = await readScreen(page, log);
        if (!again) return null;
        if (!again.cartItems?.length) return { ok: false, detail: "couldn't see the cart items" };
        return checkScreenCart(again, args.skuName);
    }
    return checkScreenCart(screen, args.skuName);
}

function checkScreenCart(s: Screen, skuName?: string | null): { ok: true; payableTotal: string | null } | { ok: false; detail: string } {
    const upsell = hasUpsellBillLine(s);
    if (upsell) return { ok: false, detail: `membership/plan in cart: ${upsell.slice(0, 60)}` };
    const v = validateCartLines(s.cartItems.map((c) => ({ name: c.name, qty: c.quantity })), skuName);
    return v.ok ? { ok: true, payableTotal: s.payableTotal } : v;
}
