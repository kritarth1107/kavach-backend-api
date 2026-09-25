/**
 * LIVE read-only guest check on real apollopharmacy.in — NO login, NO OTP, NO address clicks.
 * Adds one item to a fresh guest cart, opens /medicines-cart and reads it with the signed-in
 * address reader. For a guest Apollo renders NO CartAddress block (it is signed-in only), and
 * the only "address" text is the header browse location ("Delivery Address / Select Address") —
 * which the old heuristic clicked. The reader must report "nothing selected" here.
 *   npx tsx scripts/live-apollo-guest-address-block.ts
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { addExactSkuToApolloCart, emptyApolloCart, APOLLO_CART_URL } from "../src/services/commerceAutomation/apolloPostOtp";
import { cartAddressEvidence, addressTargetFrom, readCartAddressBlock } from "../src/services/commerceAutomation/apolloAddress";

(async () => {
    const forbidden: string[] = [];
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    });
    await ctx.route("**/*", (r) => {
        const u = r.request().url();
        const asset = /\.(js|css|png|svg|webp|woff2?)(\?|$)/i.test(u);
        if (!asset && /otp|login|signin|sign-in|authorize/i.test(u)) {
            if (/otp/i.test(u)) forbidden.push(u);
            return r.abort();
        }
        if (/\/(checkout|pay|delivery-options|order|address-details)/i.test(new URL(u).pathname) && r.request().resourceType() === "document") {
            forbidden.push(u);
            return r.abort();
        }
        return r.continue();
    });
    const page = await ctx.newPage();
    try {
        const item = { name: "Little's Soft Cleansing Baby Wipes, 30 Units", productUrl: "https://www.apollopharmacy.in/otc/little-s-soft-cleansing-baby-wipes-30-s", qty: 1 };
        const r = await addExactSkuToApolloCart(page, item, { deadlineAt: Date.now() + 70_000, pincode: "462001" });
        console.log("seed add →", r.status, r.detail);
        await page.goto(APOLLO_CART_URL, { waitUntil: "domcontentloaded" });
        let blk = await readCartAddressBlock(page);
        for (let i = 0; i < 8 && !blk.found; i++) {
            await page.waitForTimeout(700);
            blk = await readCartAddressBlock(page);
        }
        const target = addressTargetFrom("B12, GREEN PARK, ARERA, NEAR LOTUS AREA HOTEL, BHOPAL, MADHYA PRADESH, 462001")!;
        console.log("CartAddress block (guest):", JSON.stringify(blk), "evidence:", cartAddressEvidence(blk, target));
        const html = await page
            .evaluate(() => (document.querySelector('[class*="CartAddress_addressMain"]') as HTMLElement | null)?.outerHTML.replace(/\s+/g, " ").slice(0, 700) || "")
            .catch(() => "");
        console.log("block html:", html);
        const header = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 60)).catch(() => "");
        console.log("page starts with:", JSON.stringify(header));
        assert.equal(blk.selected, false, "guest has no selected delivery address");
        assert.equal(cartAddressEvidence(blk, target), "none", "header browse location is never counted as the delivery address");
        await emptyApolloCart(page, { deadlineAt: Date.now() + 40_000 });
        if (forbidden.length) console.log("blocked (aborted) requests:", forbidden);
        assert.deepEqual(forbidden.filter((u) => /apollopharmacy\.in/i.test(new URL(u).hostname)), [], "no Apollo OTP / checkout traffic");
        console.log("LIVE GUEST ADDRESS READER CHECK PASSED (no login, no OTP, no address clicks)");
    } finally {
        await browser.close();
    }
})().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
