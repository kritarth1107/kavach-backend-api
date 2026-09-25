/**
 * Hard, code-level guardrails for the agent layer (Stagehand + Gemini computer-use).
 *
 * The LLM only ever *proposes* an action. Code validates the proposal against these
 * denylists using BOTH the model's description and the element's real text/aria/attributes
 * read from the live DOM. Anything that looks like payment (other than code-driven COD),
 * a membership/upsell, cart removal or "Place order" is refused. Placing the order and
 * selecting COD are done by deterministic code only, exactly once, after the user's confirm.
 */

/** Non-COD payment methods / payment actions. */
export const NON_COD_PAYMENT_RE =
    /\bupi\b|\bcard\b|credit|debit|wallet|paytm|phone\s*pe|phonepe|g\s*pay|gpay|google\s*pay|amazon\s*pay|pay\s*later|paylater|\bsimpl\b|lazy\s*pay|lazypay|net\s*banking|netbanking|\bemi\b|\bqr\b|scan\s*(?:&|and)?\s*pay|pay\s*now|pay\s*₹|pay\s*rs|proceed\s*to\s*pay|\bmobikwik\b|\bcred\b|\bsodexo\b|pluxee|\bbhim\b/i;

/** Memberships, subscriptions, paid plans and upsells. */
export const MEMBERSHIP_UPSELL_RE =
    /membership|\bmember\b|subscri|upgrade|\bplans?\b|swiggy\s*one|zomato\s*gold|\bgold\b|zepto\s*pass|\bpass\b|circle|\bjoin\b|free\s*trial|\bpremium\b|\bplus\b|add\s*plan|donat|\btip\b|feeding\s*india/i;

/**
 * Narrower upsell check for the Gemini computer-use loop, where click targets can include
 * product names ("Honey Gold", "Plus", "Pass") on search results.
 */
export const COMPUTER_USE_UPSELL_RE =
    /membership|subscri|swiggy\s*one|zomato\s*gold|zepto\s*pass|circle\s*(?:membership|plan)|add\s*plan|choose\s*(?:a\s*)?plan|upgrade|free\s*trial|join\s*(?:now|circle|one|gold|pass)|become\s*a\s*member/i;

/** Stricter membership check for cart LINE names (product names can contain "gold"/"plus"). */
export const CART_UPSELL_LINE_RE =
    /membership|subscri|swiggy\s*one|zomato\s*gold|zepto\s*pass|circle\s*(?:membership|plan)|\b\d+\s*months?\s*plan\b|donation/i;

/** Removing things from the cart (only deterministic code may do this, before adding). */
export const CART_REMOVE_RE =
    /\b(remove|delete|dustbin|trash|clear\s*cart|empty\s*cart|decrease|decrement)\b|minus/i;

/** Placing the order — code only, once, after confirm. */
export const PLACE_ORDER_RE =
    /place\s*(?:your\s*)?order|confirm\s*(?:&|and)?\s*(?:place|order|pay)|complete\s*order|submit\s*order|order\s*now|buy\s*now|pay\s*on\s*delivery\s*(?:&|and)?\s*place/i;

/** Cash on delivery — selected by code only. */
export const COD_RE = /cash\s*on\s*delivery|pay\s*on\s*delivery|\bcod\b|cash\s*\/\s*upi\s*on\s*delivery|pay\s*cash/i;

/** Account-damaging controls. */
export const ACCOUNT_RE = /log\s*out|logout|sign\s*out|delete\s*account|deactivate/i;

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardReason; matched: string };
export type GuardReason = "non_cod_payment" | "membership_upsell" | "cart_remove" | "place_order" | "cod_code_only" | "account" | "typing" | "method";

/** Only these Stagehand/Playwright methods may be executed by the agent. Never fill/type. */
export const AGENT_ALLOWED_METHODS = new Set(["click", "scrollIntoView", "scrollTo", "scroll", "nextChunk", "prevChunk"]);

function firstMatch(re: RegExp, s: string): string | null {
    const m = s.match(re);
    return m ? m[0] : null;
}

/**
 * Validate one agent-proposed action. `texts` should contain the model's description AND the
 * element's live text / aria-label / title / value / href read from the DOM.
 */
export function validateAgentAction(args: { method?: string | null; texts: Array<string | null | undefined> }): GuardVerdict {
    const method = (args.method || "click").trim();
    if (/^(fill|type|press|selectOption|selectOptionFromDropdown|setInputFiles)$/i.test(method)) {
        return { ok: false, reason: "typing", matched: method };
    }
    if (!AGENT_ALLOWED_METHODS.has(method)) return { ok: false, reason: "method", matched: method };
    const hay = args.texts.filter(Boolean).join(" \n ").replace(/\s+/g, " ");
    let m: string | null;
    if ((m = firstMatch(PLACE_ORDER_RE, hay))) return { ok: false, reason: "place_order", matched: m };
    if ((m = firstMatch(NON_COD_PAYMENT_RE, hay))) return { ok: false, reason: "non_cod_payment", matched: m };
    if ((m = firstMatch(COD_RE, hay))) return { ok: false, reason: "cod_code_only", matched: m };
    if ((m = firstMatch(MEMBERSHIP_UPSELL_RE, hay))) return { ok: false, reason: "membership_upsell", matched: m };
    if ((m = firstMatch(CART_REMOVE_RE, hay))) return { ok: false, reason: "cart_remove", matched: m };
    if ((m = firstMatch(ACCOUNT_RE, hay))) return { ok: false, reason: "account", matched: m };
    return { ok: true };
}

/**
 * Guard for the generic Gemini computer-use loop (food/grocery sites): applied on EVERY click,
 * confirmed or not. Non-COD payment, membership/upsell and Place order are never clicked by
 * the model — placement is deterministic code in the step engine only.
 */
export function guardComputerUseClick(targetText: string): GuardVerdict {
    const hay = (targetText || "").replace(/\s+/g, " ");
    let m: string | null;
    if ((m = firstMatch(PLACE_ORDER_RE, hay))) return { ok: false, reason: "place_order", matched: m };
    if ((m = firstMatch(NON_COD_PAYMENT_RE, hay))) return { ok: false, reason: "non_cod_payment", matched: m };
    if ((m = firstMatch(COMPUTER_USE_UPSELL_RE, hay))) return { ok: false, reason: "membership_upsell", matched: m };
    return { ok: true };
}

/** Parse "₹1,234.50" / "Rs 99" → rupees. */
export function parseRupees(label: string | null | undefined): number | null {
    if (!label) return null;
    const m = String(label).replace(/,/g, "").match(/(?:₹|rs\.?|inr)\s*(\d+(?:\.\d{1,2})?)/i) || String(label).replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}

/** Payable must not exceed what the user confirmed (₹1 rounding tolerance). */
export function totalWithinConfirmed(payable: number | null, confirmed: number | null | undefined): boolean {
    if (payable == null || confirmed == null || !Number.isFinite(confirmed)) return false;
    return payable <= confirmed + 1;
}

/** Selected payment method text must be COD and nothing else. */
export function isCodSelection(selectedMethodText: string | null | undefined): boolean {
    const t = (selectedMethodText || "").trim();
    if (!t) return false;
    if (!COD_RE.test(t)) return false;
    // "Cash/UPI on delivery" is still pay-on-delivery; any other online method is not.
    const stripped = t.replace(COD_RE, " ");
    return !NON_COD_PAYMENT_RE.test(stripped.replace(/\bupi\b/i, ""));
}

/** Cart must be exactly one line of the confirmed SKU at qty 1, with no membership lines. */
export function validateCartLines(
    lines: Array<{ name: string; qty?: number | null }>,
    skuName: string | null | undefined,
): { ok: true } | { ok: false; detail: string } {
    const real = lines.filter((l) => l && l.name && l.name.trim());
    const upsell = real.find((l) => CART_UPSELL_LINE_RE.test(l.name));
    if (upsell) return { ok: false, detail: `cart has a membership/plan line: ${upsell.name.slice(0, 60)}` };
    if (real.length !== 1) return { ok: false, detail: `cart has ${real.length} lines (expected exactly 1)` };
    const line = real[0]!;
    if (line.qty != null && Number(line.qty) !== 1) return { ok: false, detail: `quantity is ${line.qty} (expected 1)` };
    if (skuName && !namesRoughlyMatch(line.name, skuName)) {
        return { ok: false, detail: `cart item "${line.name.slice(0, 60)}" doesn't match "${skuName.slice(0, 60)}"` };
    }
    return { ok: true };
}

function tokens(s: string): string[] {
    return s
        .toLowerCase()
        .replace(/(\d)([a-z])/g, "$1 $2")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 2 && !["of", "the", "and", "with", "for", "pack", "x"].includes(t));
}

export function namesRoughlyMatch(a: string, b: string): boolean {
    const ta = new Set(tokens(a));
    const tb = tokens(b);
    if (!tb.length || !ta.size) return false;
    const hit = tb.filter((t) => ta.has(t)).length;
    return hit / tb.length >= 0.6;
}
