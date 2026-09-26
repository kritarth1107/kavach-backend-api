/** Offline tests: conversational ordering helpers (relevance pre-filter, chat TTL). `npm run test:order-chat` */
import { prefilter } from "../src/services/commerceAutomation/orderChat/relevance";
import { orderChatActive } from "../src/services/commerceAutomation/orderChat/orderChat.service";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const names = (xs: Array<{ name: string }>) => xs.map((x) => x.name);

// The 8:37 PM incident: "something to eat" listed ketchup ₹0.95 and a sachet ₹1.
const swiggy = [
    { name: "Tomato Ketchup", pricePaise: 95, restaurantName: "Pizza Hut" },
    { name: "Ketchup Sachet", pricePaise: 100, restaurantName: "McDonald's" },
    { name: "Mad Duo Meal", pricePaise: 99800, restaurantName: "KFC" },
    { name: "Extra Cheese", pricePaise: 4000, restaurantName: "Domino's" },
    { name: "Veg Samosa (2 pcs)", pricePaise: 6000, restaurantName: "Haldiram's" },
    { name: "Mint Mayo Dip", pricePaise: 2500, restaurantName: "Subway" },
    { name: "Masala Dosa", pricePaise: 12000, restaurantName: "Sagar Ratna" },
];
eq("food: condiments, sachets, extras, dips and <₹20 dropped", names(prefilter("samosa", swiggy, { food: true })), ["Mad Duo Meal", "Veg Samosa (2 pcs)", "Masala Dosa"]);
eq("asked for ketchup → ketchup kept", names(prefilter("tomato ketchup", [{ name: "Kissan Tomato Ketchup 950g", pricePaise: 15000 }], { food: false })), ["Kissan Tomato Ketchup 950g"]);
eq("grocery: cheap items are fine (no ₹20 floor)", names(prefilter("salt", [{ name: "Tata Salt 1kg", pricePaise: 2800 }, { name: "Parle-G 50g", pricePaise: 500 }], { food: false })), ["Tata Salt 1kg", "Parle-G 50g"]);
eq("grocery: add-on/cutlery junk dropped", names(prefilter("milk", [{ name: "Amul Taaza 1L" }, { name: "Cutlery Set" }], { food: false })), ["Amul Taaza 1L"]);
eq("all junk → nothing listed", prefilter("something to eat", swiggy.slice(0, 2), { food: true }).length, 0);

// Chat state TTL.
eq("fresh chat active", orderChatActive({ updatedAt: Date.now(), startedAt: Date.now(), turns: [], questions: 0 }), true);
eq("stale chat inactive", orderChatActive({ updatedAt: Date.now() - 60 * 60_000, startedAt: 0, turns: [], questions: 0 }), false);
eq("no chat", orderChatActive(undefined), false);

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
