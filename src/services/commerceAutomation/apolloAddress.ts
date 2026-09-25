/**
 * Apollo signed-in delivery address — deterministic select-or-add (no Gemini, no guessing).
 *
 * What the real screens look like (read from Apollo's own bundles, Sep 2026):
 *
 *  /medicines-cart  (pharma-cart-fe, CSS module "CartAddress_*")
 *    - address selected:   [CartAddress_addressBlock] "Bill to <name>" + p.CartAddress_address
 *                          "<line1>, <line2>, <city>, <state> - <pin>" + action span "Change"
 *                          (or "Add Address" when the account has no saved list).
 *    - nothing selected:   [CartAddress_addressBlock CartAddress_addAdressBlock] "Bill to <name>"
 *                          + "<browse city> <browse pin>" (e.g. "Bhopal 462001" — the header
 *                          browse location, NOT a delivery address) + action span
 *                          "SELECT ADDRESS" (has saved addresses) / "ADD ADDRESS" / "ADD DETAILS" / "+ ADD".
 *  Action → "Deliver to" right drawer (main app, "AddNewAddressRevamped_*"):
 *    "Choose from Saved Address" + ONE card (NewSavedAddressCard_savedAddressChild, desc
 *    "<line1>, <line2>, <city>, <state> - <pin>", edit/delete icons) + "View Other Saved Address"
 *    (opens a 2nd "Deliver to" drawer listing all saved cards) + "or" + "Current Location" +
 *    "or" + "Add New Address". Clicking a card selects it (serviceability check, drawer closes);
 *    a card without lat/long shows "Selected address needs to be updated." and opens its editor.
 *  "Add New Address" → full-page "Deliver to" search: input "Search for society, locality,
 *    pincode..." → "Search Results" (NewSearchLocationSuggestor_searchItemList: h3 title + p
 *    description). Picking one → window.location = /address-details?view=map.
 *  /address-details (Next.js; desktop shows map + form side by side):
 *    Tab "Address Details": textarea[name=address1] "House/ Floor/ Flat Number *",
 *    #address2 area (disabled, from the map pin), #landmark, #pincode / #city / #state (all
 *    disabled — they come from the map location), "Save & Next".
 *    Tab "Recipient Details": "Who are you ordering for?" (Myself / Someone else), "Save this
 *    address as *" (buttons #HOME / #OFFICE / #FRIENDSANDFAMILY / #OTHER), recipientName,
 *    recipientContact (+91, 10 digits; both prefilled from the Apollo profile), "Save Address"
 *    → savePatientAddress → address selected → back to /medicines-cart.
 *  After cart "Proceed": ConfirmCartAddressDialog ("Deliver to"): "Delivery Address" + the
 *    selected card + "Change Address" + Recipient / Recipient Contact inputs + "Proceed".
 */
import type { Page } from "playwright";

export type AddressTarget = {
    label: string;
    pincode: string;
    flat?: string;
    society?: string;
    area?: string;
    landmark?: string;
    city?: string;
    state?: string;
    /** House / flat line typed into Apollo's "House/ Floor/ Flat Number" field. */
    line1: string;
    /** Distinctive fragments that must appear on a matching saved address. */
    hints: string[];
    /** Location searches, most specific first (the last one is the bare pincode). */
    searchQueries: string[];
};

const STATE_RE =
    /^(andhra pradesh|arunachal pradesh|assam|bihar|chhattisgarh|goa|gujarat|haryana|himachal pradesh|jharkhand|karnataka|kerala|madhya pradesh|maharashtra|manipur|meghalaya|mizoram|nagaland|odisha|orissa|punjab|rajasthan|sikkim|tamil nadu|telangana|tripura|uttar pradesh|uttarakhand|west bengal|delhi|new delhi|jammu and kashmir|ladakh|puducherry|chandigarh)$/i;
const LANDMARK_RE = /^(near|opp\.?|opposite|behind|beside|next to|in front of)\b/i;

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();
function titleCase(s?: string): string | undefined {
    if (!s) return undefined;
    return s
        .toLowerCase()
        .replace(/\b[a-z]/g, (c) => c.toUpperCase())
        .replace(/\b([a-z]?-?\d+[a-z]?)\b/gi, (m) => m.toUpperCase());
}
/** Lowercase alphanumerics only ("B-12, Green  Park" → "b12greenpark"). */
export function normAddr(s: string): string {
    return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Parse "B12, Green Park, Arera, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001". */
export function addressTargetFrom(label?: string): AddressTarget | null {
    if (!label) return null;
    const pincode = label.match(/\b(\d{6})\b/)?.[1];
    if (!pincode) return null;
    let parts = label
        .split(",")
        .map((p) => tidy(p.replace(new RegExp(`\\b${pincode}\\b`), "")))
        .filter(Boolean);
    let state: string | undefined;
    let city: string | undefined;
    let flat: string | undefined;
    let landmark: string | undefined;
    if (parts.length && STATE_RE.test(parts[parts.length - 1]!)) state = parts.pop();
    if (parts.length > 1) city = parts.pop();
    if (parts.length) {
        const m = parts[0]!.match(/^([A-Za-z]{0,3}[-\s]?\d{1,5}[A-Za-z]?)(?:\s+(.+))?$/);
        if (m) {
            flat = m[1]!.replace(/\s+/g, "");
            parts = m[2] ? [m[2], ...parts.slice(1)] : parts.slice(1);
        }
    }
    const rest: string[] = [];
    for (const p of parts) {
        if (!landmark && LANDMARK_RE.test(p)) landmark = p;
        else rest.push(p);
    }
    const society = rest[0];
    const area = rest.slice(1).join(", ") || undefined;
    const T = titleCase;
    const line1 = [flat?.toUpperCase(), T(society)].filter(Boolean).join(", ");
    const hints = [flat?.toUpperCase(), T(society)].filter((h): h is string => Boolean(h));
    const q = (...xs: Array<string | undefined>) => tidy(xs.filter(Boolean).join(" "));
    const queries = [
        society && city ? q(T(society), T(area), T(city)) : "",
        society && city ? q(T(society), T(city)) : "",
        area && city ? q(T(area), T(city)) : "",
        pincode,
    ].filter((s) => s.length >= 4);
    return {
        label,
        pincode,
        flat: flat?.toUpperCase(),
        society: T(society),
        area: T(area),
        landmark: T(landmark),
        city: T(city),
        state: T(state),
        line1: line1 || T(rest.join(", ")) || "",
        hints,
        searchQueries: Array.from(new Set(queries)),
    };
}

/** Saved-address text matches when it has the pincode AND the flat or the society name. */
export function savedAddressMatches(text: string, target: Pick<AddressTarget, "pincode" | "flat" | "society">): boolean {
    if (!text || !new RegExp(`\\b${target.pincode}\\b`).test(text)) return false;
    const n = normAddr(text);
    const flat = target.flat ? normAddr(target.flat) : "";
    const soc = target.society ? normAddr(target.society) : "";
    return Boolean((flat && n.includes(flat)) || (soc && n.includes(soc)));
}

/** Score Apollo location-search rows; must mention the city or pincode. Pure (unit-tested). */
export function pickSearchResult(
    items: Array<{ i: number; text: string }>,
    t: Pick<AddressTarget, "society" | "area" | "city" | "state" | "pincode">,
): { i: number; score: number; text: string } | null {
    const scored = items
        .map(({ i, text }) => {
            const n = normAddr(text);
            const has = (x?: string) => Boolean(x && n.includes(normAddr(x)));
            if (!has(t.city) && !n.includes(t.pincode)) return null;
            const score =
                (has(t.society) ? 4 : 0) + (has(t.area) ? 2 : 0) + (has(t.city) ? 1 : 0) + (n.includes(t.pincode) ? 2 : 0) + (has(t.state) ? 0.5 : 0);
            return { i, score, text };
        })
        .filter((x): x is { i: number; score: number; text: string } => Boolean(x));
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored[0] ?? null;
}

function remaining(deadlineAt: number): number {
    return deadlineAt - Date.now();
}
async function sleep(page: Page, ms: number): Promise<void> {
    await page.waitForTimeout(Math.max(0, ms)).catch(() => undefined);
}
function safeUrl(page: Page): string {
    try {
        return page.url();
    } catch {
        return "";
    }
}
async function waitFor(page: Page, until: number, check: () => Promise<boolean>, stepMs = 400): Promise<boolean> {
    while (Date.now() < until) {
        if (await check().catch(() => false)) return true;
        await sleep(page, stepMs);
    }
    return check().catch(() => false);
}

/* ─────────────────────────── cart address block ─────────────────────────── */

export type CartAddressState = {
    /** The CartAddress block was rendered. */
    found: boolean;
    /** A real delivery address is selected (not just the header browse location). */
    selected: boolean;
    /** Selected address text (or the browse "city pincode" line when nothing is selected). */
    text: string;
    /** The block's action link text ("Change", "SELECT ADDRESS", "ADD ADDRESS", …). */
    action: string;
    billTo: string;
    /**
     * Label of the cart's bottom sticky-bar primary button next to "Amount to pay"
     * ("SELECT ADDRESS" / "ADD ADDRESS" while no delivery address is selected, else "Proceed").
     * On the live signed-in desktop cart this bar is the ONLY address entry point (no block).
     */
    cta: string;
    /** Header "Deliver to <name> <city> <pin>" — browse location only, never a delivery address. */
    header: string;
};

const EMPTY_CART_ADDR: CartAddressState = { found: false, selected: false, text: "", action: "", billTo: "", cta: "", header: "" };
/** Bottom-bar CTA labels Apollo's cart API sends while no delivery address is selected. */
export const ADDRESS_CTA_RE = /^\s*(select\s*address|add\s*address|add\s*details|\+\s*add)\s*$/i;
export function ctaNeedsAddress(st: Pick<CartAddressState, "cta">): boolean {
    return ADDRESS_CTA_RE.test(st.cta || "");
}

export async function readCartAddressBlock(page: Page): Promise<CartAddressState> {
    return page
        .evaluate(() => {
            const out = { found: false, selected: false, text: "", action: "", billTo: "", cta: "", header: "" };
            const bodyTxt = (document.body.innerText || "").replace(/\s+/g, " ");
            const hm = bodyTxt.slice(0, 400).match(/deliver(?:y)?\s*(?:to|address)\s+.{0,60}?\b\d{6}\b/i);
            out.header = hm ? hm[0].trim() : "";
            // Bottom sticky bar: the primary button that shares a container with "Amount to pay".
            const amt = (Array.from(document.querySelectorAll("p, span, div")) as HTMLElement[]).filter(
                (e) => e.children.length <= 1 && /^\s*amount to pay\s*$/i.test(e.innerText || "") && e.getBoundingClientRect().width > 0,
            );
            for (const a of amt) {
                let box: HTMLElement | null = a;
                for (let i = 0; i < 6 && box && !out.cta; i++) {
                    box = box.parentElement;
                    if (!box) break;
                    const btn = (Array.from(box.querySelectorAll("button")) as HTMLElement[]).find((b) => b.getBoundingClientRect().width > 0);
                    if (btn) out.cta = (btn.innerText || "").replace(/\s+/g, " ").trim();
                }
                if (out.cta) break;
            }
            if (!out.cta) {
                const b = (Array.from(document.querySelectorAll("button")) as HTMLElement[]).find(
                    (x) => x.getBoundingClientRect().width > 0 && /^\s*(select\s*address|add\s*address|add\s*details)\s*$/i.test(x.innerText || ""),
                );
                if (b) out.cta = (b.innerText || "").replace(/\s+/g, " ").trim();
            }
            const blocks = Array.from(document.querySelectorAll('[class*="CartAddress_addressBlock"]')) as HTMLElement[];
            const block = blocks.find((b) => b.getBoundingClientRect().width > 0) || blocks[0];
            if (!block) return out;
            out.found = true;
            const isAdd = /CartAddress_addAdressBlock/.test(block.className || "");
            const addr = block.querySelector('[class*="CartAddress_address__"]') as HTMLElement | null;
            const act = block.querySelector(
                '[class*="CartAddress_addActions"] span, [class*="CartAddress_addressAction"] span',
            ) as HTMLElement | null;
            const bill = block.querySelector('[class*="CartAddress_cusName"]') as HTMLElement | null;
            out.text = (addr?.innerText || "").replace(/\s+/g, " ").trim();
            out.action = (act?.innerText || "").replace(/\s+/g, " ").trim();
            out.billTo = (bill?.innerText || "").replace(/\s+/g, " ").replace(/^\s*bill to\s*/i, "").trim();
            out.selected = !isAdd && Boolean(out.text);
            return out;
        })
        .catch(() => ({ ...EMPTY_CART_ADDR }));
}

/** Evidence from the cart block only: full = selected address has pin + flat/society. */
export function cartAddressEvidence(
    st: CartAddressState,
    target: Pick<AddressTarget, "pincode" | "flat" | "society">,
): "full" | "pincode" | "none" {
    if (!st.selected) return "none";
    if (savedAddressMatches(st.text, target)) return "full";
    return new RegExp(`\\b${target.pincode}\\b`).test(st.text) ? "pincode" : "none";
}

/* ─────────────────────────── Deliver-to drawer ─────────────────────────── */

const SHEET_SEL = '[class*="AddNewAddressRevamped_"]';
const SAVED_CARD_SEL = '[class*="NewSavedAddressCard_savedAddressChild"]';
const SAVED_DESC_SEL = '[class*="NewSavedAddressCard_addressDesc"]';
const SEARCH_INPUT_SEL = 'input[placeholder*="Search for society" i], input[placeholder*="locality, pincode" i]';
const SEARCH_ITEM_SEL = '[class*="NewSearchLocationSuggestor_searchItemList"]';

async function visibleCount(page: Page, sel: string): Promise<number> {
    return page
        .evaluate((s) => Array.from(document.querySelectorAll(s)).filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0).length, sel)
        .catch(() => 0);
}

export async function deliverToSheetOpen(page: Page): Promise<boolean> {
    return page
        // (no named helpers inside evaluate: tsx/esbuild would inject __name() into the page)
        .evaluate(() => {
            if (
                Array.from(document.querySelectorAll('[class*="AddNewAddressRevamped_"]')).some((e) => {
                    const r = (e as HTMLElement).getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                })
            ) {
                return true;
            }
            return Array.from(document.querySelectorAll("button")).some((b) => {
                const r = (b as HTMLElement).getBoundingClientRect();
                return r.width > 0 && r.height > 0 && /^\s*(add new address|view other saved address)\s*$/i.test((b as HTMLElement).innerText || "");
            });
        })
        .catch(() => false);
}

async function clickButtonByText(page: Page, re: RegExp, timeout = 3000): Promise<boolean> {
    const loc = page.locator("button, [role='button']").filter({ hasText: re });
    const n = Math.min(await loc.count().catch(() => 0), 6);
    for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        const t = ((await el.innerText({ timeout: 800 }).catch(() => "")) || "").trim();
        if (!re.test(t)) continue;
        await el.click({ timeout }).catch(async () => {
            await el.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
        });
        return true;
    }
    return false;
}

async function openDeliverToSheet(page: Page, until: number): Promise<boolean> {
    if (await deliverToSheetOpen(page)) return true;
    let act = page.locator('[class*="CartAddress_addActions"] span, [class*="CartAddress_addressAction"] span').first();
    if (!(await act.isVisible().catch(() => false))) {
        // Live signed-in cart without the block: the bottom-bar "SELECT ADDRESS" button runs Apollo's
        // SELECT_ADDRESS action → onAddressChangeCTAClicked → opens the same Deliver-to drawer.
        act = page.locator("button").filter({ hasText: ADDRESS_CTA_RE }).first();
        if (!(await act.isVisible().catch(() => false))) return false;
    }
    await act.click({ timeout: 3000 }).catch(async () => {
        await act.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
    });
    return waitFor(page, until, () => deliverToSheetOpen(page));
}

type SavedCard = { index: number; text: string };

async function readSavedCards(page: Page): Promise<SavedCard[]> {
    return page
        .evaluate(
            ({ card, desc }) =>
                Array.from(document.querySelectorAll(card))
                    .map((c, index) => ({ c: c as HTMLElement, index }))
                    .filter(({ c }) => c.getBoundingClientRect().width > 0)
                    .map(({ c, index }) => ({
                        index,
                        text: ((c.querySelector(desc) as HTMLElement | null)?.innerText || c.innerText || "").replace(/\s+/g, " ").trim(),
                    })),
            { card: SAVED_CARD_SEL, desc: SAVED_DESC_SEL },
        )
        .catch(() => []);
}

/* ─────────────────────────── ensure address ─────────────────────────── */

export type EnsureAddressResult =
    | { ok: true; how: "already_selected" | "selected_saved" | "added_new"; addressText: string; evidence: "full" }
    /**
     * Cart has no address block (live signed-in desktop layout): an address is selected on Apollo
     * (bottom bar says Proceed) but its text isn't on the cart — it MUST still be verified on the
     * "Deliver to" popup / delivery options before payment.
     */
    | { ok: true; how: "selected_saved" | "added_new" | "cart_proceed"; addressText: string; evidence: "pending" }
    | { ok: false; step: string; reason: string };

export type EnsureAddressOptions = {
    deadlineAt: number;
    /** Care recipient's name from Kavach (preferred recipient on a NEW address). */
    recipientName?: string;
    /** The signed-in Apollo account's own phone (10 digits / E.164) — only used if Apollo's field is empty. */
    accountPhone?: string;
    progress?: (d: string) => Promise<void>;
    log?: (event: string, extra?: Record<string, unknown>) => void;
};

const CART_URL = "https://www.apollopharmacy.in/medicines-cart";

async function gotoCart(page: Page, deadlineAt: number): Promise<void> {
    if (!/\/medicines-cart/i.test(safeUrl(page))) {
        await page
            .goto(CART_URL, { waitUntil: "domcontentloaded", timeout: Math.max(2_000, Math.min(20_000, remaining(deadlineAt) - 3_000)) })
            .catch(() => undefined);
    }
    await waitFor(
        page,
        Math.min(deadlineAt - 2_000, Date.now() + 12_000),
        async () => {
            const st = await readCartAddressBlock(page);
            return st.found || Boolean(st.cta) || (await deliverToSheetOpen(page));
        },
        500,
    );
}

/**
 * After selecting / saving: block layout → the block must show the target (full);
 * no-block layout → the bottom bar must stop asking for an address (pending: verify later).
 */
async function verifyCartSelected(
    page: Page,
    target: AddressTarget,
    deadlineAt: number,
    waitMs = 12_000,
): Promise<{ evidence: "full"; st: CartAddressState } | { evidence: "pending"; st: CartAddressState } | null> {
    await gotoCart(page, deadlineAt);
    let st = await readCartAddressBlock(page);
    const until = Math.min(deadlineAt - 1_500, Date.now() + waitMs);
    const done = async () =>
        cartAddressEvidence(st, target) === "full" || (!st.found && Boolean(st.cta) && !ctaNeedsAddress(st) && !(await deliverToSheetOpen(page)));
    while (Date.now() < until && !(await done())) {
        await sleep(page, 600);
        st = await readCartAddressBlock(page);
    }
    if (cartAddressEvidence(st, target) === "full") return { evidence: "full", st };
    if (!st.found && Boolean(st.cta) && !ctaNeedsAddress(st) && !(await deliverToSheetOpen(page))) return { evidence: "pending", st };
    return null;
}

export const phone10 = (p?: string) => {
    const d = String(p || "").replace(/\D/g, "");
    return d.length >= 10 ? d.slice(-10) : "";
};

/**
 * Make sure the cart's delivery address is the target (pincode + flat / society):
 * already selected → done; a matching saved address → select it; else add a new one
 * through Apollo's own Add New Address flow and select it. Never saves an address whose
 * pincode (from Apollo's map) differs from the target.
 */
export async function ensureApolloDeliveryAddress(
    page: Page,
    target: AddressTarget,
    opts: EnsureAddressOptions,
): Promise<EnsureAddressResult> {
    const log = opts.log ?? (() => undefined);
    const say = async (d: string) => {
        try {
            await opts.progress?.(d);
        } catch {
            /* ignore */
        }
    };
    const fail = (step: string, reason: string): EnsureAddressResult => {
        log("address_fail", { step, reason });
        return { ok: false, step, reason };
    };

    // 1) Cart block
    if (!/\/address-details/i.test(safeUrl(page))) {
        await gotoCart(page, opts.deadlineAt);
        const st = await readCartAddressBlock(page);
        const sheetOpen = await deliverToSheetOpen(page);
        log("address_cart_block", {
            found: st.found,
            selected: st.selected,
            text: st.text.slice(0, 120),
            action: st.action,
            cta: st.cta,
            header: st.header.replace(/^(deliver(?:y)?\s*(?:to|address))\s+\S+/i, "$1 [name]"),
            sheetOpen,
        });
        if (!st.found && !sheetOpen) {
            if (st.cta && !ctaNeedsAddress(st) && /proceed|continue|checkout/i.test(st.cta)) {
                // No block, bottom bar already says Proceed → Apollo has some address selected but the
                // cart doesn't print it (header "Deliver to … <pin>" is only the browse location).
                // It's verified on the Deliver-to popup (Change Address if wrong) before payment.
                log("address_pending", { cta: st.cta });
                return { ok: true, how: "cart_proceed", addressText: "", evidence: "pending" };
            }
            if (!ctaNeedsAddress(st)) {
                return fail("cart_block", `Apollo's cart showed no delivery-address section or Select Address button${st.cta ? ` (button: "${st.cta}")` : ""}`);
            }
        }
        if (cartAddressEvidence(st, target) === "full") {
            return { ok: true, how: "already_selected", addressText: st.text, evidence: "full" };
        }

        // 2) Deliver-to drawer → saved addresses
        if (remaining(opts.deadlineAt) < 15_000) return fail("open_sheet", "not enough time left to pick the address");
        if (!(await openDeliverToSheet(page, Math.min(opts.deadlineAt - 3_000, Date.now() + 8_000)))) {
            return fail("open_sheet", `Apollo's address picker didn't open (cart shows "${st.action || st.cta || "no address action"}")`);
        }
        await sleep(page, 600);
        let cards = await readSavedCards(page);
        let match = cards.find((c) => savedAddressMatches(c.text, target));
        if (!match && (await clickButtonByText(page, /^\s*view other saved address/i))) {
            await waitFor(page, Math.min(opts.deadlineAt - 3_000, Date.now() + 4_000), async () => (await readSavedCards(page)).length > cards.length, 400);
            cards = await readSavedCards(page);
            match = cards.find((c) => savedAddressMatches(c.text, target));
        }
        log("address_saved_cards", { count: cards.length, cards: cards.map((c) => c.text.slice(0, 90)), matched: match?.text.slice(0, 90) ?? null });

        if (match) {
            await say(`found your saved Apollo address ${target.line1} ${target.pincode} — selecting it…`);
            const desc = page.locator(SAVED_CARD_SEL).nth(match.index).locator(SAVED_DESC_SEL).first();
            const clickable = (await desc.count().catch(() => 0)) ? desc : page.locator(SAVED_CARD_SEL).nth(match.index);
            await clickable.click({ timeout: 4000 }).catch(async () => {
                await clickable.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
            });
            // Selected → drawer closes; no lat/long → Apollo opens its editor (/address-details).
            await waitFor(
                page,
                Math.min(opts.deadlineAt - 2_000, Date.now() + 10_000),
                async () => /\/address-details/i.test(safeUrl(page)) || !(await deliverToSheetOpen(page)),
                500,
            );
            if (!/\/address-details/i.test(safeUrl(page))) {
                const ok = await verifyCartSelected(page, target, opts.deadlineAt, 10_000);
                if (ok?.evidence === "full") return { ok: true, how: "selected_saved", addressText: ok.st.text, evidence: "full" };
                if (ok) return { ok: true, how: "selected_saved", addressText: match.text, evidence: "pending" };
                return fail("select_saved", "picked the saved address but Apollo's cart didn't show it as the delivery address");
            }
            log("address_saved_needs_update", {});
        } else {
            // 3) Add New Address → location search
            await say(`your Apollo account has no saved address for ${target.line1} — adding it (${target.pincode})…`);
            // No browser geolocation is granted (never a hard-coded location): the saved pin comes
            // only from the searched place for THIS recipient's address.
            if (!(await clickButtonByText(page, /^\s*add new address\s*$/i))) {
                return fail("add_new", "Apollo's address picker had no Add New Address button");
            }
            const searchOk = await waitFor(page, Math.min(opts.deadlineAt - 3_000, Date.now() + 8_000), async () =>
                page.locator(SEARCH_INPUT_SEL).first().isVisible(),
            );
            if (!searchOk) return fail("search_open", "Apollo's location search didn't open");
            let picked: string | null = null;
            for (const query of target.searchQueries) {
                if (remaining(opts.deadlineAt) < 25_000) break;
                const input = page.locator(SEARCH_INPUT_SEL).first();
                await input.fill("").catch(() => undefined);
                await input.fill(query).catch(() => undefined);
                const hasResults = await waitFor(
                    page,
                    Math.min(opts.deadlineAt - 3_000, Date.now() + 9_000),
                    async () => (await visibleCount(page, SEARCH_ITEM_SEL)) > 0 || /no result found/i.test(await page.evaluate(() => document.body.innerText).catch(() => "")),
                    500,
                );
                await sleep(page, 700); // let debounced results settle
                const items = hasResults
                    ? await page
                          .evaluate(
                              (sel) =>
                                  (Array.from(document.querySelectorAll(sel)) as HTMLElement[]).map((el, i) => ({
                                      i,
                                      visible: el.getBoundingClientRect().width > 0,
                                      // borderNone = Apollo's saved-address shortcut row, not a place result
                                      saved: /borderNone/.test(el.className || ""),
                                      text: (el.innerText || "").replace(/\s+/g, " ").trim(),
                                  })),
                              SEARCH_ITEM_SEL,
                          )
                          .catch(() => [])
                    : [];
                const best = pickSearchResult(items.filter((x) => x.visible && !x.saved), target);
                log("address_search", { query, best: best ? { text: best.text.slice(0, 100), score: best.score } : null });
                if (!best) continue;
                picked = best.text;
                const item = page.locator(SEARCH_ITEM_SEL).nth(best.i);
                await item.click({ timeout: 4000 }).catch(async () => {
                    await item.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
                });
                break;
            }
            if (!picked) return fail("search", `Apollo's location search found nothing for ${target.searchQueries.join(" / ")}`);
            const onForm = await waitFor(page, Math.min(opts.deadlineAt - 2_000, Date.now() + 15_000), async () => /\/address-details/i.test(safeUrl(page)), 500);
            if (!onForm) return fail("to_form", `picked "${picked.slice(0, 60)}" but Apollo didn't open the address form`);
        }
    }

    // 4) /address-details form (new address, or Apollo's editor for a saved one)
    const form = await fillAddressDetailsForm(page, target, opts);
    if (!form.ok) return fail(form.step, form.reason);
    const ok = await verifyCartSelected(page, target, opts.deadlineAt, 14_000);
    if (ok) {
        await say(`delivery address ${target.line1}, ${target.pincode} saved on Apollo ✓`);
        return ok.evidence === "full"
            ? { ok: true, how: "added_new", addressText: ok.st.text, evidence: "full" }
            : { ok: true, how: "added_new", addressText: target.line1, evidence: "pending" };
    }
    return fail("verify_new", "saved the address but Apollo's cart didn't show it as the delivery address");
}

const PIN_SEL = '#pincode, input[name="pincode"], input[aria-label="pincode"]';
const CITY_SEL = '#city, input[name="city"], input[aria-label="city"]';
const AREA_SEL = '#address2, input[name="address2"], input[aria-label="address2"]';
const LINE1_SEL = 'textarea[name="address1"], textarea[aria-label="address1"]';
const LANDMARK_SEL = '#landmark, input[name="landmark"], input[aria-label="landmark"]';
const NAME_SEL = 'input[name="recipientName"], input[aria-label="recipient name"]';
const CONTACT_SEL = 'input[name="recipientContact"], input[aria-label="recipient contact"]';

async function inputValue(page: Page, sel: string): Promise<string> {
    const loc = page.locator(sel).first();
    if (!(await loc.count().catch(() => 0))) return "";
    return ((await loc.inputValue({ timeout: 1500 }).catch(() => "")) || "").trim();
}

export async function fillAddressDetailsForm(
    page: Page,
    target: AddressTarget,
    opts: EnsureAddressOptions,
): Promise<{ ok: true } | { ok: false; step: string; reason: string }> {
    const log = opts.log ?? (() => undefined);
    const until = (ms: number) => Math.min(opts.deadlineAt - 2_000, Date.now() + ms);

    const ready = await waitFor(page, until(20_000), async () => {
        if (!(await page.locator(LINE1_SEL).first().isVisible().catch(() => false))) return false;
        return /^\d{6}$/.test(await inputValue(page, PIN_SEL));
    }, 600);
    const bodyNow = await page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => "");
    if (/delivery unavailable/i.test(bodyNow)) {
        return { ok: false, step: "form_serviceable", reason: "Apollo says it can't deliver medicines to that map location" };
    }
    if (!ready) return { ok: false, step: "form_load", reason: "Apollo's address form didn't load a pincode from the map" };

    const pin = await inputValue(page, PIN_SEL);
    const city = await inputValue(page, CITY_SEL);
    const area = await inputValue(page, AREA_SEL);
    log("address_form", { pin, city, area: area.slice(0, 80) });
    if (pin !== target.pincode) {
        return {
            ok: false,
            step: "form_pincode",
            reason: `Apollo's map put that location in pincode ${pin || "?"}, not ${target.pincode} — I didn't save it`,
        };
    }

    // House / flat line (+ area when Apollo's map area doesn't already say it)
    let line1 = target.line1;
    if (target.area && !normAddr(area).includes(normAddr(target.area))) line1 = `${line1}, ${target.area}`;
    const l1 = page.locator(LINE1_SEL).first();
    await l1.fill(line1.slice(0, 120)).catch(() => undefined);
    if (target.landmark) {
        const lm = page.locator(LANDMARK_SEL).first();
        if (await lm.isVisible().catch(() => false)) await lm.fill(target.landmark.slice(0, 60)).catch(() => undefined);
    }
    if (!(await l1.inputValue().catch(() => "")).trim()) {
        return { ok: false, step: "form_line1", reason: "couldn't type the flat / house line into Apollo's form" };
    }

    // Save & Next → Recipient Details
    const next = page.locator('button[aria-label="Save and proceed to next step"]').first();
    if (await next.isVisible().catch(() => false)) await next.click({ timeout: 3000 }).catch(() => undefined);
    else await clickButtonByText(page, /^\s*save\s*&\s*next\b/i);
    const tab2 = await waitFor(page, until(8_000), async () => page.locator(NAME_SEL).first().isVisible(), 400);
    if (!tab2) return { ok: false, step: "form_next", reason: "Apollo's form didn't move to Recipient Details" };

    // Save this address as: keep an already-active type, else HOME
    const typeActive = await page
        .evaluate(() => Array.from(document.querySelectorAll('button[name="addressType"]')).some((b) => /active/i.test((b as HTMLElement).className || "")))
        .catch(() => false);
    if (!typeActive) {
        const home = page.locator('button#HOME, button[aria-label="Select HOME as address type"]').first();
        if (await home.isVisible().catch(() => false)) await home.click({ timeout: 3000 }).catch(() => undefined);
    }

    // Recipient: care recipient's name from Kavach, else the name already on the Apollo account.
    const nameLoc = page.locator(NAME_SEL).first();
    const prefilledName = await inputValue(page, NAME_SEL);
    const wantName = (opts.recipientName || "").trim();
    if (wantName) await nameLoc.fill(wantName.slice(0, 40)).catch(() => undefined);
    const finalName = await inputValue(page, NAME_SEL);
    if (!finalName) return { ok: false, step: "form_name", reason: "no recipient name (none in Kavach and none on the Apollo account) — I won't invent one" };
    // Phone: keep Apollo's prefilled account phone; only fill it from the signed-in account number if empty.
    const contactLoc = page.locator(CONTACT_SEL).first();
    let contact = phone10(await inputValue(page, CONTACT_SEL));
    if (!/^[6-9]\d{9}$/.test(contact)) {
        const acct = phone10(opts.accountPhone);
        if (/^[6-9]\d{9}$/.test(acct)) await contactLoc.fill(acct).catch(() => undefined);
        contact = phone10(await inputValue(page, CONTACT_SEL));
    }
    if (!/^[6-9]\d{9}$/.test(contact)) return { ok: false, step: "form_phone", reason: "Apollo's form had no valid recipient phone" };
    log("address_recipient", { name: finalName === wantName ? "kavach_recipient" : prefilledName ? "apollo_account" : "?", phone: "account" });

    const save = page.locator('button[aria-label="Save Address"]').first();
    if (await save.isVisible().catch(() => false)) await save.click({ timeout: 4000 }).catch(() => undefined);
    else await clickButtonByText(page, /^\s*save address\s*$/i);
    const left = await waitFor(page, until(20_000), async () => {
        if (!/\/address-details/i.test(safeUrl(page))) return true;
        const t = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
        return /failed to (save|update) address|please (select one|enter)/i.test(t);
    }, 600);
    if (/\/address-details/i.test(safeUrl(page))) {
        const t = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => "");
        const err = t.match(/failed to (save|update) address|please select one from above|please enter [^\n.]{3,60}/i)?.[0];
        return { ok: false, step: "form_save", reason: err ? `Apollo said: ${err}` : left ? "Apollo didn't accept the address" : "Apollo didn't finish saving the address" };
    }
    return { ok: true };
}

/* ─────────────────────── confirm-address popup (after Proceed) ─────────────────────── */

export async function addressReviewPopupOpen(page: Page): Promise<boolean> {
    return page
        .evaluate(() => {
            const ex = document.querySelector('[class*="ConfirmCartAddressDialog_extraInfo"]') as HTMLElement | null;
            if (ex && ex.getBoundingClientRect().width > 0) return true;
            return /double-check the details so your order reaches the right hands/i.test(document.body.innerText || "");
        })
        .catch(() => false);
}

/**
 * Apollo's "Deliver to" confirm popup after cart Proceed: verify it shows the target address,
 * make sure recipient + phone are filled (never invented), then press its Proceed.
 */
export async function handleAddressReviewPopup(
    page: Page,
    target: Pick<AddressTarget, "pincode" | "flat" | "society">,
    opts: { recipientName?: string; accountPhone?: string; log?: EnsureAddressOptions["log"] },
): Promise<{ ok: true; text: string } | { ok: false; reason: string; text: string; mismatch?: boolean }> {
    const info = await page
        .evaluate(() => {
            const extra =
                (document.querySelector('[class*="ConfirmCartAddressDialog_extraInfo"]') as HTMLElement | null) ||
                (Array.from(document.querySelectorAll("div")).find((d) =>
                    /^\s*double-check the details/i.test((d as HTMLElement).innerText || ""),
                )?.parentElement as HTMLElement | null) ||
                null;
            let box: HTMLElement | null = extra;
            while (
                box &&
                box !== document.body &&
                !Array.from(box.querySelectorAll("button")).some((b) => /^\s*proceed\s*$/i.test((b as HTMLElement).innerText || ""))
            ) {
                box = box.parentElement;
            }
            // Never fall back to <body> (the cart's own Proceed lives there).
            const root = box && box !== document.body ? box : null;
            if (!root) return null;
            root.setAttribute("data-kavach-review", "1");
            return { text: (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600) };
        })
        .catch(() => null);
    if (!info) return { ok: false, reason: "couldn't read Apollo's delivery-address popup", text: "" };
    opts.log?.("address_review", { text: info.text.replace(/\b[6-9]\d{9}\b/g, "[phone]").slice(0, 200) });
    if (!savedAddressMatches(info.text, target)) {
        return {
            ok: false,
            mismatch: true,
            reason: `Apollo's delivery popup shows a different address (needs ${target.pincode} ${target.flat || target.society || ""})`,
            text: info.text,
        };
    }
    const root = page.locator('[data-kavach-review="1"]').first();
    const inputs = root.locator("input");
    const nameIn = root.locator('input[type="text"], input:not([type])').first();
    const telIn = root.locator('input[type="tel"], input[name="recipientContact"]').first();
    if ((await inputs.count().catch(() => 0)) > 0) {
        const nm = ((await nameIn.inputValue().catch(() => "")) || "").trim();
        if (!nm && opts.recipientName?.trim()) await nameIn.fill(opts.recipientName.trim().slice(0, 40)).catch(() => undefined);
        if (!((await nameIn.inputValue().catch(() => "")) || "").trim()) {
            return { ok: false, reason: "Apollo's delivery popup has no recipient name and I won't invent one", text: info.text };
        }
        let tel = phone10(await telIn.inputValue().catch(() => ""));
        if (!/^[6-9]\d{9}$/.test(tel) && /^[6-9]\d{9}$/.test(phone10(opts.accountPhone))) {
            await telIn.fill(phone10(opts.accountPhone)).catch(() => undefined);
            tel = phone10(await telIn.inputValue().catch(() => ""));
        }
        if (!/^[6-9]\d{9}$/.test(tel)) return { ok: false, reason: "Apollo's delivery popup has no valid recipient phone", text: info.text };
    }
    const btn = root.locator("button").filter({ hasText: /^\s*proceed\s*$/i }).first();
    if (!(await btn.isVisible().catch(() => false))) return { ok: false, reason: "no Proceed button on Apollo's delivery popup", text: info.text };
    await btn.click({ timeout: 4000 }).catch(async () => {
        await btn.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
    });
    return { ok: true, text: info.text };
}

/** On the "Deliver to" popup: press its own "Change Address" (opens the Deliver-to drawer). */
export async function clickReviewChangeAddress(page: Page, until: number): Promise<boolean> {
    const root = page.locator('[data-kavach-review="1"]').first();
    const btn = root.locator("button, [role='button'], span").filter({ hasText: /^\s*change\s*address\s*$/i }).first();
    if (!(await btn.isVisible().catch(() => false))) return false;
    await btn.click({ timeout: 3000 }).catch(async () => {
        await btn.evaluate((e) => (e as HTMLElement).click()).catch(() => undefined);
    });
    return waitFor(page, until, () => deliverToSheetOpen(page));
}
