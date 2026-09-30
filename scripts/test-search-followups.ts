/** Protein-bar triage regressions (pure): address never repeats, MCP auth failures are named, offers are bound. */
import assert from "node:assert/strict";
import { formatFull, splitAddress } from "../src/services/familyAddressBook.service";
import { composeAddress } from "../src/services/addressUnderstanding.service";
import { isMcpAuthError, isMcpSessionGlitch, describeMcpError } from "../src/services/commerceAutomation/mcpCommerce/mcpCommerce.service";
import { offerSummary } from "../src/services/commerceAutomation/browserTaskWhatsApp.service";

let n = 0;
const t = (name: string, fn: () => void) => {
    fn();
    n++;
    console.log(`  ✓ ${name}`);
};

const typed = "74 4th cross 4c sector amrutnagar byatarayanapura bangalore karnataka india 560092";
t("comma-less address: no city guessed from the whole line", () => {
    const p = splitAddress(typed)!;
    assert.equal(p.pincode, "560092");
    assert.equal(p.city, undefined);
    const full = formatFull(p);
    assert.equal(full.match(/amrutnagar/g)!.length, 1, full);
});
t("stored duplicate (line1 ⊃ city) renders once", () => {
    const full = formatFull({
        line1: "74 4th cross 4c sector amrutnagar byatarayanapura bangalore karnataka india",
        city: "74 4th cross 4c sector amrutnagar byatarayanapura bangalore",
        pincode: "560092",
    });
    assert.equal(full, "74 4th cross 4c sector amrutnagar byatarayanapura bangalore karnataka india, 560092");
});
t("comma address still splits city/state", () => {
    const p = splitAddress("Flat 12, Lake View Apartments, Shyamla Hills, Bhopal, Madhya Pradesh 462002")!;
    assert.equal(p.city, "Bhopal");
    assert.equal(p.state, "Madhya Pradesh");
    assert.equal(formatFull(p), "Flat 12, Lake View Apartments, Shyamla Hills, Bhopal, Madhya Pradesh 462002");
});
t("AI parts compose without repeats", () => {
    const s = composeAddress({ line1: "74 4th cross 4c sector", locality: "amrutnagar byatarayanapura", city: "bangalore", state: "karnataka", pincode: "560092" });
    assert.equal(s, "74 4th cross 4c sector, amrutnagar byatarayanapura, bangalore, karnataka 560092");
    assert.equal(composeAddress({ line1: "12 MG road bangalore", locality: null, city: "bangalore", state: null, pincode: "560001" }), "12 MG road bangalore, 560001");
});
t("MCP session 401 is not a revoked store token; invalid_grant still is", () => {
    assert.ok(isMcpSessionGlitch("Streamable HTTP error: Server returned 401 after successful authentication"));
    assert.ok(!isMcpAuthError("Streamable HTTP error: Server returned 401 after successful authentication"));
    assert.ok(isMcpAuthError("invalid_grant: refresh token revoked"));
    assert.ok(!isMcpAuthError("Zepto doesn't deliver to this address right now."));
});
t("empty MCP errors still describe themselves", () => {
    const e = new Error("");
    assert.equal(describeMcpError(e), "Error");
    const c = Object.assign(new Error(""), { code: -32001 });
    assert.equal(describeMcpError(c), "Error code=-32001");
});
t("offer line for the router: fresh only", () => {
    assert.match(offerSummary({ partner: "blinkit", query: "protein bar", at: new Date() })!, /Blinkit.*control=confirm/);
    assert.equal(offerSummary({ partner: "blinkit", query: "protein bar", at: new Date(Date.now() - 21 * 60_000) }), null);
});
console.log(`all ${n} passed`);
process.exit(0);
