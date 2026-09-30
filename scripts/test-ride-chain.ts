/** Multi-app ride hand-off: city tiers, fallback chains, links and copy. */
import {
    chooseServices, cityOfPlaces, detectCity, handoffMessage, noServiceMessage, olaLink, rapidoLink,
    serviceChain, serviceFromText, uberLink, vehicleFromText, isAirport, linkFor, mergeRideConfig, uberCovers,
    DEFAULT_RIDE_CONFIG, type Availability, type RideService,
} from "../src/services/rideBooking/rideServices";
import { hasStackWords } from "../src/services/stackScrub";

let fail = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : ` → ${JSON.stringify(got)}`}`); if (!c) fail++; };
const eq = (n: string, a: unknown, b: unknown) => ok(n, JSON.stringify(a) === JSON.stringify(b), a);

const P = (address: string, lat?: number, lng?: number) => ({ address, lat, lng, shortLabel: address.split(",")[0] });
const CP = P("Connaught Place, New Delhi, Delhi, 110001, India", 28.6315, 77.2167);
const T3 = P("Indira Gandhi International Airport (DEL), Terminal 3, New Delhi, Delhi, India", 28.5562, 77.1);
const BANDRA = P("Bandra West, Mumbai, Maharashtra, India", 19.0544, 72.8406);
const T2 = P("Chhatrapati Shivaji Maharaj International Airport Terminal 2, Mumbai, Maharashtra, India", 19.0969, 72.8745);
const KORA = P("Koramangala, Bengaluru, Karnataka, India", 12.9352, 77.6245);
const KIA = P("Kempegowda International Airport, Bengaluru, Karnataka, India", 13.1989, 77.7068);

// tiers
eq("CP → ncr", cityOfPlaces(CP, T3).tier, "ncr");
eq("Gurugram → ncr", detectCity("Cyber Hub, DLF Phase 2, Gurugram, Haryana").tier, "ncr");
eq("Noida → ncr", detectCity("Sector 18, Noida, Uttar Pradesh").tier, "ncr");
eq("Bandra → mumbai", cityOfPlaces(BANDRA, T2).tier, "mumbai");
eq("Koramangala → bengaluru", cityOfPlaces(KORA, KIA).tier, "bengaluru");
eq("Hyderabad → metro", detectCity("Banjara Hills, Hyderabad, Telangana").tier, "metro");
eq("Raipur → tier2", detectCity("Shankar Nagar, Raipur, Chhattisgarh, 492007, India").tier, "tier2");
eq("Ambikapur → tier3", detectCity("Ambikapur, Surguja, Chhattisgarh, India").tier, "tier3");
eq("DPS Raipur stays Raipur (address tail wins)", cityOfPlaces(P("Delhi Public School, Sejbahar, Raipur, Chhattisgarh, 492015, India"), P("Raipur Junction, Raipur, Chhattisgarh")).tier, "tier2");

// chains
eq("NCR cab", serviceChain("ncr", "cab"), ["uber", "ola", "rapido"]);
eq("Mumbai cab", serviceChain("mumbai", "cab"), ["uber", "ola", "rapido"]);
eq("NCR auto", serviceChain("ncr", "auto"), ["rapido", "uber", "ola"]);
eq("Bengaluru cab", serviceChain("bengaluru", "cab"), ["uber", "rapido", "ola"]);
eq("Bengaluru auto", serviceChain("bengaluru", "auto"), ["rapido", "uber", "ola"]);
eq("Other metro cab", serviceChain("metro", "cab"), ["uber", "ola", "rapido"]);
eq("Tier-2 cab", serviceChain("tier2", "cab"), ["uber", "rapido", "ola"]);
eq("Tier-3 cab", serviceChain("tier3", "cab"), ["rapido", "uber", "ola"]);

const st = (m: Partial<Record<RideService, Availability>>) => (s: RideService) => m[s] ?? "unknown";
let c = chooseServices({ tier: "ncr", vehicle: "cab", status: st({ ola: "yes", rapido: "yes" }), airport: true });
eq("CP→T3 Uber + Ola", [c.primary, c.alt], ["uber", "ola"]);
c = chooseServices({ tier: "bengaluru", vehicle: "auto", status: st({ ola: "yes", rapido: "yes" }), airport: true });
ok("KIA auto: Rapido first + Namma Yatri + airport note", c.primary === "rapido" && c.nammaYatriNote && c.airportAutoNote, c);
c = chooseServices({ tier: "bengaluru", vehicle: "cab", status: st({ ola: "yes", rapido: "yes" }), airport: true });
eq("KIA cab Uber then Rapido", [c.primary, c.alt], ["uber", "rapido"]);
c = chooseServices({ tier: "tier3", vehicle: "cab", status: st({ ola: "no", rapido: "yes" }), airport: false });
eq("Ambikapur → Rapido only", [c.primary, c.alt], ["rapido", null]);
c = chooseServices({ tier: "tier3", vehicle: "cab", status: st({ ola: "no", rapido: "no" }), airport: false });
eq("Rural → none", c.primary, null);
c = chooseServices({ tier: "ncr", vehicle: "cab", requested: "ola", status: st({ ola: "yes", rapido: "yes" }), airport: false });
eq("'Ola se' honoured", [c.primary, c.alt, c.requestedUnavailable], ["ola", "uber", undefined]);
c = chooseServices({ tier: "tier3", vehicle: "cab", requested: "ola", status: st({ ola: "no", rapido: "yes" }), airport: false });
eq("'Ola se' where Ola is off → Rapido + note", [c.primary, c.requestedUnavailable], ["rapido", "ola"]);
c = chooseServices({ tier: "ncr", vehicle: "cab", status: st({ ola: "unknown", rapido: "yes" }), airport: false });
eq("confirmed before unknown", [c.primary, c.alt], ["uber", "rapido"]);

// parsing
eq("auto word", vehicleFromText("Koramangala se airport auto chahiye"), "auto");
eq("cab word", vehicleFromText("cab book karo"), "cab");
eq("ola named", serviceFromText("Ola se book karo"), "ola");
eq("namma yatri", serviceFromText("namma yatri pe"), "namma_yatri");
ok("airport detect", isAirport(T3) && isAirport(KIA) && !isAirport(CP));

// links
const rl = rapidoLink(CP, T3)!;
ok("rapido link encodes parentheses", rl.startsWith("https://m.rapido.bike/unup-home/seo/") && rl.includes("%28DEL%29") && !/[()]/.test(rl) && rl.endsWith("?version=v3"), rl);
const ol = olaLink(CP, T3)!;
ok("ola link has coords + our names", /lat=28.6315&lng=77.2167&drop_lat=28.5562&drop_lng=77.1&pickup_name=Connaught%20Place/.test(ol) && ol.includes("dsw=yes&serviceType=p2p"), ol);
ok("uber ul link", uberLink(CP, T3).startsWith("https://m.uber.com/ul/?action=setPickup"));
eq("ola link needs coords", olaLink(P("x"), T3), null);

// copy
const en = handoffMessage({ choice: chooseServices({ tier: "ncr", vehicle: "cab", status: st({ ola: "yes" }), airport: true }), vehicle: "cab", pickup: CP, drop: T3, lang: "en" })!;
ok("EN message: primary + or-try + nothing booked", /Tap to open \*Uber\*/.test(en) && /Or try \*Ola\*/.test(en) && /Nothing is booked/.test(en), en);
const hi = handoffMessage({ choice: chooseServices({ tier: "bengaluru", vehicle: "auto", status: st({ rapido: "yes" }), airport: true }), vehicle: "auto", pickup: KORA, drop: KIA, lang: "hinglish" })!;
ok("HI message", /kholne ke liye tap kijiye/.test(hi) && /Namma Yatri/.test(hi) && /kuch book nahi hota/.test(hi), hi);
const none = noServiceMessage({ pickup: P("Sheo, Barmer, Rajasthan"), lang: "en", canOfferFamily: true });
ok("no-service offers family (offer only)", /Shall I message your family/.test(none), none);
for (const [n, t] of [["en", en], ["hi", hi], ["none", none], ["none-hi", noServiceMessage({ pickup: CP, lang: "hi", canOfferFamily: true })]]) ok(`no tech words: ${n}`, !hasStackWords(t));

// ── URL encoding: Hindi, apostrophes, &, #, + must round-trip exactly ──
const weird = [
    { lat: 28.6328, lng: 77.2197, shortLabel: "राजीव चौक मेट्रो", address: "राजीव चौक, नई दिल्ली" },
    { lat: 19.0544, lng: 72.8406, shortLabel: "St. Mary's Church & School #3", address: "St. Mary's Church & School #3, Hill Rd + Bandra" },
];
for (const svc of ["uber", "ola", "rapido"] as const) {
    const u = linkFor(svc, weird[0], weird[1]);
    ok(`${svc} link is a valid URL`, !!u && (() => { try { new URL(u!); return true; } catch { return false; } })(), u);
    ok(`${svc} link has no raw spaces / non-ASCII`, !!u && !/[\s\u0080-\uffff]/.test(u!), u);
}
const uu = new URL(uberLink(weird[0], weird[1])!);
const allVals = [...uu.searchParams.values()].join(" | ");
ok("uber decoded values round-trip Hindi", allVals.includes("राजीव चौक"), allVals);
ok("uber decoded values round-trip & # + '", allVals.includes("St. Mary's Church & School #3"), allVals);

// ── Operator config: merges, validates, never breaks ──
const cfg = mergeRideConfig({ cities: { tier2: ["bastar", "  Jagdalpur "] }, cabChains: { tier3: ["ola", "bogus", "uber"] }, disabled: ["rapido", "x"], probeTtlHours: -3, maxProbesPerHour: 5 });
ok("config adds a tier-2 city", detectCity("Main Rd, Jagdalpur, Chhattisgarh", cfg).tier === "tier2");
ok("config default city still there", detectCity("Raipur", cfg).tier === "tier2");
ok("config chain validated (bogus dropped) + disabled removed", JSON.stringify(serviceChain("tier3", "cab", cfg)) === JSON.stringify(["ola", "uber"]), serviceChain("tier3", "cab", cfg));
ok("config auto chain drops disabled rapido", !serviceChain("tier2", "auto", cfg).includes("rapido"));
ok("config bad TTL ignored", cfg.probeTtlHours === 24 && cfg.maxProbesPerHour === 5);
ok("config null doc = defaults", JSON.stringify(mergeRideConfig(null)) === JSON.stringify(DEFAULT_RIDE_CONFIG));
ok("config garbage doc = defaults", JSON.stringify(mergeRideConfig({ cities: 5, cabChains: "x", disabled: {} } as never)) === JSON.stringify(DEFAULT_RIDE_CONFIG));
const uberTown = mergeRideConfig({ uberExtraCities: ["ambikapur"] });
ok("config uber extra town", uberCovers("tier3", "Ambikapur, Chhattisgarh", uberTown) && !uberCovers("tier3", "Ambikapur, Chhattisgarh"));
ok("chooseServices honours config", chooseServices({ tier: "tier3", vehicle: "cab", status: () => "yes", airport: false, cfg }).primary === "ola");

// ── Airports: clean names + terminal pins ──
{
    const { airportPlace } = require("../src/services/rideBooking/airports") as typeof import("../src/services/rideBooking/airports");
    const t3 = airportPlace("IGI Airport T3");
    ok("IGI T3", t3?.shortLabel === "Delhi Airport T3" && Math.abs((t3?.lat || 0) - 28.558) < 0.01, t3);
    ok("delhi airport terminal 1", airportPlace("delhi airport terminal 1")?.shortLabel === "Delhi Airport T1");
    ok("Mumbai T2", airportPlace("Mumbai airport T2")?.shortLabel === "Mumbai Airport T2");
    ok("Gurugram: airport T3 = Delhi T3", airportPlace("airport T3, Gurugram")?.shortLabel === "Delhi Airport T3");
    ok("Noida airport not forced to Delhi", airportPlace("Noida airport")?.shortLabel !== "Delhi Airport T3");
    ok("KIA", airportPlace("KIA")?.shortLabel === "Bengaluru Airport T1");
    ok("raipur airport", airportPlace("raipur airport")?.shortLabel === "Raipur Airport");
    ok("Hindi airport", airportPlace("रायपुर एयरपोर्ट")?.shortLabel === "Raipur Airport" && airportPlace("दिल्ली एयरपोर्ट टर्मिनल 3")?.shortLabel === "Delhi Airport T3");
    ok("not an airport", airportPlace("Connaught Place, Delhi") === null);
    ok("unknown-city airport falls through", airportPlace("airport") === null);
    ok("airport is an airport", isAirport(t3!));
}

{
    const m = handoffMessage({ choice: { primary: "rapido", alt: null, nammaYatriNote: false, airportAutoNote: false }, vehicle: "cab", pickup: P("Ghari Chowk, Ambikapur", 23.1, 83.2), drop: P("Bus stand, Ambikapur", 23.12, 83.19), lang: "en", tier: "tier3" })!;
    ok("small-town Rapido doesn't promise a cab", !/your cab/i.test(m) && /auto or bike/.test(m), m);
}

{
    const { parseFromTo, isClockPhrase } = require("../src/services/rideBooking/slotParse") as typeof import("../src/services/rideBooking/slotParse");
    eq("tomorrow-morning cab is not a pickup", parseFromTo("kal subah ka cab chahiye"), {});
    eq("cab chahiye abhi is not a pickup", parseFromTo("cab chahiye abhi"), {});
    ok("confirm is not a place", !parseFromTo("confirm").bare && isClockPhrase("confirm"));
    const trip = parseFromTo("from home to the airport");
    ok("from home to the airport still parses", trip.pickup === "home" && /airport/i.test(trip.drop || ""), trip);
}

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
