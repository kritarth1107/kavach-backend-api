/**
 * Replays the 30 Sep Saheli chats (Bangalore, Max RiteBite):
 * 1. Connected Instamart + Zepto must not say reconnect, and must not drop Zepto.
 * 2. "10g berry" after a RiteBite result searches RiteBite berry, not Yoga Bar.
 * 3. "retry" after a stuck Instamart order stays on that order.
 */
import assert from "node:assert/strict";
import { isMcpAuthError, isMcpSessionGlitch, reconnectAccountCopy, storeFailureKind, storeSearchTries } from "../src/services/commerceAutomation/mcpCommerce/mcpCommerce.service";
import { applyFaithfulHits, catalogSearchQueries, refinePendingQuery, rewriteProductQuery } from "../src/services/commerceAutomation/orderChat/queryRewrite";
import { bindLatestQuestion, bindOfferReply, browserPhaseResumesOnRetry } from "../src/services/commerceAutomation/orderChat/flowBind";
import { catalogRetryNeeded, formatLinkedFailure, linkedFailurePlan, linkedGroceryTargets } from "../src/services/commerceAutomation/orderChat/searchPolicy";
import { isLiteralConfirm } from "../src/services/commerceAutomation/literalConfirm";
import { classifyOrderInterruptRules } from "../src/services/commerceAutomation/orderInterrupt.service";
import { isChatNotAPlace, isClockPhrase, parseFromTo } from "../src/services/rideBooking/slotParse";

let n = 0;
const t = (name: string, fn: () => void) => {
    fn();
    n++;
    console.log(`  ✓ ${name}`);
};

const SESSION = "Streamable HTTP error: Server returned 401 after successful authentication";
const SHOWN = [
    "RiteBite Max Protein Assorted 5g Mini Bytes (pack of 10)",
    "RiteBite Max Protein Roots Ghee Jaggery Cocoa Brownie 10g protein (45 g)",
];

t("connected accounts: session 401 is not a reconnect", () => {
    assert.equal(isMcpSessionGlitch(SESSION), true);
    assert.equal(isMcpAuthError(SESSION), false);
    assert.equal(isMcpAuthError("invalid_grant: refresh token revoked"), true);
    assert.equal(isMcpAuthError("zepto:search_failed:InvalidGrantError"), true);
    assert.equal(isMcpAuthError(SESSION), false);
    assert.equal(isMcpAuthError("Unauthorized"), true);
    const copy = reconnectAccountCopy(["Instamart"], false);
    assert.match(copy, /Dashboard → Integrations/);
    assert.match(copy, /disconnect Instamart/);
    assert.match(copy, /connect Instamart again/);
    assert.doesNotMatch(copy, /Kavach app → Integrations/);
    assert.doesNotMatch(copy, /checking the .+ website/i);
});

t("Instamart and Zepto are both searched when both are connected", () => {
    assert.deepEqual(linkedGroceryTargets(undefined, ["instamart", "zepto"]), ["instamart", "zepto"]);
    assert.deepEqual(linkedGroceryTargets("generic", ["instamart", "zepto"]), ["instamart", "zepto"]);
});

t("session failure on both linked stores stays on those accounts", () => {
    const results = [
        { store: "instamart", error: "search_failed", hits: 0, calledSearch: true, message: SESSION },
        { store: "zepto", error: "search_failed", hits: 0, calledSearch: true, message: SESSION },
    ];
    assert.equal(linkedFailurePlan(results).kind, "retry_linked");
    const text = formatLinkedFailure(results, (s) => (s === "zepto" ? "Zepto" : "Instamart"), "")!;
    assert.match(text, /dropped the connection/);
    assert.match(text, /Instamart/);
    assert.match(text, /Zepto/);
    assert.match(text, /retry/i);
    assert.doesNotMatch(text, /didn't answer/);
    assert.doesNotMatch(text, /reconnect/i);
    assert.doesNotMatch(text, /website/i);
});

t("Raipur 401 plus Zepto unserviceable is not 'didn't answer'", () => {
    const results = [
        { store: "instamart", error: "search_failed", hits: 0, calledSearch: true, message: SESSION },
        { store: "zepto", error: "unserviceable", hits: 0, calledSearch: false, message: "Zepto doesn't deliver to this address right now." },
    ];
    const text = formatLinkedFailure(results, (s) => (s === "zepto" ? "Zepto" : "Instamart"), "")!;
    assert.match(text, /dropped the connection/);
    assert.match(text, /doesn't deliver/);
    assert.doesNotMatch(text, /didn't answer/);
    assert.doesNotMatch(text, /website/i);
    assert.equal(catalogRetryNeeded(results), false);
});

t("Zepto hits are kept when only Instamart rejected the token", () => {
    const results = [
        { store: "instamart", error: "auth_expired", hits: 0 },
        { store: "zepto", error: null, hits: 2 },
    ];
    assert.equal(linkedFailurePlan(results).kind, "show");
});

t("a real token rejection names Dashboard steps and does not open the website", () => {
    const results = [
        { store: "instamart", error: "auth_expired", hits: 0 },
        { store: "zepto", error: "search_failed", hits: 0 },
    ];
    const reconnect = reconnectAccountCopy(["Instamart"], false);
    const text = formatLinkedFailure(results, (s) => (s === "zepto" ? "Zepto" : "Instamart"), reconnect)!;
    assert.match(text, /Dashboard → Integrations/);
    assert.match(text, /Zepto/);
    assert.match(text, /retry/i);
    assert.doesNotMatch(text, /checking the .+ website/i);
});

t("10g berry after RiteBite searches RiteBite berry, not 10g berry", () => {
    const q = rewriteProductQuery("10g berry", "I want the 10g berry one", {
        priorQuery: "max protein rite bite",
        shownNames: SHOWN,
    });
    assert.equal(q, "RiteBite Max Protein berry 10g");
    const typed = rewriteProductQuery("10g berry", "Max rite bite berry flavor 10g protien", {
        priorQuery: "max protein rite bite",
        shownNames: SHOWN,
    });
    assert.equal(typed, "RiteBite Max Protein berry 10g");
    assert.equal(rewriteProductQuery("amul milk", "order amul milk", { priorQuery: "max protein rite bite", shownNames: SHOWN }), "amul milk");
});

t("berry 10g does not offer Yoga Bar, choco, or fruit and nut", () => {
    const hits = [
        { name: "RiteBite Max Protein Choco Almond" },
        { name: "Yoga Bar Blueberry 10g protein" },
        { name: "RiteBite Max Protein Fruit and Nut" },
        { name: SHOWN[0]! },
        { name: SHOWN[1]! },
    ];
    const judged = applyFaithfulHits("RiteBite Max Protein berry 10g", hits);
    assert.equal(judged.hits.length, 0);
    assert.ok(judged.miss);
    assert.match(judged.miss!, /couldn't find RiteBite Max Protein berry 10g/);
    assert.match(judged.miss!, /not an exact match/);
    assert.doesNotMatch(judged.miss!, /Yoga Bar/);
    assert.doesNotMatch(judged.miss!, /choco/i);
    assert.doesNotMatch(judged.miss!, /fruit and nut/i);
    assert.match(judged.miss!, /RiteBite Max Protein/);
    const exact = applyFaithfulHits("RiteBite Max Protein berry 10g", [
        { name: "RiteBite Max Protein Berry 10g protein bar" },
        { name: "Yoga Bar Blueberry" },
    ]);
    assert.equal(exact.hits.length, 1);
    assert.equal(exact.miss, null);
    assert.match(exact.hits[0]!.name, /RiteBite/);
});

t("retry after a stuck Instamart order resumes that order", () => {
    assert.equal(browserPhaseResumesOnRetry("running"), true);
    const bound = bindLatestQuestion("Retry", { browserPhase: "running", browserAt: 1_700_000_000_000 });
    assert.ok(bound);
    assert.equal(bound!.owner, "browser");
    assert.equal(bound!.control, "retry");
    assert.equal(bindLatestQuestion("retry", {}), null);
    assert.equal(
        bindLatestQuestion("yes", { browserPhase: "running", browserAt: 10, ridePhase: "need_pickup", rideAt: 20 }),
        null,
    );
    const confirm = bindLatestQuestion("confirm", { browserPhase: "awaiting_confirm", browserAt: 5 });
    assert.equal(confirm?.control, "confirm");
    assert.equal(confirm?.owner, "browser");
    const pick = bindLatestQuestion("1", { browserPhase: "awaiting_sku_confirm", browserAt: 5 });
    assert.equal(pick?.control, "pick");
    assert.equal(pick?.pickIndex, 1);
});

t("Hindi protein bar is searched in English, then RiteBite, before a failure line", () => {
    assert.deepEqual(catalogSearchQueries("प्रोटीन बार"), ["protein bar", "RiteBite Max Protein"]);
    assert.equal(catalogRetryNeeded([
        { store: "instamart", error: "search_failed", hits: 0, calledSearch: true },
        { store: "zepto", error: "search_failed", hits: 0, calledSearch: true },
    ]), true);
    assert.equal(catalogRetryNeeded([
        { store: "instamart", error: null, hits: 0, calledSearch: true },
        { store: "zepto", error: null, hits: 0, calledSearch: true },
    ]), true);
    assert.equal(catalogRetryNeeded([
        { store: "instamart", error: "auth_expired", hits: 0 },
        { store: "zepto", error: "auth_expired", hits: 0 },
    ]), false);
    const empty = formatLinkedFailure(
        [
            { store: "instamart", error: null, hits: 0, calledSearch: true },
            { store: "zepto", error: null, hits: 0, calledSearch: true },
        ],
        (s) => s,
        "",
    );
    assert.equal(empty, null);
    const skipped = formatLinkedFailure(
        [
            { store: "instamart", error: "search_failed", hits: 0, calledSearch: false },
            { store: "zepto", error: "search_failed", hits: 0, calledSearch: false },
        ],
        (s) => (s === "zepto" ? "Zepto" : "Instamart"),
        "",
    )!;
    assert.match(skipped, /didn't search/);
    assert.doesNotMatch(skipped, /didn't answer/);
    assert.doesNotMatch(skipped, /I checked/);
    assert.equal(catalogRetryNeeded([
        { store: "instamart", error: "search_failed", hits: 0, calledSearch: false },
        { store: "zepto", error: "search_failed", hits: 0, calledSearch: false },
    ]), false);
    assert.equal(storeFailureKind(SESSION), "session");
    assert.equal(storeSearchTries(SESSION), 2);
    assert.equal(storeFailureKind("fetch failed"), "network");
    assert.equal(storeSearchTries("invalid_grant: refresh token revoked"), 1);
    assert.equal(storeFailureKind("Instamart account not connected. Connect in Integrations first."), "no_token");
    assert.equal(storeFailureKind("Invalid encrypted payload"), "decrypt");
});

t("retry after the stores didn't answer reruns that search", () => {
    assert.equal(bindLatestQuestion("retry", {}), null);
    assert.equal(bindOfferReply("retry", "protein bar"), "retry");
    assert.equal(bindOfferReply("yes", "protein bar"), "confirm");
    assert.equal(bindOfferReply("retry", null), null);
    assert.equal(bindOfferReply("what was my TSH", "protein bar"), null);
});

t("10g berry while the address is still unconfirmed keeps RiteBite", () => {
    const prior = rewriteProductQuery("max rite bite berry flavor 10g protien", "max rite bite berry flavor 10g protien");
    assert.match(prior, /RiteBite Max Protein/);
    assert.match(prior, /berry/);
    assert.match(prior, /10g/);
    const kept = refinePendingQuery(prior, "10g berry", "I want the 10g berry one");
    assert.equal(kept, "RiteBite Max Protein berry 10g");
    assert.notEqual(kept.toLowerCase(), "10g berry");
    const hits = [
        { name: "RiteBite Max Protein Daily Bar Berry 10g Protein" },
        { name: "Yoga Bar Protein Bar Chocolate 10g Protein" },
        { name: "RiteBite Max Protein Daily Bar Choco Fudge 10g Protein" },
    ];
    const judged = applyFaithfulHits(kept, hits);
    assert.deepEqual(judged.hits.map((h) => h.name), ["RiteBite Max Protein Daily Bar Berry 10g Protein"]);
    assert.equal(judged.miss, null);
});

t("confirm is not a place, and yes answers the newest open question", () => {
    assert.equal(isClockPhrase("confirm"), true);
    assert.deepEqual(parseFromTo("confirm"), {});
    assert.equal(isChatNotAPlace("Dont call me maa"), true);
    assert.deepEqual(parseFromTo("Dont call me maa"), {});
    assert.equal(isChatNotAPlace("how are you"), true);
    const latest = bindLatestQuestion("yes", {
        browserPhase: "awaiting_sku_confirm",
        browserAt: 10,
        pharmacyPhase: "confirm_basket",
        pharmacyAt: 20,
    });
    assert.equal(latest?.owner, "pharmacy");
    assert.equal(latest?.control, "confirm");
});

t("off-topic chat during an order is normal chat", () => {
    const hit = classifyOrderInterruptRules("maine khana kha liya", "running");
    assert.equal(hit?.intent, "unrelated");
});

t("Ha does not place an order; only confirm does", () => {
    assert.equal(isLiteralConfirm("Ha"), false);
    assert.equal(isLiteralConfirm("yes"), false);
    assert.equal(isLiteralConfirm("confirm"), true);
});

console.log(`all ${n} passed`);
process.exit(0);
