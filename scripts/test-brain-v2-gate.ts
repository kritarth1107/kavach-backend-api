/** Brain v2 rollout switch: off by default, shadow for everyone, live only for named families. */
import { brainV2Mode, brainRole } from "../src/services/brainV2.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

ok("off by default", brainV2Mode("f1", {}) === "off");
ok("shadow for all", brainV2Mode("f1", { BRAIN_V2: "shadow" }) === "shadow");
ok("live family wins over shadow", brainV2Mode("f2", { BRAIN_V2: "shadow", BRAIN_V2_LIVE_FAMILIES: "f1, f2" }) === "live");
ok("unknown value is off", brainV2Mode("f1", { BRAIN_V2: "yes" }) === "off");
ok("roles named for the brain", brainRole("CARE_RECIPIENT") === "elder" && brainRole("PRIMARY_CAREGIVER") === "primary caregiver");

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
