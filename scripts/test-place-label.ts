/** Places shown to the elder / put in app links never carry raw map numbers. */
import { CURRENT_LOCATION, coordsFromText, displayLabel, hasCoords } from "../src/services/rideBooking/placeLabel";
import { formatRouteSummary, parseLocationPin, placeFromText } from "../src/services/rideBooking/slotParse";
import { nameFor, olaLink, rapidoLink, uberLink } from "../src/services/rideBooking/rideServices";
import { pinPlan } from "../src/services/rideBooking/pinPlan";
import { airportPlace } from "../src/services/rideBooking/airports";
import { pinTipFor } from "../src/services/rideBooking/ola/olaCopy";
import { isSubstantiveForLanguage, noteLanguage, preferredLang } from "../src/services/saheliRouter.service";
import { OLA_PRE_BOOKING_PHASES } from "../src/services/rideBooking/types";

let fail = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : ` → ${JSON.stringify(got)}`}`); if (!c) fail++; };
const NUM = /\d{1,3}\.\d{3,}/;

ok("coords detected", hasCoords("21.24036026001, 81.693542480469, RAIPUR"));
ok("coords parsed", JSON.stringify(coordsFromText("21.24036026001, 81.693542480469, RAIPUR")) === JSON.stringify({ lat: 21.24036026001, lng: 81.693542480469 }));
ok("normal label kept", displayLabel("Sector 18, Noida") === "Sector 18, Noida" && displayLabel("21.24, 81.69") === "");
const echoed = placeFromText("21.24036026001, 81.693542480469, RAIPUR");
ok("echoed pin text → pin with map point", echoed.lat === 21.24036026001 && echoed.source === "location_pin" && echoed.shortLabel === CURRENT_LOCATION, echoed);
const pin = parseLocationPin("[location lat=21.2408237 lng=81.6936378]")!;
ok("bare WhatsApp pin label", pin.shortLabel === CURRENT_LOCATION && !pin.address, pin);
const pinNamed = parseLocationPin('[location lat=21.2408237 lng=81.6936378 name="21.2408, 81.6936"]')!;
ok("pin whose name is numbers", pinNamed.shortLabel === CURRENT_LOCATION, pinNamed);
// The exact place saved from the 28 Sep live try.
const live = { raw: "21.24036026001, 81.693542480469, RAIPUR", shortLabel: "21.24036026001, 81.693542480469, RAIPUR", address: "21.24036026001, 81.693542480469, RAIPUR", lat: 21.2408237, lng: 81.6936378 };
const drop = { shortLabel: "Raipur Airport", address: "Raipur Airport, Raipur, India", lat: 21.1854, lng: 81.7459 };
ok("name → Current location", nameFor(live) === CURRENT_LOCATION, nameFor(live));
for (const [n, l] of [["ola", olaLink(live, drop)], ["uber", uberLink(live, drop)], ["rapido", rapidoLink(live, drop)]] as const)
    ok(`${n} link has no raw numbers in names`, !NUM.test(decodeURIComponent(String(l)).replace(/(lat|lng|latitude|longitude)[^&]*/gi, "")), l);
ok("route summary", !NUM.test(formatRouteSummary(live, drop)) && formatRouteSummary(live, drop).includes(CURRENT_LOCATION), formatRouteSummary(live, drop));
ok("route summary, map point only", formatRouteSummary({ lat: 21.2, lng: 81.6 }, drop).includes(CURRENT_LOCATION));


// ── WhatsApp location pin, in every order (webhook shape: "[location lat=… lng=… name=… address=…]") ──
{
    const RAIPUR = "[location lat=21.2408 lng=81.6936]";
    const pinA = parseLocationPin(RAIPUR)!;
    const pinB = parseLocationPin('[location lat=21.2408 lng=81.6936 name="Telibandha Lake" address="GE Road, Raipur"]')!;
    ok("webhook pin with name/address", pinB.lat === 21.2408 && pinB.shortLabel === "Telibandha Lake" && pinB.address === "GE Road, Raipur", pinB);
    const airport = { raw: "Raipur airport", shortLabel: "Raipur Airport", lat: 21.1804, lng: 81.7388 };
    const home = { raw: "C504, SUNITA PARK, RAIPUR", shortLabel: "C504, SUNITA PARK", address: "C504, SUNITA PARK, LABHANDIH, RAIPUR" };
    const now = Date.now();
    let p = pinPlan(null, null, pinA, now);
    ok("pin first, nothing asked yet → pickup set, ask drop", p.phase === "need_drop" && p.pickup.lat === 21.2408 && !p.drop, p);
    p = pinPlan({ phase: "need_pickup", drop: airport }, null, pinA, now);
    ok("drop then pin → both, straight to apps", p.phase === "confirming_route" && p.drop === airport && p.pickup.lng === 81.6936, p);
    p = pinPlan(null, { drop: airport, at: new Date(now - 5 * 60_000) }, pinA, now);
    ok("after a failed saved-home try → pin pickup + that drop", p.phase === "confirming_route" && p.pickup.lat === 21.2408 && p.drop === airport && !(p.pickup as { address?: string }).address?.includes("SUNITA"), p);
    p = pinPlan({ phase: "ola_pick_type", drop: airport }, null, pinA, now, OLA_PRE_BOOKING_PHASES as readonly string[]);
    ok("during Ola ride choice → Ola page released, pin is pickup", p.releaseOla && p.pickup.lat === 21.2408 && p.drop === airport, p);
    p = pinPlan({ phase: "confirming_route", drop: airport }, null, pinA, now);
    ok("pin beats a saved home pickup", p.pickup.lat === 21.2408 && p.pickup.shortLabel !== home.shortLabel, p);
    p = pinPlan(null, { drop: airport, at: new Date(now - 45 * 60_000) }, pinA, now);
    ok("old ride (>30 min) not reused", p.phase === "need_drop" && !p.drop, p);
    const ola = olaLink(p.pickup, airport) || "", ub = uberLink(p.pickup, airport) || "", rp = rapidoLink(p.pickup, airport) || "";
    ok("pin coords reach the Ola link", ola.includes("21.2408") && ola.includes("81.6936"), ola);
    ok("pin coords reach the Uber link", ub.includes("21.2408") && ub.includes("81.6936") && !/my_location/.test(ub), ub);
    // Rapido's web link takes place names only (no map point in its format); it must stay readable.
    ok("Rapido link readable, no raw numbers", /rapido/.test(rp) && !/\d{1,3}\.\d{3,}/.test(rp), rp);
    ok("no 'share location' tip after a pin", pinTipFor("hinglish", false, p.pickup) === "" && pinTipFor("en", false, pinB) === "");
    ok("tip only when there is no map point", pinTipFor("hinglish", false, home) !== "" && pinTipFor("hinglish", true, home) === "");
}
// ── The airport she names wins over her home city ──
ok("'raipur airport' from a Mumbai family → Raipur", airportPlace("raipur airport, Mumbai")?.shortLabel === "Raipur Airport", airportPlace("raipur airport, Mumbai"));
ok("'raipur airport' → Raipur", airportPlace("raipur airport")?.shortLabel === "Raipur Airport");
ok("'airport T3' from Gurugram → Delhi T3", /T3/.test(airportPlace("airport T3, Gurugram")?.shortLabel || ""), airportPlace("airport T3, Gurugram"));
ok("'airport' from Mumbai → Mumbai", /Mumbai/.test(airportPlace("airport, Mumbai")?.shortLabel || ""), airportPlace("airport, Mumbai"));
// ── Her language sticks: short replies don't flip it ──
{
    const ph = "+919997000999";
    ok("'Ok' is not substantive", !isSubstantiveForLanguage("Ok") && !isSubstantiveForLanguage("1") && !isSubstantiveForLanguage("[location lat=21.2 lng=81.6]"));
    noteLanguage(ph, "mujhe airport jaana hai abhi", "hinglish");
    noteLanguage(ph, "Ok", "en");
    ok("Hinglish stays after 'Ok'", preferredLang(ph) === "hinglish", preferredLang(ph));
    noteLanguage(ph, "please book me a cab to the airport", "en");
    ok("a full English message switches it", preferredLang(ph) === "en", preferredLang(ph));
}
console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
