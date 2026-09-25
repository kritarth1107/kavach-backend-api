/**
 * Live guest catalog check (no login, no OTP): "order wet wipes from apollo" / "wet wipes"
 * must return everyday OTC wet wipes, in stock at 462001, no makeup/eyelid/surface junk.
 *   npx tsx scripts/test-apollo-wipes-search.ts
 */
import assert from "node:assert/strict";
import {
    isEverydayWetWipes,
    normalizeCatalogQuery,
    searchGuestCatalog,
} from "../src/services/commerceAutomation/guestCatalogSearch.service";
import { parseMedicineList, messageLooksLikePharmacyOrder } from "../src/services/pharmacyOrderFlow.service";

(async () => {
    assert.equal(normalizeCatalogQuery("order wet wipes from apollo"), "wet wipes");
    assert.ok(messageLooksLikePharmacyOrder("order wet wipes from apollo"));
    const parsed = parseMedicineList("order wet wipes from apollo");
    assert.deepEqual(parsed.map((p) => [p.name, p.requiresRx]), [["wet wipes", false]]);
    for (const junk of [
        "Hi Life Green Tea & Calendula Makeup Remover Wet Wipes, 15 Count",
        "Neo Medix Ocuwipes Wet Wipes 16X15Cm, 10 Count",
        "Dettol Original Multi-Use Skin & Surface Wipes, 10 Count",
        "Apollo Essentials New Born Baby Diaper 30 Count + Apollo Essentials Baby Wipes 40 Count, Compo Pack",
    ]) assert.equal(isEverydayWetWipes(junk), false, junk);

    for (const q of ["order wet wipes from apollo", "wet wipes", "baby wipes"]) {
        const r = await searchGuestCatalog({ partner: "apollo", query: q, pincode: "462001" });
        console.log(`\n== "${q}" → query "${r.query}" (${r.hits.length} hits)`);
        r.hits.slice(0, 6).forEach((h, i) =>
            console.log(`${i + 1}. ${h.name} — ₹${(h.pricePaise ?? 0) / 100} | rx=${h.requiresRx} | inStock@462001=${h.inStock} | ${h.productUrl}`),
        );
        assert.ok(r.hits.length >= 3, "at least 3 wipes");
        for (const h of r.hits) {
            assert.equal(h.requiresRx, false, h.name);
            assert.equal(h.inStock, true, `${h.name} in stock at 462001`);
            assert.ok(isEverydayWetWipes(h.name), `junk: ${h.name}`);
            assert.ok(h.productUrl?.startsWith("https://www.apollopharmacy.in/otc/"), h.name);
        }
        assert.ok((r.hits[0]!.pricePaise ?? 1e9) <= 20_000, "top pick is cheap (≤ ₹200)");
    }
    console.log("\nOK wipes search");
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
