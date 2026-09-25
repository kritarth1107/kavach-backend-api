/**
 * Agent-layer guardrail tests (Stagehand stubbed; real headless Chromium for live DOM text).
 * Run: npx tsx scripts/test-agent-layer-guardrails.ts
 */
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";
import {
    guardComputerUseClick,
    isCodSelection,
    parseRupees,
    totalWithinConfirmed,
    validateAgentAction,
    validateCartLines,
} from "../src/services/commerceAutomation/agentLayer/guardrails";
import { __setStagehandFactoryForTests, stagehandStep } from "../src/services/commerceAutomation/agentLayer/stagehandFallback.service";
import { runGenericCodCheckout } from "../src/services/commerceAutomation/agentLayer/stepEngine";

let pass = 0;
async function t(name: string, fn: () => Promise<void> | void) {
    try {
        await fn();
        pass++;
        console.log(`✓ ${name}`);
    } catch (e) {
        console.error(`✗ ${name}\n`, e);
        process.exitCode = 1;
    }
}

const HTML = `<html><body>
<button id="proceed">Proceed to checkout</button>
<button id="upi">Pay via UPI</button>
<button id="card">Credit / Debit card</button>
<button id="cod">Cash on Delivery</button>
<button id="place">Place Order</button>
<button id="payNow">Pay ₹150</button>
<button id="one">Join Swiggy One</button>
<button id="remove">Remove</button>
<button id="close">✕ No thanks</button>
</body></html>`;

async function main() {
    await t("denylist: non-COD payment, membership, remove, place, typing", () => {
        const bad = [
            ["click", "Pay using UPI"],
            ["click", "PhonePe"],
            ["click", "Amazon Pay balance"],
            ["click", "Simpl pay later"],
            ["click", "Net Banking"],
            ["click", "Scan QR to pay"],
            ["click", "Get Swiggy One membership"],
            ["click", "Zomato Gold"],
            ["click", "Zepto Pass"],
            ["click", "Upgrade to Circle plan"],
            ["click", "Remove item"],
            ["click", "Place Order"],
            ["click", "Cash on Delivery"],
            ["fill", "search box"],
            ["type", "address"],
        ];
        for (const [method, text] of bad) {
            assert.equal(validateAgentAction({ method, texts: [text] }).ok, false, `${method} ${text}`);
        }
        for (const text of ["Proceed to checkout", "Continue", "Deliver here", "Close"]) {
            assert.equal(validateAgentAction({ method: "click", texts: [text] }).ok, true, text);
        }
    });

    await t("computer-use guard: blocks pay/membership/place, allows product add with 'Gold' in name", () => {
        assert.equal(guardComputerUseClick("Place order").ok, false);
        assert.equal(guardComputerUseClick("Pay with GPay").ok, false);
        assert.equal(guardComputerUseClick("Join Swiggy One").ok, false);
        assert.equal(guardComputerUseClick("ADD Dabur Honey Gold 500g").ok, true);
        assert.equal(guardComputerUseClick("Proceed").ok, true);
    });

    await t("COD selection / totals / cart lines", () => {
        assert.equal(isCodSelection("Cash on Delivery"), true);
        assert.equal(isCodSelection("Pay on Delivery (Cash/UPI)"), true);
        assert.equal(isCodSelection("UPI"), false);
        assert.equal(isCodSelection("Credit card"), false);
        assert.equal(parseRupees("₹1,234.50"), 1234.5);
        assert.equal(totalWithinConfirmed(146, 145), true);
        assert.equal(totalWithinConfirmed(160, 145), false);
        assert.equal(totalWithinConfirmed(100, undefined), false);
        assert.equal(validateCartLines([{ name: "Amul Taaza Milk 500ml", qty: 1 }], "Amul Taaza Toned Milk 500 ml").ok, true);
        assert.equal(validateCartLines([{ name: "Amul Taaza Milk 500ml", qty: 2 }], "Amul Taaza Milk 500ml").ok, false);
        assert.equal(validateCartLines([{ name: "Milk", qty: 1 }, { name: "Bread", qty: 1 }], "Milk").ok, false);
        assert.equal(validateCartLines([{ name: "Swiggy One Membership 3 months", qty: 1 }], null).ok, false);
    });

    const browser = await chromium.launch({ headless: true });
    const page: Page = await browser.newPage();
    await page.setContent(HTML);
    const clicked: string[] = [];
    await page.exposeFunction("__rec", (id: string) => clicked.push(id));
    await page.evaluate(() => {
        document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => (window as any).__rec(b.id)));
    });

    // Fake Stagehand: observe returns scripted candidates; act clicks via Playwright.
    let observeQueue: Array<Array<{ selector: string; description: string; method?: string }>> = [];
    let extractQueue: unknown[] = [];
    const fake = {
        init: async () => undefined,
        observe: async () => observeQueue.shift() ?? [],
        act: async (a: { selector: string }) => {
            await page.locator(a.selector).first().click();
            return { success: true, message: "ok" };
        },
        extract: async () => extractQueue.shift() ?? null,
        close: async () => undefined,
    };
    __setStagehandFactoryForTests(async () => fake);

    await t("stagehandStep: lying description → blocked by LIVE element text (UPI)", async () => {
        clicked.length = 0;
        observeQueue = [[{ selector: "#upi", description: "Continue button", method: "click" }]];
        const r = await stagehandStep(page, { goal: "continue" });
        assert.equal(r.status, "blocked");
        assert.deepEqual(clicked, []);
    });

    await t("stagehandStep: skips membership + place, acts on first safe candidate", async () => {
        clicked.length = 0;
        observeQueue = [
            [
                { selector: "#one", description: "Continue", method: "click" },
                { selector: "#place", description: "Next", method: "click" },
                { selector: "#proceed", description: "Proceed to checkout", method: "click" },
            ],
        ];
        const r = await stagehandStep(page, { goal: "proceed" });
        assert.equal(r.status, "acted");
        assert.deepEqual(clicked, ["proceed"]);
    });

    await t("stagehandStep: typing never executed", async () => {
        clicked.length = 0;
        observeQueue = [[{ selector: "#proceed", description: "type address", method: "fill" }]];
        const r = await stagehandStep(page, { goal: "x" });
        assert.equal(r.status, "blocked");
        assert.deepEqual(clicked, []);
    });

    const screen = (o: Record<string, unknown>) => ({
        screen: "payment",
        cartItems: [{ name: "Amul Taaza Milk 500ml", quantity: 1 }],
        billLines: ["Item total ₹30", "Delivery ₹20"],
        payableTotal: "₹50",
        selectedPaymentMethod: "Cash on Delivery",
        deliveryAddress: "C504, Sunita Park, Labhandih, Raipur 492001",
        orderId: null,
        eta: null,
        ...o,
    });
    const baseOpts = { partner: "zepto", deadlineAt: Date.now() + 120_000, skuName: "Amul Taaza Milk 500ml", confirmedTotalRupees: 50 };

    await t("generic checkout: amount went up → amount_changed, no Place click", async () => {
        clicked.length = 0;
        extractQueue = [screen({}), screen({ payableTotal: "₹75" })];
        observeQueue = [];
        const out = await runGenericCodCheckout(page, { ...baseOpts });
        assert.equal(out.status, "amount_changed");
        assert.ok(!clicked.includes("place"));
    });

    await t("generic checkout: membership line in bill → cart_mismatch", async () => {
        clicked.length = 0;
        extractQueue = [screen({}), screen({ billLines: ["Item total ₹30", "Swiggy One membership ₹99"] })];
        const out = await runGenericCodCheckout(page, { ...baseOpts });
        assert.equal(out.status, "cart_mismatch");
        assert.ok(!clicked.includes("place"));
    });

    await t("generic checkout: UPI selected → code picks COD (live text), dry run stops before Place", async () => {
        clicked.length = 0;
        extractQueue = [screen({ selectedPaymentMethod: "UPI" }), screen({}), screen({})];
        observeQueue = [[] /* open_cart */, [{ selector: "#upi", description: "Cash on delivery option" }, { selector: "#cod", description: "Cash on delivery" }]];
        const out = await runGenericCodCheckout(page, { ...baseOpts, dryRun: true });
        assert.equal(out.status, "dry_run_stop");
        assert.deepEqual(clicked, ["cod"]);
    });

    await t("generic checkout: 'Pay ₹150' button is never used as Place; real Place clicked once", async () => {
        clicked.length = 0;
        let placed = 0;
        extractQueue = [screen({}), screen({}), screen({ screen: "order_success", orderId: "Z123" })];
        observeQueue = [[] /* open_cart */, [{ selector: "#payNow", description: "Place order" }, { selector: "#place", description: "Place order" }]];
        const out = await runGenericCodCheckout(page, { ...baseOpts, onPlaceClicked: () => placed++ });
        assert.equal(out.status, "placed");
        assert.equal(placed, 1);
        assert.deepEqual(clicked, ["place"]);
    });

    await t("generic checkout: store-account address (Gurugram) → address_unverified, no Place", async () => {
        clicked.length = 0;
        extractQueue = [screen({}), screen({ deliveryAddress: "1704, Tower 5, M3M Heights, Gurugram 122102" })];
        observeQueue = [];
        const out = await runGenericCodCheckout(page, { ...baseOpts });
        assert.equal(out.status, "address_unverified");
        assert.ok(!clicked.includes("place"));
    });

    await t("generic checkout: extract unavailable → fail closed (stuck), nothing clicked", async () => {
        clicked.length = 0;
        extractQueue = [];
        const out = await runGenericCodCheckout(page, { ...baseOpts });
        assert.equal(out.status, "stuck");
        assert.deepEqual(clicked, []);
    });

    __setStagehandFactoryForTests(null);
    await browser.close();
    console.log(`\n${pass} passed`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
