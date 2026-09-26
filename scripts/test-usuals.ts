/** Offline tests: Saheli's "usuals" instinct (concept keys, usual match, choice count, declines). `npm run test:usuals` */
import { asksForDifferentProduct, conceptKey, matchUsual, shapeChoices, usualAck } from "../src/services/commerceAutomation/usuals/usualsCore";
import type { UsualItem, UsualRejection } from "../src/models/elderUsuals.model";
import { detectBlockedItem } from "../src/services/commerceAutomation/blockedItems";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const day = 86_400_000;
const milk: UsualItem = { key: "milk", category: "grocery", name: "Amul Lactose Free Milk 250 ml", partner: "instamart", pricePaise: 10400, placeNickname: "Home", aliases: ["doodh"], count: 4, lastAt: new Date(Date.now() - 3 * day), intervalDays: 3 };
const eggs: UsualItem = { key: "eggs", category: "grocery", name: "Eggoz Farm Fresh Eggs 6 pcs", partner: "zepto", pricePaise: 7900, aliases: [], count: 2, lastAt: new Date(Date.now() - 9 * day) };
const pbm: UsualItem = { key: "paneer butter masala", category: "food", name: "Paneer Butter Masala", partner: "swiggy", restaurantName: "Haldiram's", aliases: [], count: 3, lastAt: new Date(Date.now() - 5 * day) };
const items = [milk, eggs, pbm];

// Concept keys (Hindi / Hinglish / Devanagari → one concept).
eq("doodh mangwa do → milk", conceptKey("doodh mangwa do"), "milk");
eq("dudh chahiye → milk", conceptKey("dudh chahiye"), "milk");
eq("दूध → milk", conceptKey("दूध मंगवा दो"), "milk");
eq("ande la do → eggs", conceptKey("ande la do"), "eggs");
eq("dahi → curd", conceptKey("thoda dahi mangwa do"), "curd");
eq("dish key", conceptKey("paneer butter masala mangwa do"), "paneer"); // SYN wins for paneer family

// Usual match.
eq("vague milk → usual", matchUsual(items, [], { query: "milk", text: "doodh mangwa do", category: "grocery" })?.name, milk.name);
eq("named different brand → not the usual", matchUsual(items, [], { query: "amul gold milk", text: "amul gold doodh chahiye", category: "grocery" }), null);
eq("different platform → not the usual", matchUsual(items, [], { query: "milk", text: "blinkit se doodh", category: "grocery", partners: ["blinkit"] }), null);
eq("eggs usual", matchUsual(items, [], { query: "eggs", text: "ande mangwa do", category: "grocery" })?.partner, "zepto");
eq("unknown item → none", matchUsual(items, [], { query: "atta", text: "atta mangwa do", category: "grocery" }), null);
eq("asksForDifferentProduct(plain)", asksForDifferentProduct("doodh", milk), false);

// Rejection learning: declined after the last order → no longer auto-offered.
const rej: UsualRejection[] = [{ item: milk.name, partner: "instamart", reason: "bahut mehenga hai", at: new Date() }];
eq("declined usual not re-offered", matchUsual(items, rej, { query: "milk", text: "doodh mangwa do", category: "grocery" }), null);
const oldRej: UsualRejection[] = [{ item: milk.name, reason: "x", at: new Date(Date.now() - 10 * day) }];
eq("decline before a later re-order doesn't block", matchUsual(items, oldRej, { query: "milk", text: "doodh", category: "grocery" })?.name, milk.name);

// Choice count.
const opts = [
    { name: "Amul Taaza Toned Milk 500 ml", pricePaise: 2900 },
    { name: "Amul Lactose Free Milk 250 ml", pricePaise: 10400 },
    { name: "Mother Dairy Full Cream Milk 500 ml", pricePaise: 3500 },
    { name: "Nandini Milk 500 ml", pricePaise: 2600 },
    { name: "Heritage Milk 500 ml", pricePaise: 2800 },
];
eq("usual → 1 option", shapeChoices("Amul Lactose Free Milk 250 ml", opts, { usual: milk }).shown.map((o) => o.name), [milk.name]);
eq("usual hit flag", shapeChoices("Amul Lactose Free Milk 250 ml", opts, { usual: milk }).usualHit, true);
eq("vague → max 3", shapeChoices("milk", opts).shown.length, 3);
eq("clear single match → 1", shapeChoices("mother dairy full cream", opts).shown.map((o) => o.name), ["Mother Dairy Full Cream Milk 500 ml"]);
eq("never 5", shapeChoices("milk", opts).shown.length <= 3, true);
eq("declined option dropped", shapeChoices("milk", [opts[1]!, ...opts], { rejections: rej }).shown.some((o) => o.name === milk.name), false);
eq("declined option kept if she names it", shapeChoices("amul lactose free milk", opts, { rejections: rej }).shown.some((o) => o.name === milk.name), true);

// Instant ack copy + harmful items still blocked before any usual.
eq("ack", usualAck(milk), "Getting your usual milk 🥛");
eq("cigarette still blocked", detectBlockedItem("meri usual cigarette mangwa do")?.cat ?? null, "tobacco");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
