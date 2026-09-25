/**
 * Deterministic post-OTP steps on the SAME parked Playwright page (Apollo first):
 *   1. make sure the OTP was actually accepted (click Verify/Login if Apollo needs it)
 *   2. open the exact SKU product page, detect out-of-stock at the delivery pincode
 *   3. add 1 unit to cart and verify
 *   4. read the cart (total / address / COD) for an honest confirm-before-pay card
 *
 * Never clicks Send OTP / Resend / Pay / Place order. Everything is bounded by a
 * caller-supplied deadline so WhatsApp always gets an answer (never silent).
 */
import type { Page } from "playwright";

export type ExactSku = {
    name: string;
    pricePaise?: number;
    productUrl?: string;
    qty: number;
};

const OTP_FIELD_SELECTOR =
    'input[name^="digit"], input[id^="digit"], input[name*="otpDigit" i], input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[placeholder*="OTP" i]';

const VERIFY_BUTTON_RE =
    /^\s*(verify(\s*(otp|&\s*proceed|and\s*proceed|code))?|submit(\s*otp)?|log\s*in|login|sign\s*in|proceed|continue|confirm(\s*otp)?)\s*$/i;
const NEVER_CLICK_RE = /resend|re-send|send\s*otp|get\s*otp|request\s*otp|new\s*(otp|code)|pay|place\s*order|upi/i;

function remaining(deadlineAt: number): number {
    return deadlineAt - Date.now();
}

async function sleep(page: Page, ms: number): Promise<void> {
    await page.waitForTimeout(Math.max(0, ms)).catch(() => undefined);
}

export async function isOtpScreenVisible(page: Page): Promise<boolean> {
    const loc = page.locator(OTP_FIELD_SELECTOR);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 8); i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return true;
    }
    return false;
}

async function bodyText(page: Page, max = 4000): Promise<string> {
    return page
        .evaluate((m) => (document.body?.innerText || "").slice(0, m), max)
        .catch(() => "");
}

/** Click a visible Verify / Login / Submit style button (never Resend / Send OTP). */
export async function clickOtpVerifyButton(page: Page): Promise<string | null> {
    const candidates = page.locator('button, [role="button"], input[type="submit"]');
    const n = Math.min(await candidates.count().catch(() => 0), 60);
    for (let i = 0; i < n; i++) {
        const el = candidates.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const raw =
            ((await el.innerText({ timeout: 500 }).catch(() => "")) ||
                (await el.getAttribute("value").catch(() => "")) ||
                (await el.getAttribute("aria-label").catch(() => "")) ||
                "")
                .replace(/\s+/g, " ")
                .trim();
        if (!raw || raw.length > 40) continue;
        if (NEVER_CLICK_RE.test(raw)) continue;
        if (!VERIFY_BUTTON_RE.test(raw)) continue;
        if (await el.isDisabled().catch(() => false)) continue;
        await el.click({ timeout: 3000 }).catch(() => undefined);
        return raw;
    }
    return null;
}

export type OtpAcceptance = "accepted" | "invalid" | "still_otp";

/**
 * After the digits are typed: wait for Apollo to drop the OTP screen.
 * Clicks Verify/Login once immediately and again after ~4s if the screen is still up.
 */
export async function waitForOtpAccepted(
    page: Page,
    opts: { deadlineAt: number; maxWaitMs?: number; isCancelled?: () => boolean },
): Promise<{ status: OtpAcceptance; clicked: string[] }> {
    const clicked: string[] = [];
    const until = Math.min(opts.deadlineAt - 5_000, Date.now() + (opts.maxWaitMs ?? 18_000));
    let lastClickAt = 0;
    let firstCheck = true;
    while (Date.now() < until) {
        if (opts.isCancelled?.()) return { status: "still_otp", clicked };
        const visible = await isOtpScreenVisible(page);
        if (!visible) {
            // Give the SPA a beat to settle (login modal closing → header "Hi, …")
            await sleep(page, 1200);
            if (!(await isOtpScreenVisible(page))) return { status: "accepted", clicked };
        }
        const blob = (await bodyText(page, 2500)).toLowerCase();
        if (/invalid\s*otp|incorrect\s*otp|wrong\s*otp|otp\s*(is\s*)?(invalid|incorrect|expired)|otp\s*has\s*expired|enter\s*(a\s*)?valid\s*otp/.test(blob)) {
            return { status: "invalid", clicked };
        }
        const now = Date.now();
        if (visible && (firstCheck || now - lastClickAt > 4_000) && clicked.length < 3) {
            const label = await clickOtpVerifyButton(page);
            if (label) clicked.push(label);
            lastClickAt = now;
        }
        firstCheck = false;
        await sleep(page, 700);
    }
    return { status: (await isOtpScreenVisible(page)) ? "still_otp" : "accepted", clicked };
}

/** Parse "Order exact SKU from Apollo: <name> @ ₹112.50 | delivery_address=…" */
export function parseExactSkuFromGoal(goal: string, startUrl?: string): ExactSku | null {
    const m = goal.match(/Order exact SKU from [^:]+:\s*([^|@]+?)(?:\s*@\s*₹\s*([\d,]+(?:\.\d+)?))?\s*(?:\||$)/i);
    if (!m) return null;
    const name = m[1]!.trim();
    if (!name) return null;
    const price = m[2] ? Math.round(Number(m[2].replace(/,/g, "")) * 100) : undefined;
    const productUrl =
        startUrl && /apollopharmacy\.in\/(otc|medicine|product)\//i.test(startUrl) ? startUrl : undefined;
    return { name, pricePaise: Number.isFinite(price) ? price : undefined, productUrl, qty: 1 };
}

export function extractPincode(text?: string): string | undefined {
    return text?.match(/\b([1-9]\d{5})\b/)?.[1];
}

export function formatPaise(paise?: number): string {
    if (typeof paise !== "number" || !Number.isFinite(paise)) return "";
    const r = paise / 100;
    return Number.isInteger(r) ? `₹${r}` : `₹${r.toFixed(2)}`;
}

function productTokens(name: string): string[] {
    return name
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !/^(tablet|tablets|strip|chewable|chewanle|orange|flavour|flavor|the|and|with|15s|10s|20s)$/.test(t))
        .slice(0, 3);
}

async function cartCount(page: Page): Promise<number | null> {
    return page
        .evaluate(() => {
            const header = document.querySelector("header") || document.body;
            const cands = Array.from(
                header.querySelectorAll('a[href*="cart" i], [class*="cart" i], [aria-label*="cart" i]'),
            );
            for (const c of cands) {
                const t = (c.textContent || "").replace(/\s+/g, " ").trim();
                const m = t.match(/(^|\s)(\d{1,3})(\s|$)/);
                if (m) return Number(m[2]);
            }
            return null;
        })
        .catch(() => null);
}

/** Text of the right-hand buy box on an Apollo PDP (price / stock / add button). */
async function buyBoxText(page: Page): Promise<string> {
    return page
        .evaluate(() => {
            const divs = Array.from(document.querySelectorAll("div"));
            const box = divs.find((d) => {
                const t = d.innerText || "";
                return /inclusive of all taxes/i.test(t) && t.length < 900;
            });
            return (box?.innerText || "").replace(/\s+/g, " ").slice(0, 900);
        })
        .catch(() => "");
}

export type AddToCartOutcome =
    | { status: "added"; detail: string; cartCountBefore?: number | null; cartCountAfter?: number | null }
    | { status: "out_of_stock"; detail: string }
    | { status: "not_found" | "add_failed" | "no_time"; detail: string };

/** Buy box shows a resolved pincode (delivery ETA / unavailable / "Change"). */
function pincodeResolved(box: string, pincode: string): boolean {
    return (
        box.includes(pincode) &&
        /change|delivery\s*by|deliver\s*by|unavailable|out\s*of\s*stock|get\s*it\s*by/i.test(box)
    );
}

/**
 * Apply the delivery pincode on the PDP (drives real stock). Retries because clicks are
 * ignored until the Next.js page hydrates. Returns true once Apollo shows a pincode result.
 */
async function applyPincodeOnPdp(page: Page, pincode: string, deadlineAt: number): Promise<boolean> {
    const until = Math.min(deadlineAt - 12_000, Date.now() + 16_000);
    for (let attempt = 0; Date.now() < until; attempt++) {
        const box = await buyBoxText(page);
        if (pincodeResolved(box, pincode)) return true;
        const input = page.locator('input[placeholder*="pincode" i]').first();
        if (await input.isVisible().catch(() => false)) {
            await input.fill(pincode).catch(() => undefined);
            const apply = page.getByRole("button", { name: /^(apply|check)$/i }).first();
            if (await apply.isVisible().catch(() => false)) {
                await apply.click({ timeout: 3000 }).catch(() => undefined);
            } else {
                await page.keyboard.press("Enter").catch(() => undefined);
            }
        }
        const settle = Date.now() + 3_000;
        while (Date.now() < settle) {
            await sleep(page, 400);
            if (pincodeResolved(await buyBoxText(page), pincode)) return true;
        }
        if (attempt >= 4) break;
    }
    return false;
}

/**
 * Open the exact product page and add ONE unit. Only clicks the main buy-box
 * "Add N Strip(s)" / "Add to Cart" (never related-product "Add" tiles).
 */
export async function addExactSkuToApolloCart(
    page: Page,
    sku: ExactSku,
    opts: { deadlineAt: number; pincode?: string },
): Promise<AddToCartOutcome> {
    const first = await addExactSkuOnce(page, sku, opts);
    if (first.status !== "add_failed" || remaining(opts.deadlineAt) < 35_000) return first;
    // Clicks before hydration are silently ignored — one clean retry on a fresh load
    const second = await addExactSkuOnce(page, sku, opts);
    return second.status === "add_failed" ? { ...second, detail: `${second.detail} (retried)` } : second;
}

async function addExactSkuOnce(
    page: Page,
    sku: ExactSku,
    opts: { deadlineAt: number; pincode?: string },
): Promise<AddToCartOutcome> {
    if (!sku.productUrl) return { status: "not_found", detail: "no product URL for the exact SKU" };
    if (remaining(opts.deadlineAt) < 15_000) return { status: "no_time", detail: "deadline" };
    await page
        .goto(sku.productUrl, {
            waitUntil: "domcontentloaded",
            timeout: Math.min(30_000, remaining(opts.deadlineAt) - 8_000),
        })
        .catch(() => undefined);

    // Wait for hydration: buy box with Add / Out of Stock / unavailable
    const hydrateUntil = Math.min(opts.deadlineAt - 8_000, Date.now() + 14_000);
    let box = "";
    while (Date.now() < hydrateUntil) {
        box = await buyBoxText(page);
        if (/out\s*of\s*stock|unavailable|add\s+\d+\s+\w+|add\s*to\s*cart|notify\s*me/i.test(box)) break;
        await sleep(page, 600);
    }
    await page.waitForLoadState("load", { timeout: Math.max(1_000, Math.min(15_000, remaining(opts.deadlineAt) - 20_000)) }).catch(() => undefined);
    await sleep(page, 1200); // stock re-check happens client-side right after hydration
    if (opts.pincode && !(await applyPincodeOnPdp(page, opts.pincode, opts.deadlineAt))) {
        console.warn(`[pharmacy-login] PDP pincode ${opts.pincode} not confirmed (continuing)`);
    }
    box = await buyBoxText(page);
    if (!box) {
        const blob = await bodyText(page, 1500);
        if (/page not found|404|we.re broken/i.test(blob)) {
            return { status: "not_found", detail: "product page not found" };
        }
    }
    if (/out\s*of\s*stock|currently\s*unavailable|unavailable\s*at\s*your\s*pincode|notify\s*me/i.test(box)) {
        return {
            status: "out_of_stock",
            detail: /pincode/i.test(box)
                ? `unavailable at pincode ${opts.pincode || ""}`.trim()
                : "out of stock",
        };
    }

    const before = await cartCount(page);
    if (/view\s*cart|go\s*to\s*cart/i.test(box)) {
        return { status: "added", detail: "already in cart", cartCountBefore: before, cartCountAfter: before };
    }

    // Best-effort: quantity → 1 (Apollo defaults to the "30-day course", e.g. 2 strips)
    const qtyBtn = page
        .locator('div[role="button"], button')
        .filter({ hasText: /^\s*\d+\s+(strips?|units?|bottles?|packs?|tubes?|pieces?)/i })
        .first();
    if (await qtyBtn.isVisible().catch(() => false)) {
        await qtyBtn.click({ timeout: 3000 }).catch(() => undefined);
        const one = page.getByRole("menuitem", { name: /^1\s+(strip|unit|bottle|pack|tube|piece)\b/i }).first();
        if (await one.isVisible({ timeout: 2000 }).catch(() => false)) {
            await one.click({ timeout: 3000 }).catch(() => undefined);
        } else {
            await page.keyboard.press("Escape").catch(() => undefined);
        }
        await sleep(page, 600);
        // Apollo: picking a quantity from this menu adds straight to cart ("1 Item ₹… View Cart")
        const settleUntil = Math.min(opts.deadlineAt - 10_000, Date.now() + 6_000);
        while (Date.now() < settleUntil) {
            const b = await buyBoxText(page);
            if (/view\s*cart|go\s*to\s*cart|\b\d+\s*items?\b/i.test(b)) {
                const after = await cartCount(page);
                return { status: "added", detail: `qty menu → ${b.match(/\d+\s*items?[^A-Za-z]*₹?\s*[\d,.]*/i)?.[0] || "view cart"}`, cartCountBefore: before, cartCountAfter: after };
            }
            if (/add\s+\d+\s+\w+|add\s*to\s*cart/i.test(b)) break;
            await sleep(page, 500);
        }
    }

    const addRe = /^\s*(add\s+\d+\s+(strips?|units?|bottles?|packs?|tubes?|pieces?|items?)|add\s*to\s*cart)\s*$/i;
    const add = page.locator('button, [role="button"], span').filter({ hasText: addRe });
    // Buy box re-renders (spinner) after quantity / pincode changes — wait for Add to come back
    const addUntil = Math.min(opts.deadlineAt - 10_000, Date.now() + 10_000);
    let addCount = await add.count().catch(() => 0);
    while (!addCount && Date.now() < addUntil) {
        await sleep(page, 500);
        addCount = await add.count().catch(() => 0);
    }
    if (!addCount) {
        const boxNow = await buyBoxText(page);
        if (/out\s*of\s*stock|unavailable|notify\s*me/i.test(boxNow)) {
            return { status: "out_of_stock", detail: /pincode/i.test(boxNow) ? `unavailable at pincode ${opts.pincode || ""}`.trim() : "out of stock" };
        }
        return { status: "add_failed", detail: "Add button not found on product page" };
    }
    for (let attempt = 0; attempt < 2 && remaining(opts.deadlineAt) > 10_000; attempt++) {
        const target = attempt === 0 ? add.first() : add.first().locator("xpath=..");
        await target.click({ timeout: 4000 }).catch(() => undefined);
        await sleep(page, 2500);
        const after = await cartCount(page);
        const boxAfter = await buyBoxText(page);
        const stepper = /view\s*cart|go\s*to\s*cart|added|remove|\bqty\b/i.test(boxAfter);
        if ((before != null && after != null && after > before) || stepper) {
            return { status: "added", detail: `cart ${before ?? "?"}→${after ?? "?"}`, cartCountBefore: before, cartCountAfter: after };
        }
        if (/out\s*of\s*stock|unavailable/i.test(boxAfter)) {
            return { status: "out_of_stock", detail: "went out of stock while adding" };
        }
    }
    return { status: "add_failed", detail: "clicked Add but the cart did not change" };
}

export type CartSummary = {
    qty?: number;
    itemSeen: boolean;
    totalLabel?: string;
    addressText?: string;
    addressMatchesPincode: boolean;
    codMentioned: boolean;
    raw: string;
};

export function parseCartText(raw: string, sku: ExactSku, pincode?: string): CartSummary & { qty?: number } {
    let text = raw.replace(/\u00a0/g, " ");
    // Ignore the site header ("Delivery Address / Raipur 492001" is just the browse location)
    const cartStart = text.search(/your\s*cart|items?\s*in\s*your\s*cart|cart\s*breakdown|order\s*summary/i);
    const header = cartStart > 0 ? text.slice(0, cartStart) : "";
    if (cartStart > 0) text = text.slice(cartStart);
    const lower = text.toLowerCase();
    const toks = productTokens(sku.name);
    const itemSeen = toks.length > 0 && toks.every((t) => lower.includes(t));
    let totalNum: string | undefined;
    const bill = text.match(/(total\s*bill|to\s*pay|amount\s*to\s*(?:be\s*)?pa(?:y|id)|grand\s*total|total\s*amount|order\s*total|total\s*payable)([\s\S]{0,80})/i);
    if (bill) {
        const seg = bill[2]!.split(/you\s*will\s*save|save|offer|coupon/i)[0]!;
        const nums = seg.match(/[\d,]+(?:\.\d{1,2})?/g)?.filter((n) => /\d/.test(n) && Number(n.replace(/,/g, "")) > 0);
        // Struck-through MRP total first, payable total last
        if (nums?.length) totalNum = nums[nums.length - 1];
    }
    const qtyM = text.match(/\bqty\s*[:\-]?\s*(\d{1,2})\b/i);
    let addressText: string | undefined;
    const addrM = text.match(/(deliver(?:y|ing)?\s*(?:to|address)|shipping\s*address)[:\s]*\n?\s*([^\n]{8,160})/i);
    if (addrM) addressText = addrM[2]!.trim();
    const pinRe = pincode ? new RegExp(`\\b${pincode}\\b`) : null;
    const addressMatchesPincode = Boolean(pinRe && (pinRe.test(text) || (addressText && pinRe.test(addressText))));
    return {
        itemSeen,
        totalLabel: totalNum ? `₹${totalNum}` : undefined,
        addressText: addressText || (pinRe && pinRe.test(header) ? `browse location ${pincode}` : undefined),
        addressMatchesPincode,
        codMentioned: /cash\s*on\s*delivery|\bcod\b|pay\s*on\s*delivery/i.test(text),
        qty: qtyM ? Number(qtyM[1]) : undefined,
        raw: text.slice(0, 3000),
    };
}

/** Try to pick the saved address with this pincode on the cart / address sheet. */
async function trySelectAddressByPincode(page: Page, pincode: string, deadlineAt: number): Promise<boolean> {
    if (remaining(deadlineAt) < 12_000) return false;
    const opener = page
        .locator('button, [role="button"], a, p, span')
        .filter({ hasText: /^\s*(select\s*address|change(\s*address)?|add\s*address|select\s*delivery\s*address)\s*$/i })
        .first();
    if (!(await opener.isVisible().catch(() => false))) return false;
    await opener.click({ timeout: 3000 }).catch(() => undefined);
    await sleep(page, 1800);
    // Smallest visible element whose text includes the pincode (address card)
    const picked = await page
        .evaluate((pin) => {
            const els = Array.from(document.querySelectorAll("div, li, label, p"));
            const hits = els
                .filter((e) => {
                    const t = (e as HTMLElement).innerText || "";
                    const r = e.getBoundingClientRect();
                    return t.includes(pin) && t.length < 400 && r.width > 50 && r.height > 20;
                })
                .sort((a, b) => ((a as HTMLElement).innerText.length - (b as HTMLElement).innerText.length));
            const el = hits[0] as HTMLElement | undefined;
            if (!el) return false;
            el.click();
            return true;
        }, pincode)
        .catch(() => false);
    if (!picked) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return false;
    }
    await sleep(page, 1200);
    const confirmBtn = page
        .getByRole("button", { name: /^(deliver\s*here|confirm(\s*address)?|save|select|done|proceed)$/i })
        .first();
    if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({ timeout: 3000 }).catch(() => undefined);
        await sleep(page, 1500);
    }
    return true;
}

export async function readApolloCart(
    page: Page,
    sku: ExactSku,
    opts: { deadlineAt: number; pincode?: string },
): Promise<CartSummary | null> {
    if (remaining(opts.deadlineAt) < 10_000) return null;
    await page
        .goto("https://www.apollopharmacy.in/medicines-cart", {
            waitUntil: "domcontentloaded",
            timeout: Math.min(25_000, remaining(opts.deadlineAt) - 5_000),
        })
        .catch(() => undefined);
    const until = Math.min(opts.deadlineAt - 5_000, Date.now() + 10_000);
    let summary = parseCartText(await bodyText(page, 6000), sku, opts.pincode);
    while (Date.now() < until && !(summary.itemSeen && summary.totalLabel)) {
        await sleep(page, 800);
        summary = parseCartText(await bodyText(page, 6000), sku, opts.pincode);
    }
    if (opts.pincode && !summary.addressMatchesPincode) {
        const picked = await trySelectAddressByPincode(page, opts.pincode, opts.deadlineAt);
        if (picked) summary = parseCartText(await bodyText(page, 6000), sku, opts.pincode);
    }
    return summary;
}

/** Confirm-before-pay card from real cart data (never invents totals). */
export function formatApolloConfirmCard(input: {
    sku: ExactSku;
    cart: CartSummary | null;
    addressLabel?: string;
}): { message: string; items: string[]; totalLabel: string; addressLabel: string } {
    const price = formatPaise(input.sku.pricePaise);
    const qty = input.cart?.qty && input.cart.itemSeen ? input.cart.qty : input.sku.qty;
    const item = `${input.sku.name} ×${qty}${price ? ` — ${price} each` : ""}`;
    const cartTotal = input.cart?.totalLabel;
    const totalLabel = cartTotal
        ? `${cartTotal} (Apollo cart total incl. charges)`
        : price
          ? `${price} (item price; Apollo adds any delivery fee at checkout)`
          : "shown by Apollo at checkout";
    const verifiedAddr = input.cart?.addressMatchesPincode;
    const addressLabel = input.addressLabel || input.cart?.addressText || "your saved Apollo address";
    const lines = [
        `*Confirm before pay — Apollo:*`,
        `• ${item}`,
        ``,
        `Total: ${totalLabel}`,
        `Deliver to: ${addressLabel}${verifiedAddr === false ? " _(please double-check — Apollo's cart didn't show this pincode yet)_" : ""}`,
        `Payment: *Cash on Delivery* preferred${input.cart && !input.cart.codMentioned ? " (I'll pick COD at checkout if Apollo offers it)" : ""}.`,
        input.cart && !input.cart.itemSeen ? `_Note: I added it, but couldn't read the cart line back — I'll re-check before placing._` : "",
        ``,
        `Reply *confirm* to place with COD, or *cancel*. Nothing is paid until you confirm.`,
    ].filter((l, i, arr) => l !== "" || (arr[i - 1] ?? "") !== "");
    return { message: lines.join("\n"), items: [item], totalLabel, addressLabel };
}
