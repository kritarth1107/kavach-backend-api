/**
 * Apollo cart cleanup + exactly-one-item guard — NO OTP, NO real order, NO real Apollo traffic.
 *
 * A mocked Apollo site (same class names / flows as www.apollopharmacy.in: cart line cards with
 * dustbin, PDP buy box, /delivery-options, /pay COD card, /order-status) is served through
 * Playwright request interception. EVERY other request is aborted, and any URL mentioning
 * otp / login / generateOtp fails the test.
 *
 *   npx tsx scripts/test-apollo-cart-guard.ts
 */
import assert from "node:assert/strict";
import { chromium, type BrowserContext, type Route } from "playwright";
import {
    cartLineMatchesSku,
    checkCartExactlySku,
    snapshotFromDom,
} from "../src/services/commerceAutomation/apolloPostOtp";
import {
    CART_REMOVE_BLOCK_RE,
    describeClickTarget,
    runApolloCodCheckout,
} from "../src/services/commerceAutomation/apolloCheckout";
import { apolloExactSkuToConfirm } from "../src/services/commerceAutomation/browserWorker.service";

const BASE = "https://www.apollopharmacy.in";
const TARGET = {
    sku: "APR0111",
    name: "Apollo Life Premium Citrus Refreshing Wet Wipes, Pack of 2 (2x30)",
    slug: "apollo-pharmacy-refreshing-wipes-citrus-30s",
    price: 99.2,
};
const GOAL =
    `Order exact SKU from Apollo: ${TARGET.name} (2x30 Wipes · Pack) @ ₹99.20` +
    ` | delivery_address=C504, Sunita Park, Raipur, Chhattisgarh 492001`;
const ADDRESS = "C504, Sunita Park, Raipur, Chhattisgarh 492001";

type Line = { sku: string; name: string; qty: number; price: number };
type MockState = {
    cart: Line[];
    failRemoval: boolean;
    /** Simulate another device adding an item once the /pay page is reached. */
    injectOnPay?: Line;
    saveCalls: Array<{ sku: string; quantity: number }>;
    placeClicks: number;
    requests: string[];
    forbidden: string[];
};

function newState(cart: Line[]): MockState {
    return { cart, failRemoval: false, saveCalls: [], placeClicks: 0, requests: [], forbidden: [] };
}

const DOLO: Line = { sku: "DOL0026", name: "Dolo 650 Tablet 15's", qty: 2, price: 33.8 };
const NEEM: Line = { sku: "HIM0021", name: "Himalaya Purifying Neem Face Wash, 150 ml", qty: 1, price: 199 };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const total = (st: MockState) => st.cart.reduce((a, l) => a + l.qty * l.price, 0);

function page(title: string, body: string, script = ""): string {
    return `<!doctype html><html><head><title>${title}</title></head><body>
<header><a href="/medicines-cart" class="cartIcon">Cart</a><span>Delivery Address Raipur 492001</span></header>
<main id="app">${body}</main><script>${script}</script></body></html>`;
}

function cartPage(): string {
    return page(
        "Your Cart | Apollo Pharmacy",
        `<div id="cart">Loading…</div>
<section><h3>LAST MINUTE BUYS</h3>
<div class="ProductCard_root__rec"><h2 class="ProductCard_title__rec">Apollo Life Anti-Bac Wet Wipes, Pack of 2 (2x30 Wipes)</h2><button>ADD</button></div>
<div class="ProductCard_root__rec"><h2 class="ProductCard_title__rec">Dolo 650 Tablet 15's</h2><button>ADD</button></div></section>`,
        `
async function load(){
  const r = await fetch('/__mock/cart'); const s = await r.json();
  const el = document.getElementById('cart');
  if (!s.cart.length) { el.innerHTML = '<h1>YOUR CART</h1><p>YOUR CART IS EMPTY</p><a>GO TO PHARMACY</a>'; return; }
  el.innerHTML = '<h1>YOUR CART</h1><p>' + s.cart.length + ' ITEM' + (s.cart.length>1?'S':'') + ' IN YOUR CART</p>' +
    '<p>Deliver to: C504, Sunita Park, Raipur 492001</p>' +
    s.cart.map(l => '<div class="MedicineProductCard_root__udJYP"><div class="MedicineProductCard_titleBx__V"><h2 class="MedicineProductCard_title__MJ4MD">' + l.name +
      '</h2><div style="display:inline-block;width:20px;height:20px;background:#c00" class="dustbicIcon__ZxLJZ MedicineProductCard_deleteIcon__LWTJ9" data-sku="' + l.sku + '"><span></span></div></div>' +
      '<p class="MedicineProductCard_subTitle__C">Pack of 1</p><p class="MedicineProductCard_text__lcvKS">Qty ' + l.qty + '</p></div>').join('') +
    '<h3>Cart Breakdown</h3><p>Total Bill Incl. charges</p><p>' + (s.total+30).toFixed(2) + '</p><p>' + s.total.toFixed(2) + '</p>' +
    '<p>Amount to pay</p><p>₹' + s.total.toFixed(2) + '</p><button title="Proceed" id="proceed">Proceed</button>';
  el.querySelectorAll('[class*="deleteIcon"]').forEach(d => d.addEventListener('click', async () => {
    await fetch('/__mock/save-cart', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ sku: d.dataset.sku, quantity: 0 }) });
    setTimeout(load, 300);
  }));
  const p = document.getElementById('proceed'); if (p) p.addEventListener('click', () => { location.href = '/delivery-options'; });
}
setTimeout(load, 400);`,
    );
}

function pdpPage(line: Line): string {
    return page(
        line.name,
        `<h1>${esc(line.name)}</h1>
<div class="buyBox"><p>₹${line.price}</p><p>(Inclusive of all Taxes)</p><p>Delivering to 492001 Change — Delivery by tomorrow</p>
<div id="cta"><button id="add">Add to Cart</button></div></div>`,
        `
document.getElementById('add').addEventListener('click', async () => {
  await fetch('/__mock/save-cart', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ sku: ${JSON.stringify(line.sku)}, quantity: 1 }) });
  document.getElementById('cta').innerHTML = '<p>1 item ₹${line.price}</p><a href="/medicines-cart">View Cart</a>';
});`,
    );
}

function deliveryPage(): string {
    return page(
        "Delivery options",
        `<h2>Choose delivery type</h2><p>Delivering to C504, Sunita Park, Raipur, Chhattisgarh 492001</p><button id="go">PROCEED</button>`,
        `document.getElementById('go').addEventListener('click', () => { location.href = '/pay/9001'; });`,
    );
}

function payPage(st: MockState): string {
    const t = total(st).toFixed(2);
    return page(
        "Payment",
        `<h2>Payment options</h2><p>Amount to pay ₹${t}</p><p>Delivering to 492001</p>
<div class="codContainer__a"><div class="codCard__b"><div role="button" id="codHead">Pay on Delivery</div><input type="radio" id="checkbox-cod"></div>
<button id="place" aria-label="Pay rupees ${t}">Place order for ₹${t}</button></div>`,
        `
document.getElementById('codHead').addEventListener('click', () => { document.getElementById('checkbox-cod').checked = true; });
document.getElementById('place').addEventListener('click', async () => {
  await fetch('/__mock/place', { method: 'POST' });
  location.href = '/order-status/TXN77/success';
});`,
    );
}

async function installMock(ctx: BrowserContext, st: MockState): Promise<void> {
    await ctx.route("**/*", async (route: Route) => {
        const req = route.request();
        const url = req.url();
        st.requests.push(`${req.method()} ${url}`);
        if (/otp|login|signin|generateotp/i.test(url)) {
            st.forbidden.push(url);
            return route.abort();
        }
        if (!url.startsWith(BASE)) return route.abort();
        const path = new URL(url).pathname;
        const html = (body: string) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
        const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
        if (path === "/__mock/cart") return json({ cart: st.cart, total: total(st) });
        if (path === "/__mock/save-cart") {
            const b = JSON.parse(req.postData() || "{}") as { sku: string; quantity: number };
            st.saveCalls.push(b);
            if (b.quantity === 0) {
                if (st.failRemoval) return json({ error: "remove failed" }, 500);
                st.cart = st.cart.filter((l) => l.sku !== b.sku);
            } else {
                const ex = st.cart.find((l) => l.sku === b.sku);
                if (ex) ex.qty = b.quantity;
                else st.cart.push({ sku: b.sku, name: b.sku === TARGET.sku ? TARGET.name : b.sku, qty: b.quantity, price: TARGET.price });
            }
            return json({ ok: true });
        }
        if (path === "/__mock/place") {
            st.placeClicks++;
            return json({ ok: true });
        }
        if (path === "/medicines-cart") return html(cartPage());
        if (path === `/otc/${TARGET.slug}`) return html(pdpPage({ sku: TARGET.sku, name: TARGET.name, qty: 1, price: TARGET.price }));
        if (path === "/delivery-options") return html(deliveryPage());
        if (path.startsWith("/pay/")) {
            if (st.injectOnPay && !st.cart.some((l) => l.sku === st.injectOnPay!.sku)) st.cart.push(st.injectOnPay);
            return html(payPage(st));
        }
        if (path.startsWith("/order-status/")) return html(page("Order", `<h1>Order placed</h1><p>Order ID(s) : 12345678</p>`));
        return html(page("Apollo", "<p>home</p>"));
    });
}

async function withPage<T>(st: MockState, fn: (p: import("playwright").Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch({ headless: true });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await installMock(ctx, st);
        const p = await ctx.newPage();
        return await fn(p);
    } finally {
        await browser.close();
    }
}

function assertNoLeaks(st: MockState): void {
    assert.deepEqual(st.forbidden, [], "no OTP / login traffic");
    const external = st.requests.filter((r) => !r.split(" ")[1]!.startsWith(BASE));
    assert.deepEqual(external, [], "no traffic outside the mocked Apollo site");
}

async function main() {
    // ── Pure unit checks ────────────────────────────────────────────────────
    assert.ok(cartLineMatchesSku(TARGET.name, `${TARGET.name} (2x30 Wipes · Pack)`));
    assert.ok(!cartLineMatchesSku("Apollo Life Anti-Bac Wet Wipes, Pack of 2 (2x30 Wipes)", `${TARGET.name} (2x30 Wipes · Pack)`));
    assert.ok(!cartLineMatchesSku("Dolo 650 Tablet 15's", TARGET.name));
    const one = snapshotFromDom({ lines: [{ name: TARGET.name, qtyText: "Qty 1" }], bodyText: "YOUR CART 1 ITEM IN YOUR CART" });
    assert.equal(checkCartExactlySku(one, TARGET.name).ok, true);
    const two = snapshotFromDom({
        lines: [{ name: TARGET.name, qtyText: "Qty 1" }, { name: DOLO.name, qtyText: "Qty 2" }],
        bodyText: "2 ITEMS IN YOUR CART",
    });
    assert.equal(checkCartExactlySku(two, TARGET.name).ok, false);
    const qty2 = snapshotFromDom({ lines: [{ name: TARGET.name, qtyText: "Qty 2" }], bodyText: "1 ITEM IN YOUR CART" });
    assert.equal(checkCartExactlySku(qty2, TARGET.name).ok, false);
    assert.equal(snapshotFromDom({ lines: [], bodyText: "YOUR CART IS EMPTY" }).state, "empty");
    assert.equal(snapshotFromDom({ lines: [], bodyText: "Loading…" }).state, "unknown");
    assert.equal(checkCartExactlySku(snapshotFromDom({ lines: [], bodyText: "Loading…" }), TARGET.name).ok, false);
    console.log("✓ unit: line match / exactly-one guard / snapshot states");

    // ── 1) Cart has 2 other items → removed → empty → target added ×1 → confirm card ──
    {
        const st = newState([{ ...DOLO }, { ...NEEM }]);
        const progress: string[] = [];
        const res = await withPage(st, (p) =>
            apolloExactSkuToConfirm({
                page: p,
                goal: GOAL,
                productUrl: `${BASE}/otc/${TARGET.slug}`,
                deliveryAddress: ADDRESS,
                deadlineAt: Date.now() + 85_000,
                progress: async (d) => {
                    progress.push(d);
                },
            }),
        );
        assert.ok(res, "deterministic path returned");
        assert.equal(res!.status, "need_user_confirm", res!.message);
        assert.deepEqual(st.cart.map((l) => [l.sku, l.qty]), [[TARGET.sku, 1]], "cart = exactly the target ×1");
        assert.deepEqual(
            st.saveCalls.filter((c) => c.quantity === 0).map((c) => c.sku).sort(),
            [DOLO.sku, NEEM.sku].sort(),
            "both pre-existing lines removed via Apollo's own dustbin (save-cart qty 0)",
        );
        assert.ok(progress.some((d) => /your Apollo cart had 2 other items — removed ✓/.test(d)), progress.join(" | "));
        assert.match(res!.message, /Cart: only this item, qty 1 ✓/);
        assert.match(res!.message, /Removed 2 other items/);
        assert.equal(st.placeClicks, 0);
        assertNoLeaks(st);
        console.log("✓ scenario 1: 2 pre-existing items removed, cart verified empty, target added ×1, card sent");
        console.log("  progress:", JSON.stringify(progress));
        console.log("  card:\n" + res!.message.split("\n").map((l) => "    " + l).join("\n"));
    }

    // ── 2) Removal fails → stop honestly, nothing added, no card ──
    {
        const st = newState([{ ...DOLO }, { ...NEEM }]);
        st.failRemoval = true;
        const res = await withPage(st, (p) =>
            apolloExactSkuToConfirm({
                page: p,
                goal: GOAL,
                productUrl: `${BASE}/otc/${TARGET.slug}`,
                deliveryAddress: ADDRESS,
                deadlineAt: Date.now() + 85_000,
            }),
        );
        assert.ok(res);
        assert.equal(res!.status, "error");
        assert.equal(res!.failureReason, "cart_not_empty");
        assert.ok(!st.cart.some((l) => l.sku === TARGET.sku), "target never added");
        assert.ok(!st.saveCalls.some((c) => c.quantity > 0), "no add call");
        assert.equal(st.placeClicks, 0);
        assert.match(res!.message, /nothing was ordered or paid/i);
        assertNoLeaks(st);
        console.log("✓ scenario 2: removal failed → no card, nothing added/placed");
        console.log("  message: " + res!.message.replace(/\n/g, " / "));
    }

    // ── 3a) Extra item already in the cart at checkout → stop before Proceed ──
    {
        const st = newState([{ sku: TARGET.sku, name: TARGET.name, qty: 1, price: TARGET.price }, { ...DOLO }]);
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return runApolloCodCheckout(p, {
                deadlineAt: Date.now() + 60_000,
                pincode: "492001",
                addressHints: ["C504", "Sunita Park"],
                confirmedTotalRupees: 99.2,
                skuName: `${TARGET.name} (2x30 Wipes · Pack)`,
                geminiMaxSteps: 0,
            });
        });
        assert.equal(out.status, "cart_mismatch", JSON.stringify(out));
        assert.equal(st.placeClicks, 0);
        assert.ok(!st.requests.some((r) => /\/delivery-options|\/pay\//.test(r)), "never left the cart");
        assertNoLeaks(st);
        console.log("✓ scenario 3a: extra item in cart at checkout → cart_mismatch before Proceed, no Place order");
    }

    // ── 3b) Extra item appears after Proceed (on /pay) → fresh-tab re-check → no Place order ──
    {
        const st = newState([{ sku: TARGET.sku, name: TARGET.name, qty: 1, price: TARGET.price }]);
        st.injectOnPay = { ...NEEM };
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return runApolloCodCheckout(p, {
                deadlineAt: Date.now() + 70_000,
                pincode: "492001",
                addressHints: ["C504", "Sunita Park"],
                confirmedTotalRupees: 500, // amount check alone would NOT stop it
                skuName: `${TARGET.name} (2x30 Wipes · Pack)`,
                geminiMaxSteps: 0,
            });
        });
        assert.equal(out.status, "cart_mismatch", JSON.stringify(out));
        assert.equal(st.placeClicks, 0, "Place order never clicked");
        assert.ok(st.requests.some((r) => /\/pay\//.test(r)), "reached /pay");
        assertNoLeaks(st);
        console.log("✓ scenario 3b: extra item appeared at /pay → cart_mismatch right before Place order, no click");
        console.log("  detail: " + out.detail);
    }

    // ── 4) Control: exact cart → mock Place order clicked once (mock only) ──
    {
        const st = newState([{ sku: TARGET.sku, name: TARGET.name, qty: 1, price: TARGET.price }]);
        const out = await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            return runApolloCodCheckout(p, {
                deadlineAt: Date.now() + 70_000,
                pincode: "492001",
                addressHints: ["C504", "Sunita Park"],
                confirmedTotalRupees: 99.2,
                skuName: `${TARGET.name} (2x30 Wipes · Pack)`,
                geminiMaxSteps: 0,
            });
        });
        assert.equal(out.status, "placed", JSON.stringify(out));
        assert.equal(st.placeClicks, 1);
        assertNoLeaks(st);
        console.log("✓ scenario 4 (control): exact 1-item cart → mock COD Place order clicked exactly once");
    }

    // ── 5) Gemini click guard: Apollo's dustbin is never clickable by the model ──
    {
        const st = newState([{ ...DOLO }]);
        await withPage(st, async (p) => {
            await p.goto(`${BASE}/medicines-cart`);
            await p.waitForSelector('[class*="deleteIcon"]');
            const bySel = await describeClickTarget(p, { selector: '[class*="MedicineProductCard_deleteIcon"]' });
            const box = (await p.locator('[class*="deleteIcon"]').first().boundingBox())!;
            const vp = p.viewportSize()!;
            const byXY = await describeClickTarget(p, {
                x: ((box.x + box.width / 2) / vp.width) * 1000,
                y: ((box.y + box.height / 2) / vp.height) * 1000,
            });
            const proceed = await describeClickTarget(p, { selector: "#proceed" });
            assert.ok(CART_REMOVE_BLOCK_RE.test(bySel), bySel);
            assert.ok(CART_REMOVE_BLOCK_RE.test(byXY), byXY);
            assert.ok(!CART_REMOVE_BLOCK_RE.test(proceed), proceed);
        });
        assert.ok(!st.saveCalls.length, "nothing removed");
        console.log("✓ scenario 5: Gemini dustbin click (selector + coordinates) is blocked; Proceed is not");
    }

    console.log("\nALL APOLLO CART GUARD TESTS PASSED (mocked Apollo, no OTP, no real order)");
    process.exit(0);
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
