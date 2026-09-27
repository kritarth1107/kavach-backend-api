/** No outgoing WhatsApp text may name the tech stack; progress lines name only the active task. */
import { scrubStack, hasStackWords } from "../src/services/stackScrub";
import { localizeCanned } from "../src/services/hinglishCanned";
import { TATA_1MG_COPY } from "../src/services/commerceAutomation/siteAllowlist";
import { stillWorkingLine } from "../src/services/stillWorkingCopy";
import { handoffMessage, noServiceMessage, type RideService } from "../src/services/rideBooking/rideServices";

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
    "Zepto blocks automated browsing, so I can't see its items or prices 🙏",
    "Blinkit looks blocked (CAPTCHA / bot wall).",
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

{
    const zepto = "Zepto isn't available for me right now 🙏 I can get it from Instamart or Blinkit instead.\nTo order on Zepto directly, link it once: Dashboard → Integrations → Zepto.";
    for (const [n, t] of [["zepto", zepto], ["1mg", TATA_1MG_COPY]] as const) {
        ok(`${n} copy clean`, !hasStackWords(t) && scrubStack(t) === t, t);
        const h = localizeCanned(t, "hinglish");
        ok(`${n} hindi`, h !== t && !hasStackWords(h), h);
    }
    ok("1mg working-on-it rule", /working on Tata 1mg ordering/.test(TATA_1MG_COPY));
}
const ride = { rideDraft: { phase: "awaiting_otp", provider: "uber", drop: { shortLabel: "Raipur Airport" }, savedAt: new Date() } };
const sw = stillWorkingLine(ride, "en");
ok("still-working names the ride", /Uber ride to Raipur Airport/.test(sw), sw);
ok("still-working has no menu", !/pharmacy|Apollo|OTP|medicine/i.test(sw) && !hasStackWords(sw), sw);
const newer = stillWorkingLine({ ...ride, pharmacyDraft: { phase: "x", partner: "apollo", searchQuery: "Dolo 650", savedAt: new Date(Date.now() + 1000) } }, "en");
ok("newest task wins", /Apollo Pharmacy for Dolo 650/.test(newer) && !/Uber/.test(newer), newer);
ok("hindi still-working", /bas ek pal/.test(stillWorkingLine(ride, "hi")));
ok("plain still-working", !hasStackWords(stillWorkingLine(null, "en")));

const P = { lat: 21.2, lng: 81.6, shortLabel: "Home" };
const D = { lat: 21.18, lng: 81.74, address: "Swami Vivekananda Airport, Raipur" };
for (const lang of ["en", "hi"])
    for (const primary of ["uber", "ola", "rapido"] as RideService[])
        for (const vehicle of ["cab", "auto", "bike"] as const) {
            const alt = (["uber", "ola", "rapido"] as RideService[]).find((x) => x !== primary)!;
            const m = handoffMessage({ choice: { primary, alt, nammaYatriNote: true, airportAutoNote: true }, vehicle, pickup: P, drop: D, lang }) || "";
            ok(`handoff ${lang}/${primary}/${vehicle} has link, no stack words, no code promise`, /https:\/\//.test(m) && !hasStackWords(m) && !/may text|will send|forward it here|paste|otp/i.test(m), m);
        }
for (const lang of ["en", "hi"])
    for (const canOfferFamily of [true, false]) {
        const m = noServiceMessage({ pickup: P, lang, canOfferFamily, familyName: "Priya" });
        ok(`no-service ${lang}/${canOfferFamily} clean`, !!m && !hasStackWords(m), m);
    }

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
