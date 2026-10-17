/** Brain v2 rollout switch: off by default, shadow for everyone, live only for named families. */
import { brainPerson, brainV2Mode, brainRole, brainV2LogFields, replyMessages } from "../src/services/brainV2.service";
import { readFileSync } from "fs";
import { join } from "path";
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
const privateLog = JSON.stringify(brainV2LogFields({ familyId: "12345678-raw-family", role: "CARE_RECIPIENT", ms: 12,
    model: "model-a", text: "PRIVATE_INCOMING_SENTINEL", reply: "PRIVATE_REPLY_SENTINEL", actions: [{ tool: "note", ok: true }] }));
ok("brain logs retain diagnostics without raw text or full family id", !privateLog.includes("PRIVATE_") && !privateLog.includes("raw-family")
    && privateLog.includes('"textLength":25') && privateLog.includes('"replyLength":22') && privateLog.includes('"family":"12345678"'), privateLog);

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

const bubbles = replyMessages({ reply: "Four.", messages: ["Four.", "Saved.", "No reply to the later check-in."] });
ok("separate topics stay separate messages, answer first", bubbles.length === 3 && bubbles[0] === "Four." && bubbles[2].includes("check-in"), bubbles);
ok("an older engine with only a reply still sends that one message", replyMessages({ reply: "Hello." }).join() === "Hello.");
ok("an empty turn sends nothing", replyMessages({ reply: "none", messages: [] }).length === 0);

// Live 17 Oct: "Here", quoting a photo of four medicine strips, reached Saheli without the photo, and she said "Okay, noted".
// Every brain call from WhatsApp carries the quoted message id (the engine adds what that photo showed), a failed re-download
// of the quoted photo is logged, and the note still asks for the photo again by default (the engine uses its kept reading instead). (Source checks: the
// routing needs a live family to run end to end.)
{
    const routing = readFileSync(join(__dirname, "../src/services/whatsappRouting.service.ts"), "utf8");
    const v2 = readFileSync(join(__dirname, "../src/services/brainV2.service.ts"), "utf8");
    const calls = routing.match(/runBrainV2\(\{[\s\S]*?\}\)/g) ?? [];
    ok("every WhatsApp brain call passes the quoted message id", calls.length >= 2 && calls.every((c) => /replyTo: (body\.replyToId|a\.replyTo)/.test(c)), calls.length);
    const answers = routing.match(/return answerWithBrain\(\{[\s\S]*?\}\);/g) ?? [];
    ok("answerWithBrain gets it on every path", answers.length >= 2 && answers.every((c) => c.includes("replyTo: body.replyToId")), answers.length);
    ok("the engine payload carries reply_to", v2.includes("reply_to: input.replyTo"));
    ok("a failed quoted download is logged", routing.includes("quoted media download failed"));
    ok("a quoted photo that cannot be opened again keeps the honest ask-again note (the engine overrides it when it read the photo)", routing.includes("which can no longer be opened; ask them to send it again"));
}

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
