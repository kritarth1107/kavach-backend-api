/**
 * Saheli router unit checks (no Vertex): fallback, per-phone memory isolation, state summaries.
 * Usage: NODE_ENV=test npx tsx scripts/test-saheli-router.ts
 */
process.env.NODE_ENV = "test";
import assert from "node:assert/strict";
import { routeSaheliTurn, rememberTurn, recentTurns, lastRouteFor } from "../src/services/saheliRouter.service";
import { browserDraftSummary, pendingAskSummary } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n} ${m}`);

async function main() {
    // 1. Model unavailable → null (caller falls back to the regex gates).
    const r = await routeSaheliTurn({ phone: "+911111111111", text: "Can u order me a rite bite protein bar", role: "elder", state: [] });
    assert.equal(r, null);
    ok("model unavailable → null → regex fallback");

    // 2. Turn memory is per phone (no cross-user context).
    rememberTurn("+919990000001", "user", "order milk to B12 Green Park");
    rememberTurn("919990000001", "saheli", "Searching Instamart…");
    rememberTurn("+919990000002", "user", "hello");
    assert.match(recentTurns("+919990000001"), /Green Park/);
    assert.match(recentTurns("919990000001"), /Searching Instamart/);
    assert.doesNotMatch(recentTurns("+919990000002"), /Green Park|Instamart/);
    ok("recent turns isolated per phone, format-insensitive key");

    // 3. Duplicate outbound (router + Meta send path) kept once.
    rememberTurn("+919990000003", "saheli", "same text");
    rememberTurn("919990000003", "saheli", "same text");
    assert.equal(recentTurns("+919990000003").split("\n").length, 1);
    ok("duplicate outbound deduped");

    // 4. Last route is per phone.
    assert.equal(lastRouteFor("+919990000002")?.route ?? null, null);
    ok("last route per phone");

    // 5. Draft summary exposes phase / options / platform to the router.
    const s = browserDraftSummary({
        phase: "awaiting_sku_confirm",
        goal: "Order rite bite",
        compare: true,
        productQuery: "rite bite protein bar",
        catalogOptions: [
            { id: "a", name: "RiteBite Max Protein", pricePaise: 8000, partner: "blinkit" },
            { id: "b", name: "RiteBite Choco", pricePaise: 8500, partner: "instamart" },
        ],
    });
    assert.ok(s && /awaiting_sku_confirm/.test(s) && /product=rite bite protein bar/.test(s) && /\(blinkit\)/.test(s));
    assert.equal(browserDraftSummary({ phase: "done", goal: "" }), null);
    assert.equal(browserDraftSummary(null), null);
    ok("browser draft summary");

    // 6. awaiting_address / awaiting_otp flags.
    assert.match(browserDraftSummary({ phase: "awaiting_address", goal: "x" })!, /WAITING FOR DELIVERY ADDRESS/);
    assert.match(browserDraftSummary({ phase: "awaiting_otp", goal: "x", partner: "instamart" })!, /WAITING FOR SMS OTP/);
    ok("slot-filling flags in state");

    // 7. No pending ask for a fresh phone.
    assert.equal(pendingAskSummary("+919990000009"), null);
    ok("no pending ask leak");
    console.log(`\nAll ${n} router checks passed`);
    process.exit(0);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
