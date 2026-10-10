/**
 * Replays the 30 Sep Saheli chats (Bangalore, Max RiteBite):
 * 1. Connected Instamart + Zepto must not say reconnect, and must not drop Zepto.
 * 2. "10g berry" after a RiteBite result searches RiteBite berry, not Yoga Bar.
 * 3. "retry" after a stuck Instamart order stays on that order.
 */
import assert from "node:assert/strict";
import { parseMetaWebhookMessages } from "../src/clients/metaWhatsApp.client";
import { AUTH_FAILURES_TO_EXPIRE, MCP_CARD_TTL_MS, cardLines, liveEta, receiverMatches, isMcpAuthError, isMcpSessionGlitch, reconnectAccountCopy, storeFailureKind, storeSearchTries } from "../src/services/commerceAutomation/mcpCommerce/mcpCommerce.service";
import { applyFaithfulHits, catalogSearchQueries, refinePendingQuery, rewriteProductQuery } from "../src/services/commerceAutomation/orderChat/queryRewrite";
import { bindLatestQuestion, bindOfferReply, browserPhaseResumesOnRetry, isMoreOptionsRequest, shouldPageCatalog } from "../src/services/commerceAutomation/orderChat/flowBind";
import { catalogRetryNeeded, formatLinkedFailure, linkedFailurePlan, linkedGroceryTargets } from "../src/services/commerceAutomation/orderChat/searchPolicy";
import { isLiteralConfirm } from "../src/services/commerceAutomation/literalConfirm";
import { checkCartLines, etaFrom } from "../src/services/commerceAutomation/mcpCommerce/mcpParse";
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

t("show more pages the open list and is not a search for retry", () => {
    assert.equal(isMoreOptionsRequest("show more"), true);
    assert.equal(isMoreOptionsRequest("aur dikhao"), true);
    assert.equal(isMoreOptionsRequest("retry"), false);
    assert.equal(shouldPageCatalog("show more", "awaiting_sku_confirm", 12), true);
    assert.equal(shouldPageCatalog("retry", "awaiting_sku_confirm", 12), false);
    assert.equal(shouldPageCatalog("show more", "running", 12), false);
});

t("a late yes still places: the confirm card lasts 90 min (placing re-checks address, COD and total)", () => {
    assert.equal(MCP_CARD_TTL_MS, 90 * 60_000);
});

t("a store login refused 3 times in a row stops counting as linked (lab 2026-10-10: 'Connected' while every call got 401)", () => {
    assert.equal(AUTH_FAILURES_TO_EXPIRE, 3);
});

t("a place with its own receiver uses only a store address in that receiver's name (Vish's Home with Vish's number)", () => {
    const vish = { contactName: "Vish", contactPhone: "9980531439" };
    assert.equal(receiverMatches("Kritarth Agrawal: 74, K NO 398/348/74, Amruthahalli, Bangalore 560092", vish), false);
    assert.equal(receiverMatches("Vish: 74, K NO 398/348/74, Amruthahalli, Bangalore 560092", vish), true);
    assert.equal(receiverMatches("Kritarth Agrawal: C504 Sunita Park, Raipur 492001", {}), true);
});

t("several items in one connector cart: exactly those lines at their qty (biscuits and munchies)", () => {
    const want = [{ id: "B1", name: "Parle-G 475 g", qty: 1 }, { id: "K1", name: "Kurkure Masala Munch", qty: 2 }];
    const cart = (lines: Array<{ id: string; name: string; qty: number }>) => ({ lines, totalPaise: 15000, feeLines: [] });
    assert.deepEqual(checkCartLines(cart([{ id: "K1", name: "Kurkure", qty: 2 }, { id: "B1", name: "Parle-G", qty: 1 }]), want, { needTotal: true }), { ok: true });
    assert.equal((checkCartLines(cart([{ id: "B1", name: "Parle-G", qty: 1 }]), want) as { reason: string }).reason, "missing_items");
    assert.equal((checkCartLines(cart([{ id: "B1", name: "Parle-G", qty: 1 }, { id: "K1", name: "Kurkure", qty: 1 }]), want) as { reason: string }).reason, "qty_mismatch");
    assert.equal((checkCartLines(cart([{ id: "B1", name: "a", qty: 1 }, { id: "X9", name: "b", qty: 2 }]), want) as { reason: string }).reason, "item_mismatch");
    const p = { store: "instamart" as const, name: "Parle-G" };
    assert.equal(cardLines({ pick: p, qty: 3 }).length, 1);
    assert.equal(cardLines({ pick: p, qty: 1, lines: [{ pick: p, qty: 1 }, { pick: { ...p, name: "Kurkure" }, qty: 2 }] }).length, 2);
});

t("the delivery time is read from a store's order answer (lab 2026-10-10: connector orders came back without one)", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0); // 5:30 pm IST
    const placed = "🎉 Instamart order placed successfully! Order ID: 250596002955721\n{\n  \"orderId\": \"250596002955721\",\n  \"status\": \"CONFIRMED\",\n  \"liveEtaEligible\": true,\n  \"etaText\": \"Arriving in 12 mins\"\n}";
    assert.equal(etaFrom(placed, now), "12 min");
    assert.equal(etaFrom(`ok\n{"orderId":"1","deliveryBy":${now + 14 * 60_000},"serverNow":${now},"pollIntervalSec":45}`, now), "about 14 min (by 5:44 pm)");
    assert.equal(etaFrom(`ok\n{"orderId":"1","deliveryBy":null,"serverNow":${now}}`, now), undefined);
    assert.equal(etaFrom('done\n{"status":{"statusMessage":"Order Delivered"},"placedAt":"03:30 PM"}', now), undefined);
    assert.equal(etaFrom('x\n{"status":{"statusMessage":"Arriving in 8-10 mins"}}', now), "8-10 min");
    assert.equal(etaFrom('x\n{"order":{"sla_minutes":25}}', now), "25 min");
    assert.equal(etaFrom("Your order will be delivered in 30 minutes.", now), "30 min");
    assert.equal(etaFrom("Order ID: 9. Placed at 5:30 pm.", now), undefined);
    assert.equal(etaFrom('x\n{"status":{"statusMessage":"Order placed 2 mins ago"}}', now), undefined);
});

t("a WhatsApp reply quoting an earlier photo carries the quoted message id (live 2026-10-10 22:36)", () => {
    const body = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [
        { from: "917694829888", id: "wamid.NEW", type: "text", text: { body: "ye kya hai?" }, context: { from: "919000000000", id: "wamid.PHOTO" } },
        { from: "917694829888", id: "wamid.PHOTO2", type: "image", image: { id: "MEDIA1", caption: "Ye kya h" } },
    ] } }] }] };
    const [reply, photo] = parseMetaWebhookMessages(body);
    assert.equal(reply.replyToId, "wamid.PHOTO");
    assert.equal(photo.replyToId, undefined);
    assert.equal(photo.mediaId, "MEDIA1");
});

(async () => {
    // After an order with no time in the answer: the store's delivery-status tool, then its tracker (with the place's
    // coordinates), and never longer than the lookup budget.
    const now = Date.now();
    const calls: string[] = [];
    const client = (answers: Record<string, string>) => ({
        listTools: async () => ({ tools: [
            { name: "get_delivery_status", inputSchema: { properties: { orderId: {}, addressId: {} } } },
            { name: "track_order", inputSchema: { properties: { orderId: {}, lat: {}, lng: {} } } },
            { name: "checkout", inputSchema: { properties: { addressId: {} } } },
        ] }),
        callTool: async ({ name, arguments: a }: { name: string; arguments: Record<string, unknown> }) => {
            calls.push(`${name}:${JSON.stringify(a)}`);
            return { content: [{ type: "text", text: answers[name] ?? "{}" }] };
        },
    });
    const ctx = { familyId: "f", recipientUserId: "u", recipientPhone: "", place: { addressId: "p", lat: 21.24, lng: 81.67 } } as never;
    const a = await liveEta(client({ get_delivery_status: `ok\n{"deliveryBy":${now + 20 * 60_000}}` }) as never, ctx, "O1", "S1");
    assert.match(a!, /^about (19|20) min \(by /);
    assert.equal(calls[0], 'get_delivery_status:{"orderId":"O1","addressId":"S1"}');
    calls.length = 0;
    const b = await liveEta(client({ get_delivery_status: 'ok\n{"deliveryBy":null}', track_order: 'ok\n{"status":{"statusMessage":"Arriving in 9 mins"}}' }) as never, ctx, "O2", "S1");
    assert.equal(b, "9 min");
    assert.equal(calls[1], 'track_order:{"orderId":"O2","lat":21.24,"lng":81.67}');
    assert.equal(await liveEta(client({}) as never, ctx, "O3", "S1"), undefined);
    n++;
    console.log("  ✓ after an order: delivery-status tool, then the tracker with the place's coordinates");
    console.log(`all ${n} passed`);
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
