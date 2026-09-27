/** No outgoing WhatsApp text may name the tech stack; progress lines name only the active task. */
import { scrubStack, hasStackWords } from "../src/services/stackScrub";
import { stillWorkingLine } from "../src/services/stillWorkingCopy";
import { rideAppHandoffMessage } from "../src/services/rideBooking/rideHandoff";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const leaks = [
    "I'm still working on that (browser can be slow). If you get an SMS OTP (Uber / commerce), paste it here.",
    "Apollo Pharmacy blocked the browser session (CAPTCHA / bot check). Reply *retry* or *cancel* — nothing was ordered.",
    "Zomato is blocking my browser right now 🙏 Try *Swiggy* instead?",
    "Browser task failed: Target closed. You can retry or *cancel*.",
    "*Blinkit* browser crashed before login (Chromium).",
    "Instamart timed out while the browser was busy.",
    "_Dry-run: no real Uber trip was created. Production uses live Chromium when BROWSER_WORKER_MODE=auto|playwright._",
    "Sorry, the Gemini 3 Pro model on Vertex AI returned a 429 from the server.",
    "I use an LLM via an API behind a webhook.",
    "No live MCP price for \"atta\". Search the catalog and pick a listed item.",
    "I'm Saheli, built on Google Gemini. How can I help?",
    "I run on Google's *Gemini* technology, Papa! But here, I'm just your Saheli, always ready to chat. 💚",
    "Main ChatGPT nahi hoon. Main Saheli hoon.",
];
for (const t of leaks) {
    const out = scrubStack(t);
    ok(`scrubbed: ${t.slice(0, 50)}`, !hasStackWords(out) && out.length > 0, out);
}
ok("model question → secret recipe", /secret recipe/.test(scrubStack("I run on Google's *Gemini* technology, Papa! But here, I'm just your Saheli.")));
ok("hindi secret recipe", /hamari secret recipe/.test(scrubStack("Main Google Gemini AI par chalti hoon, Maa.")));
ok("keeps normal text", scrubStack("Found on *Blinkit* 🛒\n1. Amul Taaza — ₹30") === "Found on *Blinkit* 🛒\n1. Amul Taaza — ₹30");
ok("keeps zodiac Gemini", scrubStack("Aapki rashi Gemini hai? Bahut badhiya!").includes("Gemini"));
ok("keeps retry sentence", /retry/.test(scrubStack("Browser task failed: boom. You can retry or *cancel*.")));
ok("keeps urls", scrubStack("Tap https://m.uber.com/ul/?action=setPickup&x=api").includes("https://m.uber.com/ul/"));

const ride = { rideDraft: { phase: "awaiting_otp", provider: "uber", drop: { shortLabel: "Raipur Airport" }, savedAt: new Date() } };
const sw = stillWorkingLine(ride, "en");
ok("still-working names the ride", /Uber ride to Raipur Airport/.test(sw), sw);
ok("still-working has no menu", !/pharmacy|Apollo|OTP|medicine/i.test(sw) && !hasStackWords(sw), sw);
const newer = stillWorkingLine({ ...ride, pharmacyDraft: { phase: "x", partner: "apollo", searchQuery: "Dolo 650", savedAt: new Date(Date.now() + 1000) } }, "en");
ok("newest task wins", /Apollo Pharmacy for Dolo 650/.test(newer) && !/Uber/.test(newer), newer);
ok("hindi still-working", /bas ek pal/.test(stillWorkingLine(ride, "hi")));
ok("plain still-working", !hasStackWords(stillWorkingLine(null, "en")));

const hand = rideAppHandoffMessage({ phase: "confirming_route", provider: "uber", pickup: { lat: 21.2, lng: 81.6, shortLabel: "Home" }, drop: { lat: 21.18, lng: 81.74, address: "Swami Vivekananda Airport, Raipur" }, routeSummary: "Home → Airport" });
ok("ride handoff has deep link", hand.includes("https://m.uber.com/ul/?action=setPickup"), hand);
ok("ride handoff never promises a code", !/may text|will send|forward it here|paste/i.test(hand) && !hasStackWords(hand), hand);

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
