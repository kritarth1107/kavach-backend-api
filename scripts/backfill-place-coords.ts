/**
 * Give every saved place a map point (placeGeo.service): the places saved before 2026-10-11 have none, so fast store
 * look-ups for those families answered 400 or "not found". Only adds lat/lng/geoSource/geoPrecision/geoAt to places
 * that have no point; never changes an address and never deletes anything.
 *
 * Usage: MONGODB_URI=... npx tsx scripts/backfill-place-coords.ts            (dry run: what each place would get)
 *        MONGODB_URI=... npx tsx scripts/backfill-place-coords.ts --apply    (write the points)
 * Prints family ids shortened, pincode and the result only (no street lines).
 */
import mongoose from "mongoose";
import FamilyAddress from "../src/models/familyAddress.model";
import { formatFull } from "../src/services/familyAddressBook.service";
import { pointForPlace } from "../src/services/placeGeo.service";

async function main(): Promise<void> {
    const apply = process.argv.includes("--apply");
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error("MONGODB_URI is not set");
    await mongoose.connect(uri);
    const rows = await FamilyAddress.find({ $or: [{ lat: { $exists: false } }, { lat: null }, { lng: { $exists: false } }, { lng: null }] }).lean();
    console.log(`${rows.length} places without a map point${apply ? "" : " (dry run; --apply writes)"}`);
    const tally: Record<string, number> = {};
    for (const row of rows) {
        const got = await pointForPlace({ full: formatFull(row), pincode: row.pincode }).catch(() => null);
        const what = got ? `${got.precision} via ${got.source}` : "none found";
        tally[what] = (tally[what] || 0) + 1;
        console.log(`  family …${row.familyId.slice(-6)} ${row.nickname} ${row.pincode}: ${what}${got ? ` (${got.lat.toFixed(4)}, ${got.lng.toFixed(4)})` : ""}`);
        if (apply && got) {
            await FamilyAddress.updateOne(
                { addressId: row.addressId, $or: [{ lat: { $exists: false } }, { lat: null }] },
                { $set: { lat: got.lat, lng: got.lng, geoSource: got.source, geoPrecision: got.precision, geoAt: new Date() } },
            );
        }
    }
    console.log("result:", JSON.stringify(tally));
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});
