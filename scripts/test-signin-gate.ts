/** Offline tests: store sign-in / OTP only after the literal word "confirm". `npm run test:signin-gate` */
import fs from "fs";
import { isLiteralConfirm, isSoftYes } from "../src/services/commerceAutomation/literalConfirm";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

for (const t of ["confirm", "Confirm", "CONFIRM", " confirm ", "confirm.", "confirm!", "*confirm*", "confirm order"]) eq(`literal: ${JSON.stringify(t)}`, isLiteralConfirm(t), true);
// The 0001 repro text, soft yeses, and look-alikes never count.
for (const t of ["doodh mangwa do", "yes", "haan", "ok", "okay", "theek hai", "place", "kar do", "confirm karo", "please confirm", "confirmed?", "i confirm the milk", "don't confirm", "1", "", "confirmmm"])
    eq(`not literal: ${JSON.stringify(t)}`, isLiteralConfirm(t), false);
for (const t of ["yes", "haan", "ok", "theek hai", "kar do"]) eq(`soft yes: ${t}`, isSoftYes(t), true);
eq("repeat ask is not a soft yes", isSoftYes("doodh mangwa do"), false);

// Static guard: every place that starts a store login is behind isLiteralConfirm.
const starters: Array<[string, RegExp]> = [
    ["src/services/commerceAutomation/browserTaskWhatsApp.service.ts", /beginOtpLogin\(/g],
    ["src/services/pharmacyOrderFlow.service.ts", /beginOtpLogin\(/g],
    ["src/services/rideBooking/rideWhatsApp.service.ts", /const challenge = `ride-/g],
];
for (const [file, re] of starters) {
    const src = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(src))) {
        n++;
        const before = src.slice(Math.max(0, m.index - 3500), m.index);
        eq(`${file.split("/").pop()} login #${n} gated by isLiteralConfirm`, /isLiteralConfirm\(/.test(before), true);
    }
    eq(`${file.split("/").pop()} has a login starter`, n > 0, true);
}
// Router "confirm" on a website product card never maps straight to "confirm".
const routed = fs.readFileSync("src/services/commerceAutomation/browserTaskWhatsApp.service.ts", "utf8");
const caseConfirm = routed.slice(routed.indexOf('case "confirm":'), routed.indexOf('case "cancel":', routed.indexOf('case "confirm":')));
eq("router confirm on sku card checks the raw text", /awaiting_sku_confirm[\s\S]*isLiteralConfirm\(rawText\)/.test(caseConfirm), true);
eq("browser_order tool needs confirmText", /need_literal_confirm/.test(fs.readFileSync("src/services/saheliTools.service.ts", "utf8")), true);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
