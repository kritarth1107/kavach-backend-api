/** Brain v2 rollout switch: off by default, shadow for everyone, live only for named families. */
import { brainPerson, brainV2Mode, brainRole } from "../src/services/brainV2.service";
import { legacyBlockReply, v1MustNotOrder } from "../src/services/legacyGuard.service";

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

// A family on v2: the old (v1) order flow never orders, books, cancels or relays a code (D2.3 step 1).
const live = { live: true, routed: true };
ok("v1 fallback never orders, books or relays a code", ["order_new", "order_modify", "order_control", "ride", "otp_code", "restaurant_list"]
    .every((intent) => v1MustNotOrder({ ...live, intent }) === "send_again"));
ok("v1 fallback still answers chat, health and reminders", ["companion_chat", "health_concern", "reminder_or_meds", "presence_check"]
    .every((intent) => v1MustNotOrder({ ...live, intent }) === null));
ok("both models down: the old regex rules do nothing on their own", v1MustNotOrder({ live: true, routed: false }) === "send_again");
ok("an old order button is refused", ["quick_confirm:abc", "confirm_order", "addr:1", "item:0", "restaurant:2", "recipient:u1", "approve_order:x"]
    .every((id) => v1MustNotOrder({ live: true, routed: false, interactiveId: id }) === "old_button"));
ok("a Done tap and a records button still work", ["done:sched-1", "rec:keep:doc1"]
    .every((id) => v1MustNotOrder({ live: true, routed: false, interactiveId: id }) === null));
ok("a family not on v2 keeps the old flow", v1MustNotOrder({ live: false, routed: true, intent: "order_new", interactiveId: "confirm_order" }) === null);
ok("the refusal speaks their language", legacyBlockReply("send_again", "hi").includes("मिनट") && legacyBlockReply("send_again", "en").includes("minute"));

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
