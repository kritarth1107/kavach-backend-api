/** Failure copy + phase for browser-task errors (no DB, no network). npx tsx scripts/test-browser-failure-copy.ts */
import assert from "node:assert/strict";
async function main() {
    const { formatPharmacyBrowserFollowUp } = await import("../src/services/commerceAutomation/browserProgressNotify.service");
    const { logBrowserTaskFailure } = await import("../src/services/commerceAutomation/browserWorker.service");
    const base = { status: "error" as const, mode: "playwright" as const, partner: "swiggy", steps: 20, message: "I hit the step limit before finishing" };
    const f = formatPharmacyBrowserFollowUp({ ...base, failureReason: "step_limit" });
    assert.match(f.text, /Swiggy opened, but I couldn't get your item into the cart/);
    assert.match(f.text, /Nothing was ordered or paid/);
    assert.equal(f.phase, "running", "no OTP was requested → digits must not count as OTP");
    for (const r of ["site_blocked", "unknown", "timeout"] as const) {
        const t = formatPharmacyBrowserFollowUp({ ...base, failureReason: r }).text;
        assert.doesNotMatch(t, /didn't finish opening the order/, r);
    }
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => lines.push(s);
    logBrowserTaskFailure({ partner: "swiggy" }, { ...base, failureReason: "step_limit", url: "https://www.swiggy.com/city/raipur/x-rest1?phone=9999999999", lastSteps: ["20:/city/raipur/x-rest1:click"] });
    console.log = orig;
    const j = JSON.parse(lines[0]!);
    assert.equal(j.event, "browser_task_failed");
    assert.equal(j.reason, "step_limit");
    assert.equal(j.stage, "page:/city/raipur/x-rest1");
    assert.doesNotMatch(lines[0]!, /9999999999/);
    console.log("browser failure copy/log: 4 checks passed");
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
