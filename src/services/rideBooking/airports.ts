/**
 * Major Indian airports with clean names and terminal pins. Map geocoders return odd labels for
 * airports ("IGI Airport T3 Road, Najafgarh"); a ride to the airport should read "Delhi Airport T3".
 */
import type { RidePlace } from "./types";

type Airport = { city: RegExp; alias?: RegExp; name: string; terminals: Record<string, [number, number]>; main: string };

const AIRPORTS: Airport[] = [
    { city: /\b(new\s+)?delhi\b|दिल्ली/i, alias: /\b(igi|indira\s+gandhi)\b/i, name: "Delhi Airport", main: "3",
      terminals: { "1": [28.5654, 77.1193], "2": [28.5552, 77.0844], "3": [28.5579, 77.0835] } },
    { city: /\b(mumbai|bombay)\b|मुंबई/i, alias: /\b(csmia|chhatrapati\s+shivaji|sahar|santacruz)\b/i, name: "Mumbai Airport", main: "2",
      terminals: { "1": [19.0896, 72.8532], "2": [19.1014, 72.8726] } },
    { city: /\b(bengaluru|bangalore)\b|बेंगलुरु|बैंगलोर/i, alias: /\b(kia|kempegowda|devanahalli)\b/i, name: "Bengaluru Airport", main: "1",
      terminals: { "1": [13.1989, 77.7068], "2": [13.1996, 77.7112] } },
    { city: /\b(hyderabad|secunderabad)\b/i, alias: /\b(rgia|rajiv\s+gandhi|shamshabad)\b/i, name: "Hyderabad Airport", main: "1", terminals: { "1": [17.2403, 78.4294] } },
    { city: /\bchennai\b/i, alias: /\b(meenambakkam)\b/i, name: "Chennai Airport", main: "1", terminals: { "1": [12.9941, 80.1709] } },
    { city: /\bkolkata\b/i, alias: /\b(netaji\s+subhas|dum\s*dum)\b/i, name: "Kolkata Airport", main: "1", terminals: { "1": [22.6547, 88.4467] } },
    { city: /\bpune\b/i, alias: /\blohegaon\b/i, name: "Pune Airport", main: "1", terminals: { "1": [18.5793, 73.9089] } },
    { city: /\bahmedabad\b/i, alias: /\bsardar\s+vallabhbhai\b/i, name: "Ahmedabad Airport", main: "1", terminals: { "1": [23.0734, 72.6266] } },
    { city: /\braipur\b|रायपुर/i, alias: /\bswami\s+vivekananda\b/i, name: "Raipur Airport", main: "1", terminals: { "1": [21.1854, 81.7459] } },
    { city: /\bjaipur\b/i, alias: /\bsanganer\b/i, name: "Jaipur Airport", main: "2", terminals: { "2": [26.8242, 75.8122] } },
    { city: /\blucknow\b/i, alias: /\bchaudhary\s+charan\s+singh|amausi\b/i, name: "Lucknow Airport", main: "1", terminals: { "1": [26.7606, 80.8893] } },
    { city: /\b(kochi|cochin)\b/i, alias: /\bnedumbassery\b/i, name: "Kochi Airport", main: "1", terminals: { "1": [10.152, 76.4019] } },
];

const AIRPORT_WORD = /\b(airport|air\s*port|hawai\s*adda|hawai\s*adde|vimaan\s*tal|aerodrome|igi|kia|csmia|rgia)\b|एयरपोर्ट|हवाई\s*अड्ड/i;
const TERMINAL = /\b(?:t|terminal)\s*-?\s*([123])\b|टर्मिनल\s*([123])/i;

/** "IGI T3", "Mumbai airport terminal 2", "Koramangala se KIA" (drop part) → clean airport place. */
export function airportPlace(query: string): RidePlace | null {
    const q = query.trim();
    if (!q || !AIRPORT_WORD.test(q)) return null;
    const a = AIRPORTS.find((x) => x.alias?.test(q)) || AIRPORTS.find((x) => x.city.test(q));
    if (!a) return null;
    const m = q.match(TERMINAL);
    const t = (m?.[1] || m?.[2] || "") in a.terminals ? (m?.[1] || m?.[2])! : a.main;
    const [lat, lng] = a.terminals[t]!;
    const many = Object.keys(a.terminals).length > 1;
    const label = many ? `${a.name} T${t}` : a.name;
    return { raw: q, address: `${label}, ${a.name.replace(" Airport", "")}, India`, shortLabel: label, lat, lng, source: "geocode" };
}
