/**
 * Smoke: private browser dry-run OTP → confirm → done.
 * Run: BROWSER_WORKER_MODE=dry_run npx tsx scripts/smoke-private-browser.ts
 */
process.env.BROWSER_WORKER_MODE = process.env.BROWSER_WORKER_MODE || "dry_run";
process.env.COMMERCE_SESSION_ENCRYPTION_KEY =
    process.env.COMMERCE_SESSION_ENCRYPTION_KEY || "smoke-test-key-not-for-prod";

import { messageLooksLikeBrowserTask } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";
import { DryRunBrowserWorker } from "../src/services/commerceAutomation/browserWorker.service";
import { resolvePlaybook } from "../src/services/commerceAutomation/playbooks";

function assert(cond: boolean, msg: string) {
    if (!cond) {
        console.error("FAIL:", msg);
        process.exitCode = 1;
    } else {
        console.log("OK:", msg);
    }
}

async function main() {
    const goal = "order vit c from apollo";
    assert(messageLooksLikeBrowserTask(goal), "intent detects order vit c from apollo");
    assert(resolvePlaybook(undefined, goal).partner === "apollo", "playbook resolves apollo");

    const worker = new DryRunBrowserWorker();
    const familyId = "fam-smoke";
    const userId = "user-smoke";

    const step1 = await worker.runBrowserTask({ familyId, userId, goal, partner: "apollo" });
    assert(step1.status === "need_otp", `step1 need_otp (got ${step1.status})`);
    assert(!/not supported/i.test(step1.message), "step1 not 'not supported'");
    assert(/OTP|otp|code/i.test(step1.message), "step1 asks for OTP");

    const step2 = await worker.runBrowserTask({
        familyId,
        userId,
        goal,
        partner: "apollo",
        otp: "123456",
    });
    assert(step2.status === "need_user_confirm", `step2 need_user_confirm (got ${step2.status})`);
    assert(/confirm/i.test(step2.message), "step2 asks confirm");

    const step3 = await worker.runBrowserTask({
        familyId,
        userId,
        goal,
        partner: "apollo",
        userConfirmed: true,
    });
    assert(step3.status === "done", `step3 done (got ${step3.status})`);
    assert(/confirm/i.test(step3.message) || /checkout|UPI|Chromium/i.test(step3.message), "step3 completion copy");

    console.log("\nSmoke private browser:", process.exitCode ? "FAILED" : "PASSED");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
