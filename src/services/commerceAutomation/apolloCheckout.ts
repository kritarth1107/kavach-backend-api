/**
 * Apollo checkout on the SAME signed-in Playwright page that built the cart
 * (parked after the confirm-before-pay card). Runs ONLY after the user replied
 * "confirm" to that exact card.
 *
 *   /medicines-cart → ensure delivery address (select saved C504/Sunita Park 492001 or add it
 *   via Apollo's own Add New Address flow — see apolloAddress.ts) → Proceed → "Deliver to"
 *   confirm popup (verify + Proceed)
 *   → /delivery-options → PROCEED → /pay/<id> → "Pay on Delivery" (COD)
 *   → "Place order for ₹X" → /order-status/<txn>/<status> ("Order ID(s) : …")
 *
 * Hard rules:
 *   - Payment method is ALWAYS Cash on Delivery. If COD is missing / disabled → stop.
 *   - Only this module clicks "Place order", and only the COD card's CTA, once.
 *   - Payable amount above the confirmed total → stop and re-confirm.
 *   - Login popup → session expired → stop (never start a new login / SMS).
 *   - Gemini is a bounded navigation fallback that can never touch payment / place.
 *   - dryRun stops right before the Place order click.
 */
import { SITE_CONFIGS } from "./agentLayer/siteConfigs";
import { stagehandStep } from "./agentLayer/stagehandFallback.service";
import type { Page } from "playwright";
import { planBrowserActions } from "./geminiComputerUse.service";
import {
    APOLLO_CART_URL,
    checkCartExactlySku,
    describeCartLines,
    readCartLines,
    waitForCartSnapshot,
    type ExactCartCheck,
} from "./apolloPostOtp";
import {
    addressReviewPopupOpen,
    deliverToSheetOpen,
    ensureApolloDeliveryAddress,
    handleAddressReviewPopup,
    type AddressTarget,
    clickReviewChangeAddress,
} from "./apolloAddress";

export type CheckoutStage =
    | "cart"
    | "address"
    /** Apollo's "Deliver to" confirm popup after cart Proceed (address + recipient + Proceed). */
    | "address_review"
    /** Circle membership (or similar) upsell drawer — always skipped, never added. */
    | "upsell"
    | "delivery_options"
    | "payment"
    | "success"
    | "order_failed"
    | "login"
    | "rx_review"
    | "unknown";

export type ApolloCheckoutOutcome =
    | {
          status: "placed";
          orderIds?: string;
          totalLabel?: string;
          transactionId?: string;
          addressVerified: "full" | "pincode" | "none";
          url: string;
          detail: string;
      }
    | { status: "placed_unverified"; totalLabel?: string; url: string; detail: string }
    | { status: "cod_unavailable"; url: string; detail: string }
    | { status: "session_expired"; url: string; detail: string }
    | {
          status: "amount_changed";
          payableLabel: string;
          addressVerified: "full" | "pincode" | "none";
          url: string;
          detail: string;
      }
    | { status: "address_unverified"; url: string; detail: string }
    /** Cart/checkout doesn't hold exactly the confirmed product at qty 1 → nothing placed. */
    | { status: "cart_mismatch"; url: string; detail: string }
    | { status: "order_failed"; url: string; detail: string }
    | { status: "rx_required"; url: string; detail: string }
    | { status: "cancelled"; url: string; detail: string }
    | { status: "stuck"; stage: CheckoutStage; url: string; detail: string }
    | { status: "dry_run_stop"; stage: CheckoutStage; payableLabel?: string; url: string; detail: string };

export type ApolloCheckoutOptions = {
    deadlineAt: number;
    pincode?: string;
    /** Distinctive address fragments, e.g. ["C504", "Sunita Park"]. */
    addressHints?: string[];
    /** Full parsed delivery address (select a matching saved address or add this one). */
    addressTarget?: AddressTarget | null;
    /** Care recipient's name from Kavach (recipient on a newly added Apollo address). */
    recipientName?: string;
    /** Signed-in Apollo account phone (only used when Apollo's own phone field is empty). */
    accountPhone?: string;
    /** Numeric rupees from the card the user confirmed (payable must not exceed it). */
    confirmedTotalRupees?: number;
    /** Confirmed product. When set, the cart must hold exactly this item ×1 before Proceed and before Place order. */
    skuName?: string;
    /** Stop right before clicking Place order (guest / test runs). */
    dryRun?: boolean;
    /** Checked immediately before the Place order click (timeout / cancel). */
    mayPlace?: () => boolean;
    isCancelled?: () => boolean;
    progress?: (detail: string) => Promise<void>;
    /** Set the moment Place order is clicked (caller must never re-click). */
    onPlaceClicked?: () => void;
    /** Address evidence already gathered on this page in an earlier run (resume on /pay). */
    priorAddressVerified?: "full" | "pincode" | "none";
    /** Max Gemini fallback steps (0 disables). */
    geminiMaxSteps?: number;
    log?: (event: string, extra?: Record<string, unknown>) => void;
};

const BASE = "https://www.apollopharmacy.in";
const PAY_BLOCK_RE =
    /pay|place\s*order|upi|card|net\s*banking|netbanking|wallet|pay\s*later|simpl|lazypay|cash|\bcod\b|buy\s*now|log\s*out|logout|sign\s*out|remove|delete|clear\s*cart|add\s*new\s*address|circle|membership|\bqr\b|scan/i;

/**
 * Upsell / membership controls nothing may ever click (Circle "Add Plan", plan radios,
 * "Add to cart" inside the Circle drawer, subscribe / upgrade / join).
 */
export const UPSELL_BLOCK_RE =
    /add\s*plan|choose\s*a\s*plan|best\s*value|\b(?:3|6|12)\s*(?:m\b|months?)|\bplan\b|circle|membership|subscri|upgrade|\bjoin\b|add\s*to\s*cart|CircleDetails|circlePlan|type="?radio|\bradio\b/i;

/** Cart-removal controls Gemini must never touch (removal is deterministic code only, pre-add). */
export const CART_REMOVE_BLOCK_RE =
    /\b(remove|delete|dustbin|trash|clear\s*cart|empty\s*cart|decrease|decrement)\b|deleteicon|dustbi|trash|remove|minus/i;

/**
 * Describe what a Gemini click would hit: its own text/selector plus the target element's
 * text, aria-label, and class names (icon-only buttons like Apollo's dustbin have no text).
 */
export async function describeClickTarget(
    page: Page,
    action: { selector?: string; x?: number; y?: number; text?: string; message?: string },
): Promise<string> {
    let out = `${action.text || ""} ${action.message || ""} ${action.selector || ""}`;
    try {
        if (action.selector) {
            out +=
                " " +
                (await page
                    .locator(action.selector)
                    .first()
                    .evaluate((start) => {
                        const parts: string[] = [];
                        let el: Element | null = start;
                        for (let i = 0; el && i < 4; i++, el = el.parentElement) {
                            const h = el as HTMLElement;
                            const cls = typeof h.className === "string" ? h.className : "";
                            // Own text only (ancestor text would be the whole card / page); classes for the chain.
                            parts.push(`${i === 0 ? (h.innerText || "").slice(0, 80) : ""} ${h.getAttribute("aria-label") || ""} ${h.getAttribute("title") || ""} ${cls} ${h.getAttribute("type") === "radio" ? "radio" : ""}`);
                            if (h.id === "checkbox-cod" || /cod|payment|pay/i.test(cls)) parts.push("pay");
                        }
                        return parts.join(" ");
                    })
                    .catch(() => ""));
        } else if (typeof action.x === "number" && typeof action.y === "number") {
            const vp = page.viewportSize() || { width: 1280, height: 720 };
            const cx = Math.round((action.x / 1000) * vp.width);
            const cy = Math.round((action.y / 1000) * vp.height);
            out +=
                " " +
                (await page
                    .evaluate(
                        ({ x, y }) => {
                            const parts: string[] = [];
                            let el: Element | null = document.elementFromPoint(x, y);
                            for (let i = 0; el && i < 4; i++, el = el.parentElement) {
                                const h = el as HTMLElement;
                                const cls = typeof h.className === "string" ? h.className : "";
                                parts.push(`${(h.innerText || "").slice(0, 80)} ${h.getAttribute("aria-label") || ""} ${h.getAttribute("title") || ""} ${cls} ${h.getAttribute("type") === "radio" ? "radio" : ""}`);
                                if (h.id === "checkbox-cod" || /cod|payment|pay/i.test(cls)) parts.push("pay");
                            }
                            return parts.join(" ");
                        },
                        { x: cx, y: cy },
                    )
                    .catch(() => "pay"));
        }
    } catch {
        out += " pay";
    }
    return out;
}

function remaining(deadlineAt: number): number {
    return deadlineAt - Date.now();
}

async function sleep(page: Page, ms: number): Promise<void> {
    await page.waitForTimeout(Math.max(0, ms)).catch(() => undefined);
}

async function bodyText(page: Page, max = 8000): Promise<string> {
    return page
        .evaluate((m) => (document.body?.innerText || "").slice(0, m), max)
        .catch(() => "");
}

function safeUrl(page: Page): string {
    try {
        return page.url();
    } catch {
        return "";
    }
}

export function rupeesFromLabel(label?: string): number | undefined {
    if (!label) return undefined;
    const m = label.replace(/,/g, "").match(/₹\s*(\d+(?:\.\d{1,2})?)/) || label.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function addressHintsFrom(addressLabel?: string): string[] {
    if (!addressLabel) return [];
    const hints: string[] = [];
    const flat = addressLabel.split(",")[0]?.trim();
    if (flat && flat.length >= 2 && flat.length <= 20) hints.push(flat);
    const m = addressLabel.match(/\b([A-Za-z]+\s+(?:park|nagar|colony|society|enclave|residency|apartments?|towers?|vihar))\b/i);
    if (m) hints.push(m[1]!);
    return hints;
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
    const loc = page.locator(selector);
    const n = Math.min(await loc.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
}

async function loginPopupVisible(page: Page): Promise<boolean> {
    if (/popup_state=open_login_popup/i.test(safeUrl(page))) return true;
    return isVisible(page, 'input[placeholder*="phone number" i], input[placeholder*="mobile number" i]');
}

async function addressPickerVisible(page: Page): Promise<boolean> {
    return page
        .evaluate(() => {
            const nodes = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="Dialog" i]'));
            return nodes.some((n) => {
                const r = (n as HTMLElement).getBoundingClientRect();
                if (r.width < 150 || r.height < 120) return false;
                const t = ((n as HTMLElement).innerText || "").toLowerCase();
                // The cart page itself (bottom bar "Amount to pay … SELECT ADDRESS") is not a picker.
                if (/amount to pay|your cart/.test(t) && !/saved address|add new address/.test(t)) return false;
                return /saved address|deliver here|select (a )?(delivery )?address|choose (a )?(delivery )?address|add new address/.test(t);
            });
        })
        .catch(() => false);
}

/* ───────────── Circle membership / upsell drawer (always skipped, never added) ───────────── */

/**
 * Apollo's cart, after Proceed (checkForCirclePopup), opens a right-side "CircleDetails" drawer:
 * "Save 15% on Medicines…", "Choose a Plan" (3/6/12 months, 12M pre-selected), footer
 * "Skip Savings" (secondary) + "Add Plan" (primary), X at the top. Skip Savings runs
 * handleSkipSavings → closes it AND continues the pending action (delivery options); X only closes.
 */
export async function upsellOpen(page: Page): Promise<boolean> {
    return page
        .evaluate(() => {
            // on-screen only (a closed drawer may sit translated off-canvas with a real size).
            // (no named helpers inside evaluate: tsx/esbuild would inject __name() into the page)
            document.querySelectorAll("[data-kv-vis]").forEach((e) => e.removeAttribute("data-kv-vis"));
            Array.from(document.querySelectorAll('button, [role="button"], [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="Dialog"], [class*="sheet" i], [class*="CircleDetails_"], [aria-label], i, span, svg')).forEach((e) => {
                const r = (e as HTMLElement).getBoundingClientRect();
                if (!(r.width > 0 && r.height > 0)) return;
                if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return;
                const cs = getComputedStyle(e as HTMLElement);
                if (cs.visibility === "hidden" || cs.opacity === "0") return;
                e.setAttribute("data-kv-vis", "1");
            });
            if (Array.from(document.querySelectorAll('[class*="CircleDetails_stickyFooter"], [class*="CircleDetails_circlePlanWrapper"]')).some((e) => e.hasAttribute("data-kv-vis"))) return true;
            const btns = Array.from(document.querySelectorAll("button, [role='button']")).filter((e) => e.hasAttribute("data-kv-vis")) as HTMLElement[];
            if (btns.some((b) => /^\s*skip\s*savings\s*$/i.test(b.innerText || ""))) return true;
            if (btns.some((b) => /^\s*add\s*plan\s*$/i.test(b.innerText || ""))) return true;
            // Generic membership/offer dialog with a decline button
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="Dialog"], [class*="sheet" i]')).filter((e) => e.hasAttribute("data-kv-vis")) as HTMLElement[];
            return dialogs.some((d) => {
                const t = (d.innerText || "").toLowerCase();
                if (/double-check the details|choose from saved address|add new address|search for society/.test(t)) return false;
                return (
                    /(circle|membership|choose a plan|join now|subscribe)/.test(t) &&
                    Array.from(d.querySelectorAll("button, [role='button']")).some((b) =>
                        /^\s*(skip(\s*savings)?|no,?\s*thanks|not\s*now|maybe\s*later|continue\s*without[a-z ]*)\s*$/i.test((b as HTMLElement).innerText || ""),
                    )
                );
            });
        })
        .catch(() => false);
}

/** Press "Skip Savings" (or a plain decline), else the drawer's X, else Escape. Never "Add Plan" / radios. */
export async function dismissUpsell(page: Page): Promise<"skip" | "close" | "escape"> {
    const how = await page
        .evaluate(() => {
            document.querySelectorAll("[data-kavach-upsell]").forEach((e) => e.removeAttribute("data-kavach-upsell"));
            // on-screen only (a closed drawer may sit translated off-canvas with a real size).
            // (no named helpers inside evaluate: tsx/esbuild would inject __name() into the page)
            document.querySelectorAll("[data-kv-vis]").forEach((e) => e.removeAttribute("data-kv-vis"));
            Array.from(document.querySelectorAll('button, [role="button"], [role="dialog"], [class*="modal" i], [class*="drawer" i], [class*="Dialog"], [class*="sheet" i], [class*="CircleDetails_"], [aria-label], i, span, svg')).forEach((e) => {
                const r = (e as HTMLElement).getBoundingClientRect();
                if (!(r.width > 0 && r.height > 0)) return;
                if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) return;
                const cs = getComputedStyle(e as HTMLElement);
                if (cs.visibility === "hidden" || cs.opacity === "0") return;
                e.setAttribute("data-kv-vis", "1");
            });
            const btns = Array.from(document.querySelectorAll("button, [role='button']")).filter((e) => e.hasAttribute("data-kv-vis")) as HTMLElement[];
            const skip =
                btns.find((b) => /^\s*skip\s*savings\s*$/i.test(b.innerText || "")) ||
                btns.find((b) => {
                    const t = b.innerText || "";
                    if (!/^\s*(skip|no,?\s*thanks|not\s*now|maybe\s*later|continue\s*without[a-z ]*)\s*$/i.test(t)) return false;
                    let el: HTMLElement | null = b;
                    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
                        if (/circle|membership|choose a plan/i.test((el.innerText || "").slice(0, 3000)) && el !== document.body) return true;
                    }
                    return false;
                });
            if (skip && !/add\s*plan|add\s*to\s*cart/i.test(skip.innerText || "")) {
                skip.setAttribute("data-kavach-upsell", "skip");
                return "skip";
            }
            // Drawer root: climb from the plan block / Add Plan button to a fixed-position container.
            const anchor =
                (document.querySelector('[class*="CircleDetails_stickyFooter"], [class*="CircleDetails_circlePlanWrapper"]') as HTMLElement | null) ||
                btns.find((b) => /^\s*add\s*plan\s*$/i.test(b.innerText || "")) ||
                null;
            let root: HTMLElement | null = anchor;
            while (root && root !== document.body) {
                const cs = getComputedStyle(root);
                if (cs.position === "fixed" || root.getAttribute("role") === "dialog" || /drawer|modal|Dialog|sheet/i.test(root.className || "")) break;
                root = root.parentElement;
            }
            const scope = root && root !== document.body ? root : document;
            const cands = (Array.from(scope.querySelectorAll("button, [role='button'], [aria-label], i, span, svg")) as HTMLElement[]).filter((e) => {
                if (!e.hasAttribute("data-kv-vis")) return false;
                const lbl = `${e.getAttribute("aria-label") || ""} ${typeof e.className === "string" ? e.className : (e.getAttribute("class") || "")} ${(e.innerText || e.textContent || "").trim()}`;
                if (/add\s*plan|add\s*to\s*cart|radio/i.test(lbl)) return false;
                return /close|dismiss|cross|icon-ic_cross|^\s*[×✕✖xX]\s*$/i.test(lbl) || /^\s*[×✕✖]\s*$/.test(e.innerText || "");
            });
            if (cands.length) {
                // top-most, then right-most
                cands.sort((a, b) => {
                    const ra = a.getBoundingClientRect();
                    const rb = b.getBoundingClientRect();
                    return ra.top - rb.top || rb.right - ra.right;
                });
                cands[0]!.setAttribute("data-kavach-upsell", "close");
                return "close";
            }
            return "escape";
        })
        .catch(() => "escape" as const);
    if (how === "escape") {
        await page.keyboard.press("Escape").catch(() => undefined);
        return "escape";
    }
    const el = page.locator(`[data-kavach-upsell="${how}"]`).first();
    await el.click({ timeout: 3000 }).catch(async () => {
        await el.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
    });
    return how;
}

/** Circle / membership / plan text on a checkout line or the payment summary. */
export const MEMBERSHIP_LINE_RE = /circle\s*(?:membership|plan|subscription)|\bmembership\b|\b(?:3|6|12)\s*months?\s*plan\b|\bcircle\b.{0,30}₹\s*(?:99|149|199)\b/i;

/**
 * Payment-page gate: a membership/plan with a price in the order summary. Price-anchored so
 * the global nav link "Circle Membership" or a price-less banner doesn't trip it.
 */
export const MEMBERSHIP_PRICED_RE =
    /(?:circle\s*(?:membership|plan|subscription)|\bmembership\b|\b(?:3|6|12)\s*months?\s*(?:circle\s*)?plan\b)[^₹]{0,40}₹\s*\d+|₹\s*\d+(?:\.\d+)?[^₹]{0,25}(?:circle\s*(?:membership|plan)|\bmembership\b)/i;

/** Payment page text without the global header / nav (which always shows "Circle Membership"). */
async function paymentSummaryText(page: Page): Promise<string> {
    const t = await page
        .evaluate(() => {
            const clone = document.body.cloneNode(true) as HTMLElement;
            clone
                .querySelectorAll('header, nav, footer, [class*="header" i], [class*="navbar" i], [class*="navigation" i], script, style, noscript')
                .forEach((e) => e.remove());
            return clone.textContent || "";
        })
        .catch(() => "");
    return t
        .replace(/\s+/g, " ")
        .replace(/buy medicines\s*find doctors\s*lab tests\s*circle membership\s*health records/gi, " ")
        .slice(0, 20000);
}

export async function detectCheckoutStage(page: Page): Promise<CheckoutStage> {
    const url = safeUrl(page);
    if (/\/order-status\//i.test(url)) {
        const t = (await bodyText(page, 4000)).toLowerCase();
        if (/order id\(s\)|order placed|order confirmed|order successful|placed successfully/.test(t) || /\/success\b/i.test(url)) {
            return "success";
        }
        if (/fail|abort|cancel/.test(url.toLowerCase()) || /payment failed|order failed|transaction failed/.test(t)) {
            return "order_failed";
        }
        return "success";
    }
    if (await loginPopupVisible(page)) return "login";
    if (await upsellOpen(page)) return "upsell";
    if (/\/pay\//i.test(url)) return "payment";
    if (/prescription-review/i.test(url)) return "rx_review";
    if (/\/address-details/i.test(url)) return "address";
    if (await addressReviewPopupOpen(page)) return "address_review";
    if ((await deliverToSheetOpen(page)) || (await addressPickerVisible(page))) return "address";
    if (/\/delivery-options/i.test(url)) return "delivery_options";
    if (/\/medicines-cart/i.test(url)) return "cart";
    return "unknown";
}

/** Address evidence on the current page: full (pincode + street hint), pincode only, none. */
async function addressEvidence(
    page: Page,
    pincode?: string,
    hints: string[] = [],
): Promise<"full" | "pincode" | "none"> {
    if (!pincode) return "none";
    const raw = await bodyText(page, 12000);
    return addressEvidenceFromText(raw, pincode, hints);
}

/**
 * Pure: strip Apollo's global header — "Deliver to <name> <city> <pin>" (signed in) or
 * "Delivery Address / Select Address | <city> <pin>" (guest) — which is only the BROWSE
 * location, then look for the pincode (+ street hint) in the page body only.
 */
export function addressEvidenceFromText(raw: string, pincode: string, hints: string[] = []): "full" | "pincode" | "none" {
    let text = raw.replace(/\s+/g, " ").trim();
    text = text.replace(/^\s*deliver(?:y)?\s*(?:to|address)\b(?:\s*select\s*address)?\s*[^0-9]{0,60}?\b\d{6}\b/i, " ");
    text = text.replace(/^\s*delivery\s*address\s*select\s*address\b/i, " ");
    const idx = text.search(/your\s*cart|choose\s*delivery\s*type|amount\s*to\s*pay|deliver(?:y|ing)?\s*to|shipping\s*address|payment\s*options/i);
    const body = idx > 0 ? text.slice(idx) : text;
    const lowerBody = body.toLowerCase();
    const pinInBody = new RegExp(`\\b${pincode}\\b`).test(body);
    const hintHit = hints.some((h) => h && lowerBody.includes(h.toLowerCase()));
    if (pinInBody && hintHit) return "full";
    if (pinInBody) return "pincode";
    return "none";
}

async function clickProceed(page: Page): Promise<string | null> {
    const cands = [
        page.locator('button[title="Proceed" i]'),
        page.locator("button").filter({ hasText: /^\s*proceed(\s*to\s*checkout)?\s*$/i }),
        page.locator('[role="button"]').filter({ hasText: /^\s*proceed\s*$/i }),
    ];
    for (const loc of cands) {
        const n = Math.min(await loc.count().catch(() => 0), 4);
        for (let i = 0; i < n; i++) {
            const el = loc.nth(i);
            if (!(await el.isVisible().catch(() => false))) continue;
            if (await el.isDisabled().catch(() => false)) continue;
            const label = ((await el.innerText({ timeout: 800 }).catch(() => "")) || "Proceed").trim();
            if (PAY_BLOCK_RE.test(label)) continue;
            await el.click({ timeout: 4000 }).catch(() => undefined);
            return label;
        }
    }
    return null;
}

type CodState =
    | { kind: "absent" }
    | { kind: "disabled"; reason: string }
    | { kind: "ready"; checked: boolean; ctaText?: string; ctaDisabled?: boolean; payable?: number };

async function readCodState(page: Page): Promise<CodState> {
    return page
        .evaluate(() => {
            const radio = document.getElementById("checkbox-cod") as HTMLInputElement | null;
            let container: HTMLElement | null = null;
            if (radio) {
                let el: HTMLElement | null = radio;
                while (el && !/codContainer/i.test(el.className || "")) el = el.parentElement;
                container = el;
            }
            if (!container) {
                container = Array.from(document.querySelectorAll('[class*="codContainer" i]'))[0] as HTMLElement | undefined || null;
            }
            if (!radio && !container) return { kind: "absent" as const };
            const card = (container?.querySelector('[class*="codCard" i]') as HTMLElement | null) || container;
            const disabled =
                Boolean(radio?.disabled) || card?.getAttribute("aria-disabled") === "true";
            const sub = (container?.querySelector('[class*="codSubtitle" i]') as HTMLElement | null)?.innerText?.trim() || "";
            if (disabled) return { kind: "disabled" as const, reason: sub || "Cash on Delivery is disabled for this order" };
            const btn = Array.from(container?.querySelectorAll("button") || []).find((b) =>
                /^\s*place\s*order\s*for\b/i.test((b as HTMLElement).innerText || "") ||
                /^pay rupees\s*\d/i.test(b.getAttribute("aria-label") || ""),
            ) as HTMLButtonElement | undefined;
            const ctaText = btn?.innerText?.replace(/\s+/g, " ").trim();
            const aria = btn?.getAttribute("aria-label") || "";
            const m =
                aria.replace(/,/g, "").match(/pay rupees\s*(\d+(?:\.\d{1,2})?)/i) ||
                ctaText?.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)\s*$/);
            return {
                kind: "ready" as const,
                checked: Boolean(radio?.checked),
                ctaText,
                ctaDisabled: btn ? btn.disabled || /disabled/i.test(btn.className || "") : undefined,
                payable: m ? Number(m[1]) : undefined,
            };
        })
        .catch(() => ({ kind: "absent" as const }));
}

/**
 * Apollo /pay/<id> (payments-fe, Juspay) desktop layout: a left "Payment methods" nav
 * (nav[aria-label="Payment methods"] > ul.Juspay_desktopNavList > li > button.Juspay_desktopNavItem*,
 * title in .Juspay_desktopNavTitle, subtitle in .Juspay_desktopNavSubtitle). UPI is selected by
 * default; the middle panel renders ONLY the selected method, so the COD card (#checkbox-cod /
 * .COD_codContainer / "Place order for ₹X") doesn't exist until the "Pay on Delivery" tab is
 * clicked. Clicks only that tab — never UPI / cards / pay later / wallets / net banking / QR.
 */
async function selectCodNavTab(page: Page): Promise<{ kind: "clicked" | "active" | "absent" } | { kind: "disabled"; reason: string }> {
    const r = await page
        .evaluate(() => {
            document.querySelectorAll("[data-kavach-codtab]").forEach((e) => e.removeAttribute("data-kavach-codtab"));
            const nav =
                (document.querySelector('nav[aria-label="Payment methods" i]') as HTMLElement | null) ||
                (document.querySelector('[class*="desktopNavList"]') as HTMLElement | null) ||
                (document.querySelector('[class*="desktopNav"]') as HTMLElement | null);
            if (!nav) return { kind: "absent" as const };
            const btns = Array.from(nav.querySelectorAll("button")) as HTMLButtonElement[];
            const cod = btns.find((b) => {
                const title = ((b.querySelector('[class*="desktopNavTitle"]') as HTMLElement | null)?.innerText || "").trim();
                const all = (b.innerText || "").replace(/\s+/g, " ").trim();
                return /^pay\s*on\s*delivery\b|^cash\s*on\s*delivery\b|^cod\b/i.test(title) || /^(pay\s*on\s*delivery|cash\s*on\s*delivery)\b/i.test(all);
            });
            if (!cod) return { kind: "absent" as const };
            const sub = ((cod.querySelector('[class*="desktopNavSubtitle"]') as HTMLElement | null)?.innerText || "").trim();
            if (cod.disabled || cod.getAttribute("aria-disabled") === "true" || /desktopNavItemDisabled/.test(cod.className || "")) {
                return { kind: "disabled" as const, reason: sub || "Apollo disabled Pay on Delivery for this order" };
            }
            if (/desktopNavItemActive/.test(cod.className || "")) return { kind: "active" as const };
            cod.setAttribute("data-kavach-codtab", "1");
            return { kind: "clicked" as const };
        })
        .catch(() => ({ kind: "absent" as const }));
    if (r.kind !== "clicked") return r;
    const tab = page.locator('[data-kavach-codtab="1"]').first();
    await tab.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => undefined);
    await tab.click({ timeout: 3000 }).catch(async () => {
        await tab.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
    });
    return r;
}

/** "To Pay ₹X" from the /pay summary (right column). */
async function readToPay(page: Page): Promise<number | undefined> {
    const t = (await bodyText(page, 12000)).replace(/\s+/g, " ").replace(/,/g, "");
    const m = t.match(/\bto\s*pay\s*₹\s*(\d+(?:\.\d{1,2})?)/i);
    return m ? Number(m[1]) : undefined;
}

async function selectCod(page: Page): Promise<boolean> {
    // Click the COD card header (role=button), fall back to the radio itself.
    const clicked = await page
        .evaluate(() => {
            const radio = document.getElementById("checkbox-cod") as HTMLInputElement | null;
            // Apollo: .COD_codCardHeader[role=button] contains the radio (onClick → select COD:default)
            let header = (radio?.closest('[role="button"]') as HTMLElement | null) || null;
            if (!header) {
                let el: HTMLElement | null = radio;
                while (el && !/codCard/i.test(el.className || "")) el = el.parentElement;
                header = (el?.querySelector('[role="button"]') as HTMLElement | null) || null;
            }
            if (header) {
                header.scrollIntoView({ block: "center" });
                header.click();
                return "header";
            }
            if (radio) {
                radio.scrollIntoView({ block: "center" });
                radio.click();
                return "radio";
            }
            return null;
        })
        .catch(() => null);
    if (!clicked) {
        const loc = page.locator("#checkbox-cod");
        if (await loc.count().catch(() => 0)) {
            await loc.first().check({ timeout: 3000, force: true }).catch(() => undefined);
        }
    }
    await sleep(page, 1000);
    const st = await readCodState(page);
    return st.kind === "ready" && st.checked;
}

async function readCheckoutSession(page: Page): Promise<{
    orderIds?: string;
    grandTotal?: number;
    netAmountPaid?: number;
    transactionId?: string;
    isCodEligible?: string | null;
    codMessage?: string | null;
}> {
    return page
        .evaluate(() => {
            let v: Record<string, unknown> = {};
            try {
                v = JSON.parse(sessionStorage.getItem("pharmacyCheckoutValues") || "{}") || {};
            } catch {
                v = {};
            }
            return {
                orderIds: typeof v.orderIds === "string" ? v.orderIds : undefined,
                grandTotal: typeof v.grandTotal === "number" ? v.grandTotal : undefined,
                netAmountPaid: typeof v.netAmountPaid === "number" ? v.netAmountPaid : undefined,
                transactionId: v.transactionId != null ? String(v.transactionId) : undefined,
                isCodEligible: sessionStorage.getItem("isCodEligible"),
                codMessage: sessionStorage.getItem("codMessage"),
            };
        })
        .catch(() => ({}));
}

export function parseOrderSuccess(text: string, url: string): { orderIds?: string; totalLabel?: string; transactionId?: string } {
    const ids = text.match(/order\s*id\(?s?\)?\s*[:#-]?\s*([0-9A-Z][0-9A-Z,\s-]{3,60})/i)?.[1];
    const orderIds = ids
        ?.split(/[\s,]+/)
        .filter((t) => /\d{4,}/.test(t))
        .join(", ");
    const total =
        text.match(/(amount\s*(?:to\s*be\s*)?(?:paid|payable|to\s*pay)|total\s*(?:amount|bill|payable)?|cash\s*to\s*collect)[^₹\d]{0,30}₹?\s*([\d,]+(?:\.\d{1,2})?)/i)?.[2];
    const txn = url.match(/\/order-status\/([^/?#]+)/i)?.[1];
    return {
        orderIds: orderIds || undefined,
        totalLabel: total ? `₹${total}` : undefined,
        transactionId: txn,
    };
}

/**
 * Bounded Gemini navigation step: may only move through cart/address/delivery screens.
 * Every click is resolved to its on-page text and blocked if it looks like payment /
 * place order / destructive. Typing is never allowed.
 */
async function geminiNavigateStep(
    page: Page,
    opts: { stage: CheckoutStage; pincode?: string; hints: string[]; step: number; maxSteps: number; log?: ApolloCheckoutOptions["log"] },
): Promise<number> {
    if (
        opts.stage === "payment" ||
        opts.stage === "success" ||
        opts.stage === "login" ||
        opts.stage === "address" ||
        opts.stage === "address_review"
    ) {
        return 0;
    }
    let executed = 0;
    try {
        const screenshot = await page.screenshot({ type: "png", fullPage: false, timeout: 8_000 });
        const accessibilityHint = await page
            .evaluate(() =>
                Array.from(document.querySelectorAll("h1,h2,button,a,[role=button]"))
                    .slice(0, 40)
                    .map((n) => (n.textContent || "").trim().slice(0, 60))
                    .filter(Boolean)
                    .join(" | ")
                    .slice(0, 800),
            )
            .catch(() => "");
        const planned = await Promise.race([
            planBrowserActions({
                screenshotBase64: screenshot.toString("base64"),
                mimeType: "image/png",
                url: safeUrl(page),
                title: await page.title().catch(() => ""),
                accessibilityHint,
                goal:
                    `Apollo checkout navigation ONLY: get from the cart to the payment options page. ` +
                    `The delivery address is already handled by code. Click Proceed / Continue only.`,
                playbookHint:
                    "NEVER choose a payment method, NEVER click Pay / Place order / UPI / Card / Wallet / Cash on Delivery, " +
                    "NEVER type, NEVER log out, NEVER remove items or add a new address. Already signed in.",
                step: opts.step,
                maxSteps: opts.maxSteps,
                otpProvided: true,
                userConfirmed: false,
            } as Parameters<typeof planBrowserActions>[0]),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (!planned) {
            opts.log?.("gemini_timeout", {});
            return 0;
        }
        for (const action of planned.actions.slice(0, 3)) {
            if (action.type === "scroll") {
                await page.mouse.wheel(0, action.direction === "up" ? -600 : 600).catch(() => undefined);
                executed++;
                continue;
            }
            if (action.type === "wait") {
                await sleep(page, Math.min(action.ms ?? 800, 3000));
                continue;
            }
            if (action.type !== "click") continue; // no typing / goto / press / done / confirm
            const targetText = await describeClickTarget(page, action);
            if (PAY_BLOCK_RE.test(targetText) || CART_REMOVE_BLOCK_RE.test(targetText) || UPSELL_BLOCK_RE.test(targetText) || (await upsellOpen(page))) {
                opts.log?.("gemini_click_blocked", { text: targetText.slice(0, 120) });
                continue;
            }
            if (!action.selector && typeof action.x === "number" && typeof action.y === "number") {
                const vp = page.viewportSize() || { width: 1280, height: 720 };
                await page.mouse
                    .click(Math.round((action.x / 1000) * vp.width), Math.round((action.y / 1000) * vp.height))
                    .catch(() => undefined);
                executed++;
                await sleep(page, 1500);
                continue;
            }
            if (!action.selector) continue;
            await page.locator(action.selector).first().click({ timeout: 5000 }).catch(() => undefined);
            executed++;
            await sleep(page, 1500);
        }
    } catch (err) {
        opts.log?.("gemini_error", { msg: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
    return executed;
}

/**
 * Re-read the cart from a fresh tab of the SAME signed-in context (the /pay page doesn't
 * list line items). Read-only: opens /medicines-cart, reads the line cards, closes the tab.
 */
export async function verifyCartInFreshTab(
    page: Page,
    skuName: string,
    deadlineAt: number,
): Promise<ExactCartCheck & { read: boolean }> {
    let tab: Page | null = null;
    try {
        tab = await page.context().newPage();
        await tab
            .goto(APOLLO_CART_URL, {
                waitUntil: "domcontentloaded",
                timeout: Math.max(2_000, Math.min(20_000, remaining(deadlineAt) - 6_000)),
            })
            .catch(() => undefined);
        const snap = await waitForCartSnapshot(tab, Math.min(deadlineAt - 5_000, Date.now() + 14_000));
        const chk = checkCartExactlySku(snap, skuName);
        return { ...chk, read: snap.state !== "unknown" };
    } catch (err) {
        return { ok: false, reason: `couldn't open the cart (${err instanceof Error ? err.message.slice(0, 60) : "error"})`, lines: [], read: false };
    } finally {
        await tab?.close().catch(() => undefined);
    }
}

/**
 * Drive checkout from wherever the parked page currently is (cart / delivery options /
 * payment) to a placed COD order. Resumable: an "amount_changed" stop leaves the page
 * on /pay so the next confirm continues from there.
 */
export async function runApolloCodCheckout(page: Page, opts: ApolloCheckoutOptions): Promise<ApolloCheckoutOutcome> {
    const log = opts.log ?? (() => undefined);
    const hints = opts.addressHints ?? [];
    const progress = async (d: string) => {
        try {
            await opts.progress?.(d);
        } catch {
            /* ignore */
        }
    };
    const said = new Set<string>();
    const sayOnce = async (key: string, d: string) => {
        if (said.has(key)) return;
        said.add(key);
        await progress(d);
    };

    let addressVerified: "full" | "pincode" | "none" = opts.priorAddressVerified ?? "none";
    let addressEnsured = false;
    let addressRuns = 0;
    const MAX_ADDRESS_RUNS = 3;
    let reviewChanges = 0;
    let upsellSkips = 0;
    let proceedAfterUpsell = false;
    let reviewHandled = 0;
    const target: AddressTarget | null =
        opts.addressTarget ??
        (opts.pincode
            ? {
                  label: [...hints, opts.pincode].join(", "),
                  pincode: opts.pincode,
                  flat: hints[0],
                  society: hints[1],
                  line1: hints.join(", "),
                  hints,
                  searchQueries: [opts.pincode],
              }
            : null);
    /** Deterministic select-or-add of the delivery address (cart / drawer / address form). */
    const ensureAddress = async (): Promise<ApolloCheckoutOutcome | null> => {
        if (!target) return null;
        addressRuns++;
        await sayOnce("addr", `checking the delivery address (${target.pincode}) on Apollo…`);
        const r = await ensureApolloDeliveryAddress(page, target, {
            deadlineAt: opts.deadlineAt,
            recipientName: opts.recipientName,
            accountPhone: opts.accountPhone,
            progress,
            log,
        });
        log("address_ensure", r.ok ? { how: r.how, text: r.addressText.slice(0, 120) } : { step: r.step, reason: r.reason });
        if (!r.ok) {
            return {
                status: "address_unverified",
                url: safeUrl(page),
                detail: `${r.reason} [step: ${r.step}]`,
            };
        }
        addressEnsured = true;
        if (r.evidence === "full") {
            addressVerified = "full";
            if (r.how !== "added_new") await sayOnce("addr_ok", `delivery address ${target.line1}, ${target.pincode} ✓`);
        } else {
            // Selected on Apollo but the cart doesn't print it: verified on the next screen, or we stop.
            if (r.how === "selected_saved") await sayOnce("addr_sel", `selected your saved Apollo address ${target.line1}, ${target.pincode} — confirming it on the next screen…`);
            else if (r.how === "cart_proceed") await sayOnce("addr_pending", `Apollo already has a delivery address selected — I'll check it's ${target.line1}, ${target.pincode} before payment…`);
        }
        stageSince = Date.now();
        return null;
    };
    let proceedClicks = 0;
    let geminiSteps = 0;
    const geminiMax = opts.geminiMaxSteps ?? 3;
    let lastStage: CheckoutStage | null = null;
    let stageSince = Date.now();
    let codSelectTries = 0;
    let codTabTries = 0;
    let preplaceVerifiedAt = 0;

    let stage = await detectCheckoutStage(page);
    if (stage === "unknown" || stage === "address") {
        if (stage === "unknown") {
            await page
                .goto(`${BASE}/medicines-cart`, { waitUntil: "domcontentloaded", timeout: Math.max(1_000, Math.min(25_000, remaining(opts.deadlineAt) - 5_000)) })
                .catch(() => undefined);
            await sleep(page, 2500);
        }
    } else if (stage === "cart") {
        // Reload so the cart reflects server state after the idle wait.
        await page
            .goto(`${BASE}/medicines-cart`, { waitUntil: "domcontentloaded", timeout: Math.max(1_000, Math.min(25_000, remaining(opts.deadlineAt) - 5_000)) })
            .catch(() => undefined);
        await sleep(page, 2500);
    }
    await sayOnce("cart", "placing order… opening your Apollo cart");

    while (remaining(opts.deadlineAt) > 4_000) {
        if (opts.isCancelled?.()) return { status: "cancelled", url: safeUrl(page), detail: "cancelled" };
        stage = await detectCheckoutStage(page);
        if (stage !== lastStage) {
            log("stage", { stage, url: safeUrl(page), msLeft: remaining(opts.deadlineAt) });
            lastStage = stage;
            stageSince = Date.now();
        }
        const stuckMs = Date.now() - stageSince;

        switch (stage) {
            case "login":
                return {
                    status: "session_expired",
                    url: safeUrl(page),
                    detail: "Apollo asked to log in again (session expired)",
                };
            case "rx_review":
                return {
                    status: "rx_required",
                    url: safeUrl(page),
                    detail: "Apollo wants a prescription review for this cart",
                };
            case "success": {
                const text = await bodyText(page, 6000);
                const parsed = parseOrderSuccess(text, safeUrl(page));
                const ss = await readCheckoutSession(page);
                const totalLabel =
                    parsed.totalLabel ||
                    (typeof ss.netAmountPaid === "number" && ss.netAmountPaid > 0
                        ? `₹${ss.netAmountPaid}`
                        : typeof ss.grandTotal === "number"
                          ? `₹${ss.grandTotal}`
                          : undefined);
                return {
                    status: "placed",
                    orderIds: parsed.orderIds || ss.orderIds || undefined,
                    totalLabel,
                    transactionId: ss.transactionId || parsed.transactionId,
                    addressVerified,
                    url: safeUrl(page),
                    detail: text.replace(/\s+/g, " ").slice(0, 300),
                };
            }
            case "order_failed": {
                const text = await bodyText(page, 3000);
                return { status: "order_failed", url: safeUrl(page), detail: text.replace(/\s+/g, " ").slice(0, 200) };
            }
            case "address": {
                // Apollo's Deliver-to drawer or /address-details form.
                if (target && !addressEnsured && addressRuns < MAX_ADDRESS_RUNS) {
                    const stop = await ensureAddress();
                    if (stop) return stop;
                    continue;
                }
                if (addressRuns >= MAX_ADDRESS_RUNS && !addressEnsured) {
                    return { status: "address_unverified", url: safeUrl(page), detail: "couldn't set the delivery address on Apollo" };
                }
                // Address already ensured but a picker is open again → close it, back to the cart.
                await page.keyboard.press("Escape").catch(() => undefined);
                await sleep(page, 800);
                if ((await detectCheckoutStage(page)) === "address") {
                    await page
                        .goto(`${BASE}/medicines-cart`, { waitUntil: "domcontentloaded", timeout: Math.max(1_000, Math.min(20_000, remaining(opts.deadlineAt) - 5_000)) })
                        .catch(() => undefined);
                    await sleep(page, 1500);
                }
                continue;
            }
            case "upsell": {
                if (upsellSkips >= 5) {
                    return { status: "stuck", stage, url: safeUrl(page), detail: "Apollo's Circle membership offer kept coming back (not added)" };
                }
                upsellSkips++;
                const how = await dismissUpsell(page);
                log("upsell_dismiss", { how, n: upsellSkips });
                await sayOnce("upsell", "skipped Apollo's Circle membership offer (not added) — continuing…");
                await sleep(page, 1800);
                proceedAfterUpsell = true;
                stageSince = Date.now();
                continue;
            }
            case "address_review": {
                if (!target) {
                    return { status: "address_unverified", url: safeUrl(page), detail: "Apollo asked to confirm a delivery address but none was given" };
                }
                if (reviewHandled >= 3) {
                    return { status: "stuck", stage, url: safeUrl(page), detail: "Apollo's delivery-address popup kept coming back" };
                }
                reviewHandled++;
                const r = await handleAddressReviewPopup(page, target, {
                    recipientName: opts.recipientName,
                    accountPhone: opts.accountPhone,
                    log,
                });
                log("address_review_result", { ok: r.ok, reason: r.ok ? undefined : r.reason });
                if (!r.ok && r.mismatch && reviewChanges < 1 && addressRuns < MAX_ADDRESS_RUNS && remaining(opts.deadlineAt) > 30_000) {
                    // Apollo pre-selected another saved address (the cart doesn't print it) → use the
                    // popup's own "Change Address" → Deliver-to drawer → select / add the target.
                    reviewChanges++;
                    reviewHandled--;
                    await sayOnce("addr_change", `Apollo had a different delivery address selected — switching to ${target.line1}, ${target.pincode}…`);
                    if (await clickReviewChangeAddress(page, Math.min(opts.deadlineAt - 3_000, Date.now() + 8_000))) {
                        addressEnsured = false;
                        addressVerified = "none";
                        stageSince = Date.now();
                        continue;
                    }
                    return { status: "address_unverified", url: safeUrl(page), detail: `${r.reason}; Apollo's Change Address didn't open the address picker` };
                }
                if (!r.ok) return { status: "address_unverified", url: safeUrl(page), detail: r.reason };
                addressVerified = "full";
                await sayOnce("review", `Apollo confirmed delivery to ${target.line1}, ${target.pincode} ✓ — continuing…`);
                stageSince = Date.now();
                await sleep(page, 2500);
                continue;
            }
            case "cart": {
                if (target && !addressEnsured) {
                    if (addressRuns >= MAX_ADDRESS_RUNS) {
                        return { status: "address_unverified", url: safeUrl(page), detail: "couldn't set the delivery address on Apollo" };
                    }
                    const stop = await ensureAddress();
                    if (stop) return stop;
                    continue;
                }
                if (proceedClicks < 5 && (proceedClicks === 0 || stuckMs > 6_000 || (proceedAfterUpsell && stuckMs > 1_200))) {
                    proceedAfterUpsell = false;
                    if (opts.skuName) {
                        // Hard guard: exactly the confirmed product ×1 before Proceed (Proceed →
                        // delivery options → order creation uses whatever is in this cart).
                        const snap = await waitForCartSnapshot(page, Math.min(opts.deadlineAt - 4_000, Date.now() + 5_000));
                        if (snap.state === "unknown") {
                            if (stuckMs > 15_000) {
                                return { status: "stuck", stage, url: safeUrl(page), detail: "couldn't read the cart before checkout" };
                            }
                            await sleep(page, 800);
                            continue;
                        }
                        const chk = checkCartExactlySku(snap, opts.skuName);
                        log("cart_exact_guard", { at: "cart", ok: chk.ok, reason: chk.ok ? undefined : chk.reason });
                        if (!chk.ok) {
                            return {
                                status: "cart_mismatch",
                                url: safeUrl(page),
                                detail: `${chk.reason}${chk.lines.length ? ` (${describeCartLines(chk.lines)})` : ""}`,
                            };
                        }
                    }
                    const clicked = await clickProceed(page);
                    if (clicked) {
                        proceedClicks++;
                        stageSince = Date.now();
                        await sayOnce("proceed", "proceeding to checkout…");
                        await sleep(page, 2500);
                        continue;
                    }
                }
                break;
            }
            case "delivery_options": {
                const ev = await addressEvidence(page, opts.pincode, hints);
                if (ev === "full" || (ev === "pincode" && addressVerified !== "full")) addressVerified = ev;
                if (opts.pincode && addressVerified === "none") {
                    return {
                        status: "address_unverified",
                        url: safeUrl(page),
                        detail: `Apollo's checkout didn't show delivery pincode ${opts.pincode}`,
                    };
                }
                log("address_evidence", { at: "delivery_options", addressVerified });
                if (proceedClicks < 5 && stuckMs > 1_500) {
                    const clicked = await clickProceed(page);
                    if (clicked) {
                        proceedClicks++;
                        stageSince = Date.now();
                        await sayOnce("to_pay", `address ${opts.pincode || ""} ✓ — opening payment options…`.replace("  ", " "));
                        await sleep(page, 3000);
                        continue;
                    }
                }
                break;
            }
            case "payment": {
                if (opts.pincode && addressVerified === "none") {
                    // Resumed on /pay (e.g. after an amount re-confirm): the address was checked
                    // before /pay was reached; re-read only for the report.
                    addressVerified = await addressEvidence(page, opts.pincode, hints);
                    if (addressVerified === "none") {
                        return {
                            status: "address_unverified",
                            url: safeUrl(page),
                            detail: `couldn't confirm delivery pincode ${opts.pincode} before payment`,
                        };
                    }
                }
                await sayOnce("cod", "selecting Cash on Delivery…");
                const ss = await readCheckoutSession(page);
                if (ss.isCodEligible === "false") {
                    return {
                        status: "cod_unavailable",
                        url: safeUrl(page),
                        detail: (ss.codMessage && ss.codMessage !== "undefined" && ss.codMessage !== "null" ? ss.codMessage : "") ||
                            "Apollo says this order isn't eligible for Cash on Delivery",
                    };
                }
                let cod = await readCodState(page);
                if (cod.kind === "absent" && codTabTries < 3) {
                    // Tabbed /pay/<id> layout: open the "Pay on Delivery" tab first.
                    const tab = await selectCodNavTab(page);
                    log("cod_tab", { ...tab, try: codTabTries + 1 });
                    if (tab.kind === "disabled") return { status: "cod_unavailable", url: safeUrl(page), detail: tab.reason };
                    if (tab.kind === "clicked" || tab.kind === "active") {
                        codTabTries++;
                        const until = Math.min(opts.deadlineAt - 3_000, Date.now() + 6_000);
                        while (Date.now() < until && cod.kind === "absent") {
                            await sleep(page, 400);
                            cod = await readCodState(page);
                        }
                    }
                }
                if (cod.kind === "absent") {
                    await page.mouse.wheel(0, 900).catch(() => undefined);
                    await sleep(page, 900);
                    cod = await readCodState(page);
                }
                if (cod.kind === "absent") {
                    if (stuckMs > 20_000) {
                        return {
                            status: "cod_unavailable",
                            url: safeUrl(page),
                            detail: "Apollo's payment page didn't offer Pay on Delivery",
                        };
                    }
                    await sleep(page, 1000);
                    continue;
                }
                if (cod.kind === "disabled") {
                    return { status: "cod_unavailable", url: safeUrl(page), detail: cod.reason };
                }
                if (!cod.checked) {
                    if (codSelectTries >= 3) {
                        return { status: "stuck", stage, url: safeUrl(page), detail: "couldn't select Cash on Delivery" };
                    }
                    codSelectTries++;
                    await selectCod(page);
                    continue;
                }
                // COD selected: read the COD card's own CTA ("Place order for ₹X")
                const fresh = await readCodState(page);
                if (fresh.kind !== "ready" || !fresh.checked || !fresh.ctaText || fresh.ctaDisabled) {
                    if (stuckMs > 15_000) {
                        return {
                            status: "cod_unavailable",
                            url: safeUrl(page),
                            detail: "Cash on Delivery was selected but Apollo didn't enable its Place order button",
                        };
                    }
                    await sleep(page, 800);
                    continue;
                }
                // Hard guard right before Place order: the cart behind this checkout must be
                // exactly the confirmed product ×1 (checked before the amount, so a mixed cart
                // never turns into a "re-confirm the new amount" card).
                if (opts.skuName && Date.now() - preplaceVerifiedAt > 45_000) {
                    const chk = await verifyCartInFreshTab(page, opts.skuName, opts.deadlineAt);
                    log("cart_exact_guard", { at: "pre_place", ok: chk.ok, read: chk.read, reason: chk.ok ? undefined : chk.reason });
                    if (!chk.ok) {
                        if (!chk.read) {
                            return { status: "stuck", stage, url: safeUrl(page), detail: "couldn't re-check the cart right before Place order" };
                        }
                        return {
                            status: "cart_mismatch",
                            url: safeUrl(page),
                            detail: `${chk.reason}${chk.lines.length ? ` (${describeCartLines(chk.lines)})` : ""}`,
                        };
                    }
                    if (MEMBERSHIP_LINE_RE.test(chk.line.name)) {
                        return { status: "cart_mismatch", url: safeUrl(page), detail: `a Circle membership / plan is in the order (${chk.line.name.slice(0, 80)})` };
                    }
                    preplaceVerifiedAt = Date.now();
                }
                {
                    // Hard gate: no Circle / membership / plan anywhere in the payment summary.
                    const payText = await paymentSummaryText(page);
                    const hit = payText.match(MEMBERSHIP_PRICED_RE);
                    if (hit) {
                        log("membership_gate", { hit: hit[0] });
                        return { status: "cart_mismatch", url: safeUrl(page), detail: `Apollo's payment page lists "${hit[0]}" — I won't pay for a membership` };
                    }
                }
                const payable = fresh.payable;
                if (typeof opts.confirmedTotalRupees === "number" && typeof payable !== "number") {
                    return { status: "stuck", stage, url: safeUrl(page), detail: "couldn't read Apollo's payable amount before Place order" };
                }
                const toPay = await readToPay(page);
                log("pay_amounts", { cta: payable, toPay, card: opts.confirmedTotalRupees });
                if (typeof opts.confirmedTotalRupees === "number" && typeof toPay === "number" && toPay > opts.confirmedTotalRupees + 1) {
                    const lbl = `₹${toPay.toFixed(2).replace(/\.00$/, "")}`;
                    return {
                        status: "amount_changed",
                        payableLabel: lbl,
                        addressVerified,
                        url: safeUrl(page),
                        detail: `Apollo's "To Pay" is ${lbl}, the card said ₹${opts.confirmedTotalRupees}`,
                    };
                }
                const payableLabel = typeof payable === "number" ? `₹${payable.toFixed(2).replace(/\.00$/, "")}` : fresh.ctaText;
                if (
                    typeof opts.confirmedTotalRupees === "number" &&
                    typeof payable === "number" &&
                    payable > opts.confirmedTotalRupees + 1
                ) {
                    return {
                        status: "amount_changed",
                        payableLabel,
                        addressVerified,
                        url: safeUrl(page),
                        detail: `Apollo's payable amount is ${payableLabel}, the card said ₹${opts.confirmedTotalRupees}`,
                    };
                }
                if (opts.dryRun) {
                    return {
                        status: "dry_run_stop",
                        stage,
                        payableLabel,
                        url: safeUrl(page),
                        detail: `dry run: COD selected, would click "${fresh.ctaText}"`,
                    };
                }
                if (opts.mayPlace && !opts.mayPlace()) {
                    return { status: "stuck", stage, url: safeUrl(page), detail: "time budget used up before Place order" };
                }
                await progress(`placing the order — Cash on Delivery ${payableLabel}…`);
                const btn = page
                    .locator('[class*="codContainer" i] button')
                    .filter({ hasText: /^\s*place\s*order\s*for\b[^a-z]*[\d,]+(\.\d{1,2})?\s*$/i })
                    .first();
                if (!(await btn.isVisible().catch(() => false))) {
                    await sleep(page, 600);
                    continue;
                }
                opts.onPlaceClicked?.();
                log("place_click", { payable, url: safeUrl(page) });
                await btn.click({ timeout: 5000 }).catch((e) => log("place_click_error", { msg: String(e).slice(0, 120) }));
                // Wait for the order-status page (never click Place again).
                const until = Math.max(Date.now() + 5_000, opts.deadlineAt - 1_000);
                while (Date.now() < until) {
                    await sleep(page, 1000);
                    const st = await detectCheckoutStage(page);
                    if (st === "success" || st === "order_failed") break;
                }
                const after = await detectCheckoutStage(page);
                if (after === "success") {
                    const text = await bodyText(page, 6000);
                    const parsed = parseOrderSuccess(text, safeUrl(page));
                    const ss2 = await readCheckoutSession(page);
                    return {
                        status: "placed",
                        orderIds: parsed.orderIds || ss2.orderIds || undefined,
                        totalLabel: parsed.totalLabel || payableLabel,
                        transactionId: ss2.transactionId || parsed.transactionId,
                        addressVerified,
                        url: safeUrl(page),
                        detail: text.replace(/\s+/g, " ").slice(0, 300),
                    };
                }
                if (after === "order_failed") {
                    const text = await bodyText(page, 3000);
                    return { status: "order_failed", url: safeUrl(page), detail: text.replace(/\s+/g, " ").slice(0, 200) };
                }
                const ss3 = await readCheckoutSession(page);
                return {
                    status: "placed_unverified",
                    totalLabel: payableLabel,
                    url: safeUrl(page),
                    detail: `clicked Place order (COD)${ss3.orderIds ? `; Apollo order id(s) ${ss3.orderIds}` : ""} but no confirmation page yet`,
                };
            }
            default:
                break;
        }

        // Nothing deterministic worked for a while → bounded Gemini navigation (never payment).
        const stuckFor = Date.now() - stageSince;
        if (
            geminiMax > 0 &&
            geminiSteps < geminiMax &&
            stuckFor > 8_000 &&
            remaining(opts.deadlineAt) > 25_000 &&
            (stage === "cart" || stage === "delivery_options" || stage === "unknown")
        ) {
            geminiSteps++;
            log("gemini_fallback", { stage, step: geminiSteps });
            await sayOnce("gemini", "still working on the checkout screen…");
            // Self-healing step first (Stagehand observe → code guardrails → act), then the
            // older Gemini computer-use step. Neither can pay, pick COD, remove items or place.
            const goal =
                stage === "cart"
                    ? SITE_CONFIGS.apollo.goals.proceed_checkout
                    : stage === "delivery_options"
                      ? SITE_CONFIGS.apollo.goals.select_address
                      : SITE_CONFIGS.apollo.goals.reach_payment;
            const sh = await stagehandStep(page, { goal, log });
            log("stagehand_fallback", { stage, status: sh.status });
            if (sh.status === "acted") {
                stageSince = Date.now();
                continue;
            }
            const n = await geminiNavigateStep(page, { stage, pincode: opts.pincode, hints, step: geminiSteps, maxSteps: geminiMax, log });
            if (n > 0) stageSince = Date.now();
            continue;
        }
        if (stage === "unknown" && stuckFor > 10_000) {
            await page.goto(`${BASE}/medicines-cart`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
            stageSince = Date.now();
        }
        await sleep(page, 900);
    }
    return {
        status: "stuck",
        stage: lastStage ?? "unknown",
        url: safeUrl(page),
        detail: `checkout didn't finish in time (last screen: ${lastStage ?? "unknown"})`,
    };
}
