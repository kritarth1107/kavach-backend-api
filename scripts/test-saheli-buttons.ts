/** Saheli v2 one-tap buttons: the WhatsApp payload stays inside Meta's limits; long text goes first. */
import { buildSaheliButtonMessages } from "../src/services/whatsappMessageComposer.service";

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

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
