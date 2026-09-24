/**
 * Smoke / unit: ride slot-fill, location parse, cancel, dry-run fare confirm.
 * Run: BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-rides.ts
 */
process.env.BROWSER_WORKER_MODE = process.env.BROWSER_WORKER_MODE || "dry_run";
process.env.COMMERCE_SESSION_ENCRYPTION_KEY =
    process.env.COMMERCE_SESSION_ENCRYPTION_KEY || "smoke-test-key-not-for-prod";

import {
    formatRouteSummary,
    isBareAffirmation,
    isRideCancel,
    messageLooksLikeRideIntent,
    parseFromTo,
    parseLocationPin,
    placeFromText,
    providerFromText,
} from "../src/services/rideBooking/slotParse";
import { dryRunFares, formatFareCard, rideGoal } from "../src/services/rideBooking/rideBrowser.service";
import { DryRunBrowserWorker } from "../src/services/commerceAutomation/browserWorker.service";
import { resolvePlaybook } from "../src/services/commerceAutomation/playbooks";
import type { RideDraft } from "../src/services/rideBooking/types";

function assert(cond: boolean, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exitCode = 1;
    } else {
        console.log("OK:", msg);
    }
}

async function main() {
    // --- Intent / cancel / slots ---
    assert(messageLooksLikeRideIntent("book a cab"), "intent: book a cab");
    assert(messageLooksLikeRideIntent("I want a ride"), "intent: want a ride");
    assert(messageLooksLikeRideIntent("call an uber please"), "intent: call uber");
    assert(!messageLooksLikeRideIntent("how are you"), "non-intent chat");
    assert(isRideCancel("Nope"), "cancel: Nope");
    assert(isRideCancel("cancel"), "cancel: cancel");
    assert(isBareAffirmation("Yeah"), "bare Yeah");
    assert(providerFromText("book ola") === "ola", "provider ola");
    assert(providerFromText("uber me") === "uber", "provider uber");

    const fromTo = parseFromTo("from 4th Cross Rd Amruthnagar to ritz Carlton bangalore");
    assert(!!fromTo.pickup && /Amruthnagar|4th Cross/i.test(fromTo.pickup!), `from parse: ${fromTo.pickup}`);
    assert(!!fromTo.drop && /ritz/i.test(fromTo.drop!), `to parse: ${fromTo.drop}`);

    const pin = parseLocationPin(
        '[location lat=12.9716 lng=77.5946 name="Home" address="4th Cross Rd, Amruthnagar"]',
    );
    assert(!!pin && pin.lat === 12.9716 && pin.lng === 77.5946, "location pin parse");
    assert(/4th Cross|Home/i.test(pin!.shortLabel || pin!.address || ""), "pin label");

    const route = formatRouteSummary(
        placeFromText("4th Cross Rd, Amruthnagar"),
        placeFromText("the Ritz-Carlton on Residency Rd"),
    );
    assert(/Got the route: from .* to .*/i.test(route), `route summary: ${route}`);

    // --- Playbook ---
    const pb = resolvePlaybook("uber", "BOOK_RIDE provider=uber");
    assert(pb.partner === "uber", "uber playbook partner");
    assert(/uber\.com/i.test(pb.startUrl), "uber startUrl");
    assert(pb.category === "ride", "uber category ride");

    // --- Dry-run browser: OTP → fares → book → driver ---
    const draft: RideDraft = {
        phase: "awaiting_otp",
        provider: "uber",
        pickup: placeFromText("4th Cross Rd, Amruthnagar"),
        drop: placeFromText("Ritz-Carlton Bangalore"),
        routeSummary: route,
    };
    const goal = rideGoal(draft);
    assert(/BOOK_RIDE/.test(goal), "ride goal marker");

    const worker = new DryRunBrowserWorker();
    const step1 = await worker.runBrowserTask({
        familyId: "fam-ride-smoke",
        userId: "user-ride-smoke",
        goal,
        partner: "uber",
        startUrl: pb.startUrl,
    });
    assert(step1.status === "need_otp", `step1 need_otp got ${step1.status}`);

    const step2 = await worker.runBrowserTask({
        familyId: "fam-ride-smoke",
        userId: "user-ride-smoke",
        goal,
        partner: "uber",
        startUrl: pb.startUrl,
        otp: "1234",
    });
    assert(step2.status === "need_user_confirm", `step2 fares got ${step2.status}`);
    assert(/₹|UberX|fare/i.test(step2.message), "step2 has fare");
    assert(/confirm|book/i.test(step2.message), "step2 asks confirm");

    const fares = dryRunFares();
    assert(fares.length >= 2, "dry-run fares list");
    const card = formatFareCard(fares, "uber");
    assert(/UberX/i.test(card) && /cancel/i.test(card), "fare card copy");

    const step3 = await worker.runBrowserTask({
        familyId: "fam-ride-smoke",
        userId: "user-ride-smoke",
        goal,
        partner: "uber",
        startUrl: pb.startUrl,
        userConfirmed: true,
    });
    assert(step3.status === "done", `step3 done got ${step3.status}`);
    assert(/driver|plate|KA-/i.test(step3.message), "step3 driver/plate");

    console.log("\nSmoke rides:", process.exitCode ? "FAILED" : "PASSED");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
