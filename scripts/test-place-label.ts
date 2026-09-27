/** Places shown to the elder / put in app links never carry raw map numbers. */
import { CURRENT_LOCATION, coordsFromText, displayLabel, hasCoords } from "../src/services/rideBooking/placeLabel";
import { formatRouteSummary, parseLocationPin, placeFromText } from "../src/services/rideBooking/slotParse";
import { nameFor, olaLink, rapidoLink, uberLink } from "../src/services/rideBooking/rideServices";

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

console.log(fail ? `\n${fail} failed` : "\nall passed");
process.exit(fail ? 1 : 0);
