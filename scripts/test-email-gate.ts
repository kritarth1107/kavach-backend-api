/** Real email only from production (15 Oct 2026: a test run on a laptop with a live key in .env emailed the founder test
 * alerts: "[Kavach ops] s", "family fam-w · someone · Metformin", a forged-webhook warning). */
import assert from "node:assert/strict";
import { realEmailAllowed, sendCareTeamAlert } from "../src/services/email.service";

assert.ok(realEmailAllowed({ NODE_ENV: "production" }), "production sends");
assert.ok(!realEmailAllowed({ NODE_ENV: "development" }) && !realEmailAllowed({}) && !realEmailAllowed({ NODE_ENV: "test" }), "development and tests never send");
assert.ok(realEmailAllowed({ NODE_ENV: "development", EMAIL_SEND: "on" }) && !realEmailAllowed({ NODE_ENV: "production", EMAIL_SEND: "off" }), "EMAIL_SEND overrides");

void (async () => {
    // a send outside production goes nowhere, even with a key set
    process.env.RESEND_API_KEY = "re_not_a_real_key";
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    await sendCareTeamAlert("s", "t").catch((e: unknown) => assert.fail(`must not throw: ${String(e)}`));
    process.env.NODE_ENV = before;
    console.log("email gate: all passed");
})();
