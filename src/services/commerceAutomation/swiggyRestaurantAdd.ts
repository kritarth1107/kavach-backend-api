/**
 * Fixed, scripted Swiggy restaurant step (no model): on a restaurant page (`…-rest<id>`),
 * find the CONFIRMED dish by name via the in-restaurant search, tap ADD, accept the
 * customisation popup with its defaults (never ticks paid add-ons; unticks any that are
 * ticked) and go to the cart. Gemini / Stagehand only run if this returns ok=false.
 *
 * Verified 2026-09-26 as a guest on Theobroma Shankar Nagar, Raipur
 * ("Choco-Vanilla Oreo Cake [540g]") — search → ADD → "Add Item to cart" → cart.
 * It never logs in, never touches payment and never places an order.
 */
import type { Page } from "playwright";

export type SwiggyAddResult = {
    ok: boolean;
    /** Short machine reason when ok=false (goes to logs / lastSteps). */
    reason?: string;
    /** Dish name as shown on Swiggy (when found). */
    matchedName?: string;
    /** Price shown on the customisation popup's Add button (₹), when there was one. */
    popupTotalRupees?: number;
    steps: string[];
};

export function isSwiggyRestaurantUrl(url: string | undefined | null): boolean {
    return /swiggy\.com\/.*-rest\d+/i.test(String(url || ""));
}

/** Dish name from the exact-SKU goal ("Order exact SKU from Swiggy: <name> @ ₹495 | restaurant=…"). */
export function dishFromGoal(goal: string): string | null {
    const m = goal.match(/exact SKU from [^:]+:\s*(.+?)(?:\s+@\s+(?:₹|Rs\.?)\s*[\d,.]+|\s*\||$)/i);
    const name = m?.[1]?.trim();
    return name && name.length >= 2 ? name.slice(0, 120) : null;
}

export function normDish(s: string): string {
    return s
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

/** Pick the best dish-card name for the wanted dish (exact normalised match first). */
export function pickDishName(names: string[], wanted: string): string | null {
    const w = normDish(wanted);
    if (!w) return null;
    const exact = names.find((n) => normDish(n) === w);
    if (exact) return exact;
    const wt = w.split(" ").filter((t) => t.length >= 2);
    let best: { n: string; s: number } | null = null;
    for (const n of names) {
        const nt = new Set(normDish(n).split(" "));
        const hit = wt.filter((t) => nt.has(t)).length;
        const extra = [...nt].filter((t) => !wt.includes(t)).length;
        const s = hit / wt.length - extra * 0.05;
        if (!best || s > best.s) best = { n, s };
    }
    // Every token of the wanted name must be present (size/weight like "540g" included).
    return best && best.s >= 0.95 ? best.n : null;
}

async function nap(page: Page, ms: number): Promise<void> {
    await page.waitForTimeout(ms).catch(() => undefined);
}

async function dishNames(page: Page): Promise<string[]> {
    return (await page
        .locator('[data-testid="normal-dish-item"]')
        .evaluateAll((els) =>
            els.slice(0, 150).map((e) => {
                const img = e.querySelector("img[alt]") as HTMLImageElement | null;
                const p = (e.querySelector("p") as HTMLElement | null)?.innerText || "";
                const fromP = p.match(/^(?:Veg Item|Non-veg item)\.\s*(.+?)\.\s*(?:This item|Costs)/i)?.[1];
                return (img?.alt || fromP || "").trim();
            }),
        )
        .catch(() => [])) as string[];
}

async function cartCount(page: Page): Promise<number> {
    const t = (await page
        .evaluate(() => {
            const a = Array.from(document.querySelectorAll("a,div,span")).find(
                (e) => /^\s*\d+\s*Cart\s*$/i.test((e as HTMLElement).innerText || "") && (e as HTMLElement).innerText.length < 20,
            ) as HTMLElement | undefined;
            return a?.innerText || "";
        })
        .catch(() => "")) as string;
    const n = Number(t.match(/(\d+)/)?.[1]);
    return Number.isFinite(n) ? n : 0;
}

export async function swiggyScriptedAddToCart(
    page: Page,
    opts: {
        dish: string;
        isCancelled?: () => boolean;
        log?: (event: string, extra?: Record<string, unknown>) => void;
        /** Go to the cart page after adding (default true). */
        openCart?: boolean;
    },
): Promise<SwiggyAddResult> {
    const steps: string[] = [];
    const log = opts.log ?? (() => undefined);
    const step = (s: string, extra?: Record<string, unknown>) => {
        steps.push(s);
        log(`swiggy_scripted_${s}`, extra);
    };
    const cancelled = () => Boolean(opts.isCancelled?.());
    const fail = (reason: string): SwiggyAddResult => {
        step(`fail:${reason}`);
        return { ok: false, reason, steps };
    };

    if (!isSwiggyRestaurantUrl(page.url())) return fail("not_restaurant_page");
    // Menu is client-rendered: wait for dish cards.
    const loaded = await page
        .waitForSelector('[data-testid="normal-dish-item"]', { timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
    if (!loaded) return fail("menu_not_loaded");
    const body = ((await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string).slice(0, 4000);
    if (/currently closed|not accepting orders|closed\s*&\s*not delivering|currently not taking orders/i.test(body)) {
        return fail("restaurant_closed");
    }
    if (cancelled()) return fail("cancelled");
    const before = await cartCount(page);
    if (before > 0) step("cart_not_empty_before", { count: before });

    const findAdd = async (name: string) => {
        const byImg = page
            .locator('[data-testid="normal-dish-item"]')
            .filter({ has: page.locator(`img[alt="${name.replace(/"/g, '\\"')}"]`) })
            .first();
        const byText = page.locator('[data-testid="normal-dish-item"]').filter({ hasText: name }).first();
        const target = (await byImg.count().catch(() => 0)) ? byImg : byText;
        await target.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => undefined);
        let add = target.locator("button.add-button-center-container").first();
        if (!(await add.isVisible().catch(() => false))) add = target.getByRole("button", { name: /^\s*add\s*$/i }).first();
        return (await add.isVisible().catch(() => false)) ? add : null;
    };

    // 1) Visible on the menu already (e.g. Bestseller / open category)?
    let match = pickDishName(await dishNames(page), opts.dish);
    let add = match ? await findAdd(match) : null;
    if (!add) {
        // 2) In-restaurant search ("Search for dishes") — works for collapsed categories too.
        const btn = page.locator('[data-cy="menu-search-button"], button[aria-label*="Search items" i]').first();
        if (await btn.count().catch(() => 0)) {
            await btn.click({ timeout: 6000 }).catch(() => undefined);
            await nap(page, 1200);
        }
        const input = page.locator('input[data-cy="menu-search-header"], input[placeholder*="Search in" i]').first();
        if (!(await input.isVisible({ timeout: 6000 }).catch(() => false))) return fail("no_menu_search");
        const q = opts.dish.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s*\([^)]*\)\s*/g, " ").trim() || opts.dish;
        await input.fill(q.slice(0, 60));
        step("searched", { q: q.slice(0, 60) });
        match = null;
        for (let i = 0; i < 10 && !add; i++) {
            await nap(page, 900);
            match = pickDishName(await dishNames(page), opts.dish);
            if (match) add = await findAdd(match);
        }
    }
    if (!match) return fail("dish_not_found");
    step("found", { name: match.slice(0, 80) });
    if (!add) return fail("add_button_missing");
    if (cancelled()) return fail("cancelled");
    await add.click({ timeout: 6000 });
    step("add_clicked");
    await nap(page, 1500);

    let popupTotalRupees: number | undefined;
    for (let i = 0; i < 4; i++) {
        if (cancelled()) return fail("cancelled");
        const dlg = page.locator('[role="dialog"][aria-modal="true"], [role="dialog"]').last();
        if (!(await dlg.isVisible().catch(() => false))) break;
        const text = ((await dlg.innerText().catch(() => "")) || "").replace(/\s+/g, " ");
        // Different restaurant already in cart → start afresh with only this dish.
        if (/items already in cart|replace cart item|start afresh|discard/i.test(text)) {
            const fresh = dlg.locator("button").filter({ hasText: /yes,?\s*start afresh|start afresh|replace/i }).first();
            if (await fresh.isVisible().catch(() => false)) {
                await fresh.click({ timeout: 5000 }).catch(() => undefined);
                step("start_afresh");
                await nap(page, 1500);
                continue;
            }
        }
        // "Repeat last used customisation?" → make a fresh choice (defaults only).
        const choose = dlg.locator("button").filter({ hasText: /i'?ll choose|choose again|add new/i }).first();
        if (/repeat/i.test(text) && (await choose.isVisible().catch(() => false))) {
            await choose.click({ timeout: 5000 }).catch(() => undefined);
            step("repeat_choose_new");
            await nap(page, 1200);
            continue;
        }
        // Customisation: untick every ticked paid add-on checkbox (radios = required defaults, left alone).
        const boxes = dlg.locator('input[type="checkbox"]');
        const n = await boxes.count().catch(() => 0);
        let unticked = 0;
        for (let k = 0; k < n; k++) {
            const b = boxes.nth(k);
            if (await b.isChecked().catch(() => false)) {
                await b.uncheck({ force: true, timeout: 3000 }).catch(() => undefined);
                unticked++;
            }
        }
        if (unticked) step("unticked_addons", { count: unticked });
        const cont = dlg
            .locator("button")
            .filter({ hasText: /^\s*(add item to cart|add item|add to cart|continue|confirm)\s*$/i })
            .last();
        if (!(await cont.isVisible().catch(() => false))) return fail("customise_no_add_button");
        const totalTxt = text.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:Add Item|Add to cart|Continue)/i)?.[1];
        if (totalTxt) popupTotalRupees = Number(totalTxt.replace(/,/g, ""));
        await cont.click({ timeout: 6000 }).catch(() => undefined);
        step("customise_accepted", { total: popupTotalRupees ?? null });
        await nap(page, 1500);
    }

    // Verify the cart picked it up (header badge or View Cart bar).
    let after = 0;
    for (let i = 0; i < 6; i++) {
        after = await cartCount(page);
        if (after > before) break;
        const bar = await page.getByText(/view cart/i).first().isVisible().catch(() => false);
        if (bar) {
            after = Math.max(after, before + 1);
            break;
        }
        await nap(page, 700);
    }
    if (after <= before && before === 0) return fail("not_added");
    step("added", { cart: after });

    if (opts.openCart !== false) {
        await page.goto("https://www.swiggy.com/checkout", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        await nap(page, 2500);
        step("cart_opened");
    }
    return { ok: true, matchedName: match, popupTotalRupees, steps };
}

export type SwiggyLoginResult =
    | { status: "otp_sent"; steps: string[] }
    | { status: "already_signed_in"; steps: string[] }
    | { status: "failed"; reason: string; steps: string[] };

/** True when Swiggy's checkout shows the guest "Account — LOG IN / SIGN UP" block. */
export async function swiggyNeedsLogin(page: Page): Promise<boolean> {
    const t = ((await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string).slice(0, 3000);
    return /To place your order now, log in/i.test(t) || /Have an account\?\s*LOG IN/i.test(t);
}

/**
 * Fixed Swiggy checkout login (verified as guest 2026-09-26 up to the phone field only):
 * "Have an account? LOG IN" (a <div>) → input#mobile (10 digits) → "Login" (an <a>) →
 * Swiggy texts the OTP → OTP box visible. `claimOtpSend` must return true exactly once per
 * order so the SMS is requested only once; nothing here ever pays or places.
 */
export async function swiggyScriptedLogin(
    page: Page,
    opts: {
        loginPhone: string;
        claimOtpSend: () => boolean;
        isCancelled?: () => boolean;
        log?: (event: string, extra?: Record<string, unknown>) => void;
    },
): Promise<SwiggyLoginResult> {
    const steps: string[] = [];
    const log = opts.log ?? (() => undefined);
    const step = (s: string, extra?: Record<string, unknown>) => {
        steps.push(s);
        log(`swiggy_login_${s}`, extra);
    };
    const fail = (reason: string): SwiggyLoginResult => {
        step(`fail:${reason}`);
        return { status: "failed", reason, steps };
    };
    const phone10 = opts.loginPhone.replace(/\D/g, "").slice(-10);
    if (phone10.length !== 10) return fail("no_login_phone");
    if (!/swiggy\.com\/checkout/i.test(page.url())) {
        await page.goto("https://www.swiggy.com/checkout", { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        await nap(page, 2500);
    }
    if (!(await swiggyNeedsLogin(page))) {
        step("already_signed_in");
        return { status: "already_signed_in", steps };
    }
    const mobile = page.locator('input#mobile, input[name="mobile"]').first();
    if (!(await mobile.isVisible().catch(() => false))) {
        await page.getByText("LOG IN", { exact: true }).first().click({ timeout: 8000 }).catch(() => undefined);
        step("login_opened");
    }
    if (!(await mobile.isVisible({ timeout: 8000 }).catch(() => false))) {
        await mobile.waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
    }
    if (!(await mobile.isVisible().catch(() => false))) return fail("no_phone_field");
    if (opts.isCancelled?.()) return fail("cancelled");
    await mobile.fill(phone10);
    step("phone_entered");
    if (!opts.claimOtpSend()) return fail("otp_already_requested");
    const submit = page.locator("a, button").filter({ hasText: /^\s*(login|log in|continue)\s*$/i });
    let clicked = false;
    const n = Math.min(await submit.count().catch(() => 0), 6);
    for (let i = 0; i < n && !clicked; i++) {
        if (await submit.nth(i).isVisible().catch(() => false)) {
            clicked = await submit.nth(i).click({ timeout: 5000 }).then(() => true).catch(() => false);
        }
    }
    if (!clicked) await mobile.press("Enter").catch(() => undefined);
    step("login_clicked", { via: clicked ? "link" : "enter" });
    // OTP box = Swiggy sent the SMS. Sign-up form (name/email) = no Swiggy account on this number.
    const until = Date.now() + 20_000;
    while (Date.now() < until) {
        if (opts.isCancelled?.()) return fail("cancelled");
        const otpBox = page.locator('input#otp, input[name="otp"], input[autocomplete="one-time-code"]').first();
        if (await otpBox.isVisible().catch(() => false)) {
            step("otp_sent");
            return { status: "otp_sent", steps };
        }
        const t = ((await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string).slice(0, 3000);
        if (/enter (your )?name|email address/i.test(t) && /sign\s*up/i.test(t) && !/one time password|otp/i.test(t)) {
            return fail("no_swiggy_account");
        }
        if (/enter a valid (phone|mobile)|invalid (phone|mobile)/i.test(t)) return fail("phone_rejected");
        if (/too many (attempts|requests)|try again later/i.test(t)) return fail("rate_limited");
        await nap(page, 800);
    }
    return fail("otp_screen_not_shown");
}
