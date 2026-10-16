/** Real email only from production (15 Oct 2026: a test run on a laptop with a live key in .env emailed the founder test
 * alerts: "[Kavach ops] s", "family fam-w · someone · Metformin", a forged-webhook warning).
 * Team email only for a crisis (founder 17 Oct 2026: "do not send me these alerts, only the suicidal emergency alert"). */
import assert from "node:assert/strict";
import { realEmailAllowed, sendCareTeamAlert, sendOpsAlert, sendTeamReport, setEmailClientForTests, teamEmailAllowed } from "../src/services/email.service";
import { alertOps, noteTeamDigest, resetOpsAlerts } from "../src/services/opsAlert.service";

assert.ok(realEmailAllowed({ NODE_ENV: "production" }), "production sends");
assert.ok(!realEmailAllowed({ NODE_ENV: "development" }) && !realEmailAllowed({}) && !realEmailAllowed({ NODE_ENV: "test" }), "development and tests never send");
assert.ok(realEmailAllowed({ NODE_ENV: "development", EMAIL_SEND: "on" }) && !realEmailAllowed({ NODE_ENV: "production", EMAIL_SEND: "off" }), "EMAIL_SEND overrides");
assert.ok(teamEmailAllowed("crisis"), "a crisis emails the team");
assert.ok(!teamEmailAllowed("emergency_alone") && !teamEmailAllowed("ops") && !teamEmailAllowed("report"), "nothing else does");

void (async () => {
    // a send outside production goes nowhere, even with a key set
    process.env.RESEND_API_KEY = "re_not_a_real_key";
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    await sendCareTeamAlert("s", "t", "crisis").catch((e: unknown) => assert.fail(`must not throw: ${String(e)}`));
    process.env.NODE_ENV = before;

    // only the crisis alert reaches the mail client
    const sent: Array<Record<string, unknown>> = [];
    setEmailClientForTests({ emails: { send: async (m) => { sent.push(m); return { error: null }; } } });
    assert.equal((await sendCareTeamAlert("[Kavach] URGENT: someone may be in crisis", "t", "crisis")).sent, true);
    assert.deepEqual(await sendCareTeamAlert("[Kavach] URGENT: emergency, no one else", "t", "emergency_alone"), { sent: false, muted: true, to: 0 });
    assert.deepEqual(await sendCareTeamAlert("[Kavach ops] reminders 2026-10-16", "t"), { sent: false, muted: true, to: 0 });
    assert.deepEqual(await sendOpsAlert("Saved cart step broke", "t"), { sent: false, muted: true, to: 0 });
    assert.deepEqual(await sendTeamReport("Nightly score NOT STORED", "t", "<b>t</b>"), { sent: false, muted: true, to: 0 });
    resetOpsAlerts();
    assert.deepEqual(await alertOps("reminder-tick-stopped", "Reminders are not running", "t", { now: 0 }), { sent: false, muted: true });
    assert.equal(await noteTeamDigest("template", "A template was refused", "t", []), true, "a muted note counts as handled");
    assert.deepEqual(sent.map((m) => m.subject), ["[Kavach] URGENT: someone may be in crisis"]);
    setEmailClientForTests(null);
    console.log("email gate: all passed");
})();
