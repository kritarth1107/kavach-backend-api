/**
 * LIVE guest dry-run on real apollopharmacy.in — NO login, NO OTP, NO checkout.
 * Adds 2 random items to a fresh guest cart, runs the deterministic cleanup, verifies the
 * cart is empty, adds the wet-wipes target ×1 and runs the exactly-one-item guard.
 * Any URL mentioning otp/login is aborted (and fails the run). Never opens checkout.
 *   npx tsx scripts/live-apollo-guest-cart-cleanup.ts
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import {
    addExactSkuToApolloCart,
    checkCartExactlySku,
    emptyApolloCart,
    readApolloCart,
    readCartLines,
    waitForCartSnapshot,
    APOLLO_CART_URL,
} from "../src/services/commerceAutomation/apolloPostOtp";

const RANDOM = [
    { name: "Little's Soft Cleansing Baby Wipes, 30 Units", productUrl: "https://www.apollopharmacy.in/otc/little-s-soft-cleansing-baby-wipes-30-s", qty: 1 },
    { name: "Luvlap Baby Wipes Aloevera With Lid, 72 Count", productUrl: "https://www.apollopharmacy.in/otc/luvlap-baby-wipes-aloevera-with-lid-72-s", qty: 1 },
];
const TARGET = {
    name: "Apollo Life Premium Citrus Refreshing Wet Wipes, Pack of 2 (2x30) (2x30 Wipes · Pack)",
    productUrl: "https://www.apollopharmacy.in/otc/apollo-pharmacy-refreshing-wipes-citrus-30s",
    pricePaise: 9920,
    qty: 1,
};

(async () => {
    /** OTP / checkout requests (must be zero). */
    const forbidden: string[] = [];
    /** Site's own background auth handshakes (uis/api/authorize …) — aborted, not an OTP. */
    const blockedAuth: string[] = [];
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    await ctx.route("**/*", (r) => {
        const u = r.request().url();
        const apollo = /apollo(247|pharmacy)\.(in|com)/i.test(new URL(u).hostname);
        if (apollo && /otp/i.test(u) && !/\.(js|css|png|svg|webp|woff2?)(\?|$)/i.test(u)) {
            forbidden.push(u);
            return r.abort();
        }
        if (/login|signin|sign-in|authorize/i.test(u) && !/\.(js|css|png|svg|webp|woff2?)(\?|$)/i.test(u)) {
            blockedAuth.push(u);
            return r.abort();
        }
        if (apollo && /\/(checkout|pay|delivery-options|order)/i.test(new URL(u).pathname) && r.request().resourceType() === "document") {
            forbidden.push(u);
            return r.abort();
        }
        return r.continue();
    });
    const page = await ctx.newPage();
    const log = (e: string, x?: Record<string, unknown>) => console.log(`  [${e}]`, x ? JSON.stringify(x) : "");
    try {
        for (const item of RANDOM) {
            const r = await addExactSkuToApolloCart(page, item, { deadlineAt: Date.now() + 70_000, pincode: "492001" });
            console.log(`seed add "${item.name}" →`, r.status, r.detail);
        }
        await page.goto(APOLLO_CART_URL, { waitUntil: "domcontentloaded" });
        const seeded = await waitForCartSnapshot(page, Date.now() + 15_000);
        console.log("seeded cart:", JSON.stringify(seeded));
        assert.ok(seeded.lines.length >= 1, "guest cart seeded with at least 1 item");

        const t0 = Date.now();
        const clean = await emptyApolloCart(page, { deadlineAt: Date.now() + 80_000, log });
        console.log("cleanup:", JSON.stringify(clean), `(${Date.now() - t0} ms)`);
        assert.equal(clean.status, "emptied");
        assert.equal(clean.removed, seeded.lines.length);

        // Independent re-read (fresh load)
        await page.goto(APOLLO_CART_URL, { waitUntil: "domcontentloaded" });
        const after = await waitForCartSnapshot(page, Date.now() + 15_000);
        console.log("re-read after cleanup:", JSON.stringify(after));
        assert.equal(after.state, "empty");

        const t1 = Date.now();
        const add = await addExactSkuToApolloCart(page, TARGET, { deadlineAt: Date.now() + 70_000, pincode: "492001" });
        console.log("target add:", add.status, add.detail, `(${Date.now() - t1} ms)`);
        assert.equal(add.status, "added");
        const cart = await readApolloCart(page, TARGET, { deadlineAt: Date.now() + 40_000, pincode: "492001" });
        const lines = cart?.cartLines ?? (await readCartLines(page));
        const guard = checkCartExactlySku(lines, TARGET.name);
        console.log("cart after add:", JSON.stringify(lines), "total:", cart?.totalLabel, "guard:", JSON.stringify(guard));
        assert.equal(guard.ok, true);

        // Leave the throwaway guest cart empty again.
        const tidy = await emptyApolloCart(page, { deadlineAt: Date.now() + 60_000 });
        console.log("tidy:", tidy.status);
        console.log(`blocked ${blockedAuth.length} background auth/login handshake request(s) (aborted); OTP/checkout requests: ${forbidden.length}`);
        assert.deepEqual(forbidden, [], "no OTP / checkout traffic");
        console.log("\nLIVE GUEST DRY-RUN OK (no login, no OTP, no checkout)");
    } finally {
        await browser.close();
    }
    process.exit(0);
})().catch((e) => {
    console.error("LIVE DRY-RUN FAILED:", e);
    process.exit(1);
});
