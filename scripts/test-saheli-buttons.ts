/** Saheli v2 one-tap buttons: the WhatsApp payload stays inside Meta's limits; long text goes first. */
import { buildLocationRequestMessages, buildSaheliButtonMessages, composeWhatsAppReply, flattenWhatsAppPayloads } from "../src/services/whatsappMessageComposer.service";
import { parseMetaWebhookMessages } from "../src/clients/metaWhatsApp.client";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const btns = [
    { id: "v2:oc:all_fine:alert:x:subj=e1", title: "Sab theek" },
    { id: "v2:oc:doctor_visit:alert:x:subj=e1", title: "Doctor dikhaya bahut lamba title" },
    { id: "v2:oc:hospital_visit:alert:x:subj=e1", title: "Hospital" },
    { id: "v2:oc:other:x", title: "Fourth" },
];
const short = buildSaheliButtonMessages("Asha, Mummy ab kaisi hain?", btns);
ok("short text: one interactive message", short.length === 1 && short[0].type === "interactive", short);
const one = short[0] as Extract<(typeof short)[number], { type: "interactive" }>;
if (one.interactive.type === "button") {
    ok("at most 3 buttons", one.interactive.action.buttons.length === 3, one.interactive.action.buttons.length);
    ok("titles at most 20 chars", one.interactive.action.buttons.every((b) => b.reply.title.length <= 20));
    ok("ids kept", one.interactive.action.buttons[0].reply.id === "v2:oc:all_fine:alert:x:subj=e1");
}
const long = buildSaheliButtonMessages("x".repeat(1500), btns);
ok("long text: text first, then buttons", long.length === 2 && long[0].type === "text" && long[1].type === "interactive", long.map((p) => p.type));

// Founder 2026-10-12: a ride's pickup is asked as a WhatsApp location (a "Send location" button), and the pin comes back as data.
const ask = composeWhatsAppReply("Pickup ke liye apni location bhejiye 📍", { kind: "location_request" });
const card = ask[0] as Extract<(typeof ask)[number], { type: "interactive" }>;
ok("location request: one interactive card", ask.length === 1 && card.type === "interactive" && card.interactive.type === "location_request_message", ask);
ok("location request: send_location action", card.interactive.type === "location_request_message" && card.interactive.action.name === "send_location");
ok("location request: flattened text keeps the question", flattenWhatsAppPayloads(ask) === "Pickup ke liye apni location bhejiye 📍\n[Send location]", flattenWhatsAppPayloads(ask));
const longAsk = buildLocationRequestMessages("y".repeat(1500));
ok("long location request: text first, then the button card", longAsk.length === 2 && longAsk[0].type === "text" && longAsk[1].type === "interactive");
const hook = (location: Record<string, unknown>) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { messages: [{ from: "919000000001", id: "wamid.L1", type: "location", location } ] } }] }],
});
const pin = parseMetaWebhookMessages(hook({ latitude: 21.2514, longitude: 81.6296, name: "Sample Park", address: "12 Civil Lines" }))[0];
ok("pin: data beside the text", pin?.location?.lat === 21.2514 && pin?.location?.lng === 81.6296 && pin?.location?.name === "Sample Park" && pin?.location?.address === "12 Civil Lines", pin);
ok("pin: the text still carries it", (pin?.text || "").startsWith("[location lat=21.2514 lng=81.6296"), pin?.text);
const bare = parseMetaWebhookMessages(hook({ latitude: 12.9716, longitude: 77.5946 }))[0];
ok("current-location pin: point only", bare?.location?.lat === 12.9716 && bare?.location?.name === undefined, bare);
const junk = parseMetaWebhookMessages(hook({ latitude: "x", longitude: 200 }))[0];
ok("a pin without a valid point: no data", junk?.location === undefined, junk);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
