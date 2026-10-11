/**
 * Map points for saved places (placeGeo.service), with the network replaced: synthetic addresses in several cities.
 * Usage: NODE_ENV=test npx tsx scripts/test-place-geo.ts
 */
import assert from "node:assert/strict";
import { kmBetween, osmQueries, pointForPlace, setGeoFetcherForTests } from "../src/services/placeGeo.service";

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
    }
};

type Hit = { lat: number; lon: number; postcode?: string; addresstype?: string };
/** A fake OpenStreetMap: postcode → centre; free-text query → hit. Records every query. */
function fakeOsm(centres: Record<string, [number, number]>, texts: Record<string, Hit>) {
    const asked: string[] = [];
    setGeoFetcherForTests(async (url) => {
        const p = new URL(url).searchParams;
        asked.push(p.get("q") ?? `postalcode=${p.get("postalcode")}`);
        if (p.get("postalcode")) {
            const c = centres[p.get("postalcode")!];
            return c ? [{ lat: String(c[0]), lon: String(c[1]), addresstype: "postcode", address: { postcode: p.get("postalcode") } }] : [];
        }
        const h = texts[p.get("q") ?? ""];
        return h ? [{ lat: String(h.lat), lon: String(h.lon), addresstype: h.addresstype ?? "suburb", address: { postcode: h.postcode } }] : [];
    });
    return asked;
}

async function main() {
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.GOOGLE_GEOCODING_API_KEY;
    delete process.env.MAPBOX_ACCESS_TOKEN;
    console.log("place map points");

    await ok("queries: the whole line first, then without the house; never the bare pincode", () => {
        assert.deepEqual(osmQueries("C-12, Green Park Society, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001", "462001"), [
            "C-12, Green Park Society, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001",
            "Green Park Society, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001",
            "Near Lotus Hotel, Bhopal, Madhya Pradesh 462001",
        ]);
        // a comma-less saved line (the Bangalore place of 2026-10-11) is one query; "560011" alone is not asked
        assert.deepEqual(osmQueries("21 5th main 4th block jayanagar bangalore karnataka india, 560011", "560011"), [
            "21 5th main 4th block jayanagar bangalore karnataka india, 560011",
        ]);
        assert.deepEqual(osmQueries("Flat 3, Anna Nagar, Chennai", "600040"), ["Flat 3, Anna Nagar, Chennai 600040", "Anna Nagar, Chennai 600040", "Chennai 600040"]);
    });

    await ok("distance", () => {
        assert.ok(Math.abs(kmBetween({ lat: 12.9716, lng: 77.5946 }, { lat: 12.9299, lng: 77.5826 }) - 4.8) < 0.3);
    });

    await ok("Bangalore: nothing for the street → the pincode's centre (precision pincode)", async () => {
        const asked = fakeOsm({ "560011": [12.9299, 77.5826] }, {});
        const p = await pointForPlace({ full: "21 5th main 4th block jayanagar bangalore karnataka india, 560011", pincode: "560011" });
        assert.deepEqual(p, { lat: 12.9299, lng: 77.5826, source: "openstreetmap_pincode", precision: "pincode" });
        assert.equal(asked.length, 2); // the centre, then the one address query
    });

    await ok("Delhi: the area is found near the pincode's centre (precision area)", async () => {
        fakeOsm({ "110024": [28.5677, 77.2433] }, { "Lajpat Nagar 2, New Delhi, Delhi 110024": { lat: 28.5672, lon: 77.2365, postcode: "110024" } });
        const p = await pointForPlace({ full: "B-14, Lajpat Nagar 2, New Delhi, Delhi 110024", pincode: "110024" });
        assert.equal(p?.precision, "area");
        assert.equal(p?.source, "openstreetmap");
        assert.equal(p?.lat, 28.5672);
    });

    await ok("Mumbai: a house-level hit on the whole line is precision address", async () => {
        fakeOsm({ "400050": [19.0607, 72.8362] }, {
            "12 Pali Hill, Bandra West, Mumbai, Maharashtra 400050": { lat: 19.0681, lon: 72.8265, postcode: "400050", addresstype: "building" },
        });
        const p = await pointForPlace({ full: "12 Pali Hill, Bandra West, Mumbai, Maharashtra 400050", pincode: "400050" });
        assert.equal(p?.precision, "address");
    });

    await ok("a street of the same name in another city is refused (far from the pincode)", async () => {
        fakeOsm({ "492001": [21.2387, 81.6507] }, {
            // "Sample Park" found in Delhi for a Raipur address
            "B12, Sample Park, Civil Lines, Raipur, Chhattisgarh 492001": { lat: 28.6, lon: 77.2, postcode: "110001" },
        });
        const p = await pointForPlace({ full: "B12, Sample Park, Civil Lines, Raipur, Chhattisgarh 492001", pincode: "492001" });
        assert.deepEqual(p, { lat: 21.2387, lng: 81.6507, source: "openstreetmap_pincode", precision: "pincode" });
    });

    await ok("no pincode centre: a hit counts only when it carries the same pincode", async () => {
        fakeOsm({}, {
            "T. Nagar, Chennai, Tamil Nadu 600017": { lat: 13.0418, lon: 80.2341, postcode: "600017" },
            "Flat 9, T. Nagar, Chennai, Tamil Nadu 600017": { lat: 13.05, lon: 80.24, postcode: "600018" },
        });
        const p = await pointForPlace({ full: "Flat 9, T. Nagar, Chennai, Tamil Nadu 600017", pincode: "600017" });
        assert.equal(p?.lat, 13.0418);
        assert.equal(p?.precision, "area");
    });

    await ok("outside India or nothing at all → null (the store then looks with the written address)", async () => {
        fakeOsm({}, { "1 Main Road, Kolkata, West Bengal 700001": { lat: 40.7, lon: -74.0, postcode: "700001" } });
        assert.equal(await pointForPlace({ full: "1 Main Road, Kolkata, West Bengal 700001", pincode: "700001" }), null);
        fakeOsm({}, {});
        assert.equal(await pointForPlace({ full: "", pincode: "" }), null);
    });

    await ok("OpenStreetMap down: the pincode's centre (asked first) is still used; a failed centre is not cached", async () => {
        let n = 0;
        setGeoFetcherForTests(async (url) => {
            n++;
            if (new URL(url).searchParams.get("postalcode")) return [{ lat: "21.2387", lon: "81.6507", address: { postcode: "492001" } }];
            throw new Error("geo HTTP 503");
        });
        const p = await pointForPlace({ full: "B12, Sample Park, Civil Lines, Raipur, Chhattisgarh 492001", pincode: "492001" });
        assert.equal(p?.precision, "pincode");
        assert.equal(n, 2);
    });

    setGeoFetcherForTests(null);
    console.log(`\n${passed} passed`);
}

main();
