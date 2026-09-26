/** Failure copy + phase for browser-task errors (no DB, no network). npx tsx scripts/test-browser-failure-copy.ts */
import assert from "node:assert/strict";
async function main() {
    const { formatPharmacyBrowserFollowUp } = await import("../src/services/commerceAutomation/browserProgressNotify.service");
    const { logBrowserTaskFailure } = await import("../src/services/commerceAutomation/browserWorker.service");
    const base = { status: "error" as const, mode: "playwright" as const, partner: "swiggy", steps: 20, message: "I hit the step limit before finishing" };
    const f = formatPharmacyBrowserFollowUp({ ...base, failureReason: "stalled" });
    assert.match(f.text, /Swiggy opened, but I got stuck/);
    assert.match(formatPharmacyBrowserFollowUp({ ...base, failureReason: "step_limit" }).text, /far longer than it should/);
    assert.match(f.text, /Nothing was ordered or paid/);
    assert.equal(f.phase, "running", "no OTP was requested → digits must not count as OTP");
    const lf = formatPharmacyBrowserFollowUp({ ...base, failureReason: "login_failed", message: "Swiggy says this phone number has no Swiggy account yet, so I can't log in. Nothing was ordered." });
    assert.match(lf.text, /no Swiggy account yet/);
    assert.equal(lf.phase, "running", "login failed → digits must not count as OTP");
    for (const r of ["site_blocked", "unknown", "timeout", "step_limit", "stalled"] as const) {
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
