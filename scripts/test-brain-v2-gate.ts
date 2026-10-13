/** Brain v2 rollout switch: off by default, shadow for everyone, live only for named families. */
import { brainPerson, brainV2Mode, brainRole } from "../src/services/brainV2.service";

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

// The brain gets who each member is, and to whom (the member who added them), so it never guesses a relation.
const maa = brainPerson({ userId: "e1", name: " Kamla ", role: "CARE_RECIPIENT", relationship: "Mother", invitedBy: "c1" });
ok("relation passed with the member it is to", maa.relation === "Mother" && maa.relation_to === "c1" && maa.name === "Kamla", maa);
const spouse = brainPerson({ userId: "e2", name: "Hema", role: "CARE_RECIPIENT", relationship: "Spouse", invitedBy: "c2" });
ok("a spouse stays a spouse", spouse.relation === "Spouse" && spouse.role === "elder", spouse);
const self = brainPerson({ userId: "c1", name: "Prem", role: "PRIMARY_CAREGIVER" });
ok("no relation is invented for the person who made the family", !("relation" in self) && !("relation_to" in self), self);
const noInviter = brainPerson({ userId: "e3", name: "Asha", role: "CARE_RECIPIENT", relationship: "Mother" });
ok("a relation with no one it is to is left out", !("relation" in noInviter), noInviter);
const own = brainPerson({ userId: "e4", name: "Ravi", role: "CO_CAREGIVER", relationship: "Son", invitedBy: "e4" });
ok("a relation to oneself is left out", !("relation" in own), own);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
