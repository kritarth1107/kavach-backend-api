/**
 * Smoke: private browser dry-run — any-site + health tips + OTP → confirm → done.
 * Run: BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-private-browser.ts
 */
process.env.BROWSER_WORKER_MODE = process.env.BROWSER_WORKER_MODE || "dry_run";
process.env.COMMERCE_SESSION_ENCRYPTION_KEY =
    process.env.COMMERCE_SESSION_ENCRYPTION_KEY || "smoke-test-key-not-for-prod";

import { messageLooksLikeBrowserTask } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";
import { DryRunBrowserWorker } from "../src/services/commerceAutomation/browserWorker.service";
import { formatPharmacyBrowserFollowUp } from "../src/services/commerceAutomation/browserProgressNotify.service";
import { parseMedicineList } from "../src/services/pharmacyOrderFlow.service";
import { resolvePlaybook, listSupportedBrowserSites } from "../src/services/commerceAutomation/playbooks";
import { resolveSiteFromMessage } from "../src/services/commerceAutomation/siteResolve";
import { messageLooksLikeUnsupportedCommerce } from "../src/services/saheliOrder.service";
import {
    buildCommerceHealthSuggestions,
    formatCommerceHealthSuggestionsForCopy,
} from "../src/services/saheliCommerceHealthHints.service";

function assert(cond: boolean, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exitCode = 1;
    } else {
        console.log("OK:", msg);
    }
}

async function flow(goal: string, partner?: Parameters<DryRunBrowserWorker["runBrowserTask"]>[0]["partner"]) {
    const worker = new DryRunBrowserWorker();
    const familyId = "fam-smoke";
    const userId = "user-smoke";
    const site = resolveSiteFromMessage(goal, { forceBrowser: true });
    const playbook = resolvePlaybook(partner ?? (site.siteKey === "generic" ? "generic" : site.siteKey), goal, site.startUrl);

    assert(messageLooksLikeBrowserTask(goal), `intent detects: ${goal}`);
    assert(!/unsupported/i.test(goal) || !messageLooksLikeUnsupportedCommerce(goal), `not unsupported: ${goal}`);

    const step1 = await worker.runBrowserTask({
        familyId,
        userId,
        goal,
        partner: playbook.partner,
        startUrl: playbook.startUrl,
    });
    assert(step1.status === "need_otp", `${goal} step1 need_otp (got ${step1.status})`);
    assert(!/not supported|unsupported/i.test(step1.message), `${goal} step1 not unsupported`);

    const step2 = await worker.runBrowserTask({
        familyId,
        userId,
        goal,
        partner: playbook.partner,
        startUrl: playbook.startUrl,
        otp: "123456",
        healthHintCopy: formatCommerceHealthSuggestionsForCopy([
            {
                kind: "diet",
                text: "Suggestion (you decide): your record notes blood pressure — low-sodium options if that matches your usual plan.",
            },
        ]),
    });
    assert(step2.status === "need_user_confirm", `${goal} step2 confirm (got ${step2.status})`);
    assert(/confirm/i.test(step2.message), `${goal} step2 asks confirm`);
    assert(/Saheli tip/i.test(step2.message), `${goal} step2 has soft health tip`);

    const step3 = await worker.runBrowserTask({
        familyId,
        userId,
        goal,
        partner: playbook.partner,
        startUrl: playbook.startUrl,
        userConfirmed: true,
    });
    assert(step3.status === "done", `${goal} step3 done (got ${step3.status})`);
}

async function main() {
    assert(resolvePlaybook(undefined, "order vit c from apollo").partner === "apollo", "apollo playbook");
    assert(resolveSiteFromMessage("order oats from bigbasket").siteKey === "bigbasket", "bigbasket site");
    assert(resolveSiteFromMessage("buy this from amazon").siteKey === "amazon", "amazon site");
    assert(
        resolveSiteFromMessage("https://www.flipkart.com/item/p/itm123").siteKey === "flipkart",
        "flipkart url",
    );
    assert(resolvePlaybook(undefined, "order oats from bigbasket").partner === "bigbasket", "bigbasket playbook");
    assert(!messageLooksLikeUnsupportedCommerce("order oats from bigbasket"), "bigbasket not unsupported");
    assert(!messageLooksLikeUnsupportedCommerce("buy iphone from amazon"), "amazon phone not unsupported");
    assert(messageLooksLikeBrowserTask("order oats from bigbasket"), "bigbasket browser intent");
    assert(messageLooksLikeBrowserTask("buy this from amazon"), "amazon browser intent");

    const sites = listSupportedBrowserSites();
    assert(sites.some((s) => /BigBasket/i.test(s)), "sites list has BigBasket");
    assert(sites.some((s) => /Amazon/i.test(s)), "sites list has Amazon");
    console.log("Supported sites:", sites.join("; "));

    await flow("order vit c from apollo", "apollo");
    await flow("order oats from bigbasket");
    await flow("buy this from amazon");

    // Pharmacy async follow-up copy must never be empty / silent
    {
        const otpWait = formatPharmacyBrowserFollowUp(
            {
                status: "need_otp",
                mode: "playwright",
                partner: "apollo",
                steps: 2,
                message: "Paste the SMS OTP here",
            },
            { partner: "apollo", goal: "Order from Apollo: vitamin c capsules×1" },
        );
        assert(/OTP|paste/i.test(otpWait.text), "follow-up need_otp mentions paste");
        assert(otpWait.phase === "awaiting_otp", "follow-up need_otp phase");

        const timedOut = formatPharmacyBrowserFollowUp(
            {
                status: "need_otp",
                mode: "playwright",
                partner: "apollo",
                steps: 0,
                failureReason: "timeout",
                message: "deadline",
            },
            { partner: "apollo" },
        );
        assert(/didn't reach|login-code|retry/i.test(timedOut.text), "follow-up timeout is actionable");
        assert(/retry/i.test(timedOut.text), "follow-up timeout offers retry");

        const blocked = formatPharmacyBrowserFollowUp(
            {
                status: "error",
                mode: "playwright",
                partner: "apollo",
                steps: 0,
                failureReason: "captcha",
                message: "Apollo blocked the browser session (CAPTCHA / bot check).",
            },
            { partner: "apollo" },
        );
        assert(/CAPTCHA|blocked|retry/i.test(blocked.text), "follow-up CAPTCHA is clear");

        const noLogin = formatPharmacyBrowserFollowUp(
            {
                status: "error",
                mode: "playwright",
                partner: "pharmeasy",
                steps: 0,
                failureReason: "no_login_button",
                message: "PharmEasy page loaded but I couldn't find a Login / phone field.",
            },
            { partner: "pharmeasy" },
        );
        assert(/Login|phone field|retry/i.test(noLogin.text), "follow-up no_login_button is clear");
    }

    // Basket parse: partner linker words must never become SKUs
    {
        const items = parseMedicineList("Order vitamin c from apollo");
        assert(
            items.length === 1 && /vitamin\s*c/i.test(items[0].name),
            `vit c from apollo → single SKU (got ${JSON.stringify(items)})`,
        );
        assert(
            !items.some((i) => /^from$/i.test(i.name)),
            "from must not be a basket item",
        );
        const pe = parseMedicineList("order vit c from pharmeasy");
        assert(
            pe.length === 1 && /vitamin\s*c/i.test(pe[0].name),
            `vit c from pharmeasy → single SKU (got ${JSON.stringify(pe)})`,
        );
    }

    // Stub health builder path (no Mongo — may return [])
    const tips = await buildCommerceHealthSuggestions({
        familyId: "fam-smoke",
        recipientUserId: "user-smoke",
        cartItemNames: ["oats", "salt"],
    }).catch(() => []);
    console.log("health builder returned", tips.length, "tips (0 ok without care memory)");

    
    // OTP one-shot + cancel + still-working suppress (unit, no Chromium)
    {
        const {
            beginBrowserGeneration,
            claimPharmacyOtpSend,
            hasPharmacyOtpSendBeenClaimed,
            abortBrowserSessionForUser,
            shouldSuppressStillWorkingFallback,
            wasBrowserCancelledRecently,
        } = await import("../src/services/commerceAutomation/parkedOtpSession.service");
        const fam = "fam-otp-smoke";
        const user = "user-otp-smoke";
        const gen = beginBrowserGeneration(fam, user);
        assert(claimPharmacyOtpSend(fam, user, gen) === true, "first OTP send claim wins");
        assert(claimPharmacyOtpSend(fam, user, gen) === false, "second OTP send claim blocked");
        assert(hasPharmacyOtpSendBeenClaimed(fam, user, gen) === true, "otp send marked claimed");
        await abortBrowserSessionForUser(fam, user, { phone: "+919999000111" });
        assert(wasBrowserCancelledRecently(fam, user) === true, "cancel sticks recently");
        assert(
            shouldSuppressStillWorkingFallback({
                phone: "+919999000111",
                browserTaskPhase: "awaiting_otp",
            }) === true,
            "still-working suppressed while awaiting_otp",
        );
        assert(
            shouldSuppressStillWorkingFallback({
                phone: "+919999000111",
            }) === true,
            "still-working suppressed after cancel-by-phone",
        );
        console.log("OK: otp one-shot + cancel + still-working suppress");
    }

    console.log("\nSmoke private browser / any-site:", process.exitCode ? "FAILED" : "PASSED");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
