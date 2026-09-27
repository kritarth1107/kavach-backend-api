/** In-chat Ola: page parsing, lifecycle classification, every message (EN + Hinglish), config. */
import { OlaMsg, classifyRidePage, geocodeCandidates, orderRideTypes, parseConfirm, parseDriver, parseRideTypes, pickRideType } from "../src/services/rideBooking/ola/olaCopy";
import { FakeOlaDriver } from "../src/services/rideBooking/ola/olaDriver";
import { mergeRideConfig, DEFAULT_RIDE_CONFIG } from "../src/services/rideBooking/rideServices";
import { hasStackWords } from "../src/services/stackScrub";

let fail = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : ` → ${JSON.stringify(got)}`}`); if (!c) fail++; };

// Lines as read from book.olacabs.com (27 Sep 2026 screenshots).
const loggedOut = ["DAILY RIDES", "OUTSTATION", "RENTALS", "FROM", "Connaught Place, New Delhi", "TO", "Delhi Airport T3", "WHEN", "Now", "AVAILABLE RIDES",
    "Auto", "Get an auto at your doorstep", "4 min", "Mini", "Comfy hatchbacks at pocket-friendly fares", "1 min", "Bike", "Zip through traffic at affordable fares",
    "4 min", "Prime Sedan", "Sedans with free wifi and top drivers", "1 min", "Prime SUV", "SUVs with free wifi and top drivers", "Please log in to check exact prices."];
const lo = parseRideTypes(loggedOut);
ok("logged-out: 5 types", lo.map((t) => t.name).join(",") === "Auto,Mini,Bike,Prime Sedan,Prime SUV", lo);
ok("logged-out: no fares", lo.every((t) => t.fare == null));
// Live page: the "N min" line belongs to the row BELOW it (screen shows Auto –, Mini 4, Bike 1, Sedan 4, SUV 1).
ok("logged-out: ETA taken from line above the name", JSON.stringify(lo.map((t) => t.etaMin ?? null)) === JSON.stringify([null, 4, 1, 4, 1]), lo);
const loggedIn = ["AVAILABLE RIDES", "Auto", "Get an auto at your doorstep", "₹356", "4 min", "Mini", "Comfy hatchbacks at pocket-friendly fares", "₹312",
    "2 min", "Bike", "Zip through traffic at affordable fares", "₹199", "4 min", "Prime Sedan", "Sedans with free wifi and top drivers", "₹322", "1 min", "Prime SUV", "SUVs", "₹477"];
const li = parseRideTypes(loggedIn);
ok("logged-in ETAs not shifted", JSON.stringify(li.map((t) => t.etaMin ?? null)) === JSON.stringify([null, 4, 2, 4, 1]), li);
ok("logged-in fares read", JSON.stringify(li.map((t) => [t.name, t.fare])) === JSON.stringify([["Auto", 356], ["Mini", 312], ["Bike", 199], ["Prime Sedan", 322], ["Prime SUV", 477]]), li);
const gc = geocodeCandidates("C504, SUNITA PARK, LABHANDIH, NEAR TULIP AREA HOTEL, RAIPUR, CHHATTISGARH 492001", "");
ok("lookup: full address first", gc[0]!.startsWith("C504"), gc);
ok("lookup: drops 'near …' part", gc.every((q) => !/NEAR TULIP/.test(q) || q === gc[0]), gc);
ok("lookup: never city+state only", !gc.some((q) => /^RAIPUR, CHHATTISGARH/.test(q)), gc);
ok("lookup: locality + city tried", gc.includes("LABHANDIH, RAIPUR"), gc);
const ordered = orderRideTypes(li, "cab");
ok("cab ask: cab types first", ordered[0]!.name === "Mini" && ordered.slice(-2).map((t) => t.name).join() === "Auto,Bike", ordered.map((t) => t.name));
ok("auto ask: auto first", orderRideTypes(li, "auto")[0]!.name === "Auto");
ok("pick by number", pickRideType("2", ordered)?.name === ordered[1]!.name);
ok("pick by name", pickRideType("prime sedan wali", ordered)?.name === "Prime Sedan");
ok("pick alias sedan", pickRideType("sedan chahiye", ordered)?.name === "Prime Sedan");
ok("pick alias chhoti", pickRideType("chhoti gaadi", ordered)?.name === "Mini");
ok("pick nonsense → null", pickRideType("kya haal hai", ordered) === null);

const confirmLines = ["4 min away", "Tap on map to adjust pickup", "PICKUP", "Rajiv Chowk Gate No.6", "DROP", "Delhi Airport T3", "FARE", "₹312", "Total fare", "PAY BY", "Cash", "COUPON", "Enter code (optional)", "Confirm & Book"];
const c = parseConfirm(confirmLines, "Mini");
ok("confirm screen parsed", c.pickup === "Rajiv Chowk Gate No.6" && c.drop === "Delhi Airport T3" && c.fare === 312 && c.pay === "Cash", c);

// Lifecycle page states
ok("state: searching", classifyRidePage("Finding a ride for you. Please wait") === "searching");
ok("state: assigned", classifyRidePage("Ramesh Kumar is on the way\nWhite Swift Dzire\nDL 1C AB 1234\nOTP 4821\nArriving in 6 min") === "assigned");
ok("state: no driver", classifyRidePage("Sorry, no cabs are available right now") === "no_driver");
ok("state: couldn't find", classifyRidePage("We couldn't find a driver nearby") === "no_driver");
ok("state: driver cancelled", classifyRidePage("Your driver has cancelled the ride. DL 1C AB 1234 OTP 4821") === "driver_cancelled");
ok("state: cancelled", classifyRidePage("Your ride has been cancelled") === "cancelled");
ok("state: started", classifyRidePage("Your trip has started. Enjoy your ride") === "started");
ok("state: booking page is unknown", classifyRidePage(loggedIn.join("\n")) === "unknown");
const drv = parseDriver(["Ramesh Kumar", "White Swift Dzire", "DL 1C AB 1234", "OTP 4821", "Arriving in 6 min", "Call", "Cancel"]);
ok("plate MH 12 AB 1234", parseDriver(["MH 12 AB 1234"]).plate === "MH 12 AB 1234");
ok("plate KA05MN4321", parseDriver(["KA05MN4321"]).plate === "KA05MN4321");
ok("driver parsed", drv.name === "Ramesh Kumar" && drv.vehicle === "White Swift Dzire" && drv.plate === "DL 1C AB 1234" && drv.otp === "4821" && drv.etaMin === 6, drv);

// Messages: both languages, no tech words, honest wording
const D = { name: "Ramesh Kumar", vehicle: "White Swift Dzire", plate: "DL 1C AB 1234", etaMin: 6, otp: "4821" };
for (const lang of ["en", "hinglish"]) {
    const all = [
        OlaMsg.checking(lang), OlaMsg.types(lang, "Delhi Airport T3", ordered, "https://book.olacabs.com/?x=1"), OlaMsg.types(lang, "Delhi Airport T3", lo, null),
        OlaMsg.confirmSignIn(lang, "Mini", "+917694829888"), OlaMsg.openingSignIn(lang), OlaMsg.otpSent(lang, "+917694829888"), OlaMsg.otpChecking(lang), OlaMsg.otpWrong(lang),
        OlaMsg.confirmBook(lang, c), OlaMsg.booking(lang), OlaMsg.searching(lang), OlaMsg.bookUnverified(lang), OlaMsg.update(lang, 0), OlaMsg.update(lang, 1), OlaMsg.update(lang, 2),
        OlaMsg.assigned(lang, D, 312), OlaMsg.noDriverTimeout(lang, 5), OlaMsg.olaNoDriver(lang), OlaMsg.driverCancelled(lang), OlaMsg.cancelledByUser(lang),
        OlaMsg.cancelAssignedAsk(lang), OlaMsg.cancelRetrying(lang), OlaMsg.cancelStuck(lang, "https://book.olacabs.com/"), OlaMsg.failed(lang, "https://book.olacabs.com/", "https://m.uber.com/ul/"),
        OlaMsg.notCash(lang), OlaMsg.links(lang, "https://m.uber.com/ul/", "https://m.rapido.bike/x"), OlaMsg.stillSearching(lang), OlaMsg.rideOn(lang, D),
    ];
    ok(`${lang}: no tech words in any Ola message`, all.every((m) => !hasStackWords(m)), all.find((m) => hasStackWords(m)));
    ok(`${lang}: phone always masked`, all.every((m) => !/7694829888/.test(m)));
    const u = [0, 1, 2].map((i) => OlaMsg.update(lang, i));
    ok(`${lang}: updates never repeat`, new Set(u).size === 3);
    ok(`${lang}: booking confirm shows vehicle, fare, cash, route`, /Mini/.test(OlaMsg.confirmBook(lang, c)) && /₹312/.test(OlaMsg.confirmBook(lang, c)) && /Cash/.test(OlaMsg.confirmBook(lang, c)) && /Rajiv Chowk/.test(OlaMsg.confirmBook(lang, c)));
    ok(`${lang}: confirm words are literal *confirm*`, /\*confirm\*/.test(OlaMsg.confirmSignIn(lang, "Mini", "+91x1234")) && /\*confirm\*/.test(OlaMsg.confirmBook(lang, c)));
    ok(`${lang}: sign-in ask doesn't claim a code was sent`, !/(has sent|bheja hai)/.test(OlaMsg.confirmSignIn(lang, "Mini", "+91x1234")));
    ok(`${lang}: assigned has driver, plate, ETA, OTP`, ["Ramesh Kumar", "DL 1C AB 1234", "6 min", "4821"].every((x) => OlaMsg.assigned(lang, D, 312).includes(x)));
    ok(`${lang}: timeout offers retry / other ride / links`, /1\./.test(OlaMsg.noDriverTimeout(lang, 5)) && /Uber \/ Rapido/.test(OlaMsg.noDriverTimeout(lang, 5)) && /5 min/.test(OlaMsg.noDriverTimeout(lang, 5)));
}
ok("Hinglish searching line", /Driver dhoondh rahi hoon 🙏/.test(OlaMsg.searching("hinglish")));
ok("caregiver line", /booked an \*Ola Mini\*/.test(OlaMsg.caregiverBooked("Kamla", c, D)) && /DL 1C AB 1234/.test(OlaMsg.caregiverBooked("Kamla", c, D)));

// Scripted Ola (test numbers) follows the lifecycle over (accelerated) time
async function lifecycle() {
    const at = (sec: number) => ({ bookedAt: new Date(Date.now() - sec * 1000), cancelAttempts: 0 });
    const a = new FakeOlaDriver("assigned", 1, at(10));
    ok("fake: searching early", (await a.status()).state === "searching");
    a.bind(at(61));
    const s = await a.status();
    ok("fake: assigned later with driver", s.state === "assigned" && s.driver?.plate === "DL 1C AB 1234");
    const n = new FakeOlaDriver("ola_none", 10, at(10));
    ok("fake: timeScale speeds up (ola says none)", (await n.status()).state === "no_driver");
    const dc = new FakeOlaDriver("driver_cancel", 1, at(130));
    ok("fake: driver cancels after assignment", (await dc.status()).state === "driver_cancelled");
    const cf = new FakeOlaDriver("cancel_fails_once", 1, at(10));
    ok("fake: first cancel fails", (await cf.cancel()) === false);
    cf.bind({ ...at(10), cancelAttempts: 1 });
    ok("fake: retry cancel verified", (await cf.cancel()) === true && (await cf.status()).state === "cancelled");
    const lo2 = new FakeOlaDriver("assigned", 1);
    ok("fake: logged out → login page", (await lo2.choose()) === "login" && (await lo2.startLogin()) === "otp_sent");
    ok("fake: wrong code", (await lo2.submitOtp("0000")) === "invalid");
    ok("fake: right code → confirm screen", (await lo2.submitOtp("1234")) === "confirm" && (await lo2.readConfirm("Mini"))?.fare === 312);
    ok("fake: otp_fail never claims sent", (await new FakeOlaDriver("otp_fail", 1).startLogin()) === "failed");

    // Config
    ok("config default timeout 5 min", DEFAULT_RIDE_CONFIG.olaSearchTimeoutSec === 300 && DEFAULT_RIDE_CONFIG.olaInChat === true);
    const cfg = mergeRideConfig({ olaSearchTimeoutSec: 420, olaUpdateEverySec: 5, olaInChat: false });
    ok("config override timeout, bad update ignored, kill switch", cfg.olaSearchTimeoutSec === 420 && cfg.olaUpdateEverySec === 150 && cfg.olaInChat === false);
    console.log(fail ? `\n${fail} failed` : "\nall passed");
    process.exit(fail ? 1 : 0);
}
void lifecycle();
