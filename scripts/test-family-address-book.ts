/**
 * Family address book: pure helpers + (with TEST_MONGODB_URI, e.g. a throwaway local mongod)
 * migration, per-member defaults, nickname resolution, cross-family isolation, API auth.
 * Usage: NODE_ENV=test npx tsx scripts/test-family-address-book.ts
 *        TEST_MONGODB_URI=mongodb://127.0.0.1:27999/abtest NODE_ENV=test npx tsx scripts/test-family-address-book.ts
 * Synthetic addresses only.
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import {
    formatFull,
    keyLines,
    matchPlace,
    nicknameKey,
    splitAddress,
    storeAddressMatchesPlace,
    tidyNickname,
} from "../src/services/familyAddressBook.service";

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
    Promise.resolve()
        .then(fn)
        .then(
        () => {
            passed++;
            console.log(`  ✓ ${name}`);
        },
        (err) => {
            console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`);
            process.exitCode = 1;
        },
    );

const A1 = "Flat 12, Lake View Apartments, Shyamla Hills, Bhopal, Madhya Pradesh 462002";
const A2 = "B-7, Silver Oak Residency, Vijay Nagar, Indore, Madhya Pradesh 452010";

async function pure() {
    console.log("pure helpers");
    await ok("splitAddress parses lines / city / state / pincode", () => {
        const s = splitAddress("C-12, Green Park Society, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001")!;
        assert.equal(s.pincode, "462001");
        assert.equal(s.city, "Bhopal");
        assert.equal(s.state, "Madhya Pradesh");
        assert.equal(s.landmark, "Near Lotus Hotel");
        assert.equal(s.line1, "C-12, Green Park Society");
        assert.equal(formatFull(s), "C-12, Green Park Society, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001");
    });
    await ok("splitAddress rejects no pincode / no street", () => {
        assert.equal(splitAddress("Bhopal"), null);
        assert.equal(splitAddress("462001"), null);
    });
    await ok("nickname normalisation", () => {
        assert.equal(nicknameKey("Beta's Flat!"), "betas flat");
        assert.equal(tidyNickname('  "beti ka ghar". '), "Beti ka ghar");
    });
    const places = [
        { nickname: "Home", defaultForUserIds: ["elder"] },
        { nickname: "Beta's flat", defaultForUserIds: [] },
        { nickname: "Clinic", defaultForUserIds: [] },
    ];
    await ok("matchPlace: ghar / home / mera ghar → Home", () => {
        for (const w of ["ghar", "home", "mera ghar", "Home"]) assert.equal(matchPlace(places, w, "elder")?.nickname, "Home", w);
    });
    await ok("matchPlace: 'beta ke ghar' → Beta's flat; 'clinic' → Clinic", () => {
        assert.equal(matchPlace(places, "beta ke ghar")?.nickname, "Beta's flat");
        assert.equal(matchPlace(places, "betas flat")?.nickname, "Beta's flat");
        assert.equal(matchPlace(places, "clinic")?.nickname, "Clinic");
    });
    await ok("matchPlace: unknown place → null (never a guess)", () => {
        assert.equal(matchPlace(places, "railway station"), null);
        assert.equal(matchPlace(places, "office"), null);
    });
    await ok("matchPlace: ghar with no Home → member default", () => {
        assert.equal(matchPlace([{ nickname: "Flat", defaultForUserIds: ["e"] }, { nickname: "Clinic", defaultForUserIds: [] }], "ghar", "e")?.nickname, "Flat");
    });
    await ok("keyLines picks flat + society", () => {
        // A bare 2-digit flat number is too weak to match on (it hides inside pincodes) → society only.
        assert.deepEqual(keyLines("Flat 12, Lake View Apartments, Shyamla Hills"), ["Lake View Apartments"]);
        assert.deepEqual(keyLines("B-7, Silver Oak Residency"), ["B-7", "Silver Oak Residency"]);
    });
    await ok("store address must match pincode AND key line", () => {
        const p = { line1: "B-7, Silver Oak Residency, Vijay Nagar", pincode: "452010" };
        assert.equal(storeAddressMatchesPlace("B 7 Silver Oak Residency, Vijay Nagar, Indore 452010", p), true);
        assert.equal(storeAddressMatchesPlace("Silver Oak Residency, Indore - 452010", p), true);
        assert.equal(storeAddressMatchesPlace("DLF Phase 3, Gurugram 122002", p), false, "other city default");
        assert.equal(storeAddressMatchesPlace("Some Other Tower, Vijay Nagar, Indore 452010", p), false, "same pincode, other building");
        assert.equal(storeAddressMatchesPlace(null, p), false);
    });
}

async function withDb(uri: string) {
    console.log("database (throwaway)");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const svc = await import("../src/services/familyAddressBook.service");
    const Legacy = (await import("../src/models/recipientDeliveryAddress.model")).default;
    const FamilyAddress = (await import("../src/models/familyAddress.model")).default;
    await FamilyAddress.init();

    await Legacy.create({ familyId: "famA", recipientUserId: "elderA", address: A1, pincode: "462002", source: "caregiver", setByUserId: "cgA" });
    await Legacy.create({ familyId: "famB", recipientUserId: "elderB", address: "H-5, Connaught Place, New Delhi, Delhi 110001", pincode: "110001", source: "caregiver" });

    await ok("migration: legacy rows → 'Home' default per family, idempotent", async () => {
        const n = await svc.migrateAllLegacyAddresses();
        assert.equal(n, 2);
        assert.equal(await svc.migrateAllLegacyAddresses(), 0);
        const a = await svc.listPlaces("famA", { memberUserId: "elderA" });
        assert.equal(a.length, 1);
        assert.equal(a[0]!.nickname, "Home");
        assert.equal(a[0]!.source, "migration");
        assert.deepEqual(a[0]!.defaultForUserIds, ["elderA"]);
        assert.equal(a[0]!.full, A1);
    });
    await ok("resolver: default → Home; named place; never another family's", async () => {
        const beta = await svc.createPlace("famA", { nickname: "Beta's flat", address: A2 }, { source: "dashboard", actorUserId: "cgA" });
        assert.equal((await svc.resolveAddress({ familyId: "famA", memberUserId: "elderA" }))!.nickname, "Home");
        assert.equal((await svc.resolveAddress({ familyId: "famA", memberUserId: "elderA", nickname: "beta ke ghar" }))!.addressId, beta.addressId);
        const b = await svc.resolveAddress({ familyId: "famB", memberUserId: "elderB", nickname: "beta ke ghar" });
        assert.equal(b!.pincode, "110001", "famB falls back to ITS OWN default");
        assert.equal(await svc.resolveAddress({ familyId: "famC", memberUserId: "elderC" }), null, "no book → null (ask)");
        assert.equal(await svc.getPlace("famB", beta.addressId), null, "famB can't read famA's place by id");
    });
    await ok("choice: confirmed place wins for 45 min, then default", async () => {
        const beta = (await svc.listPlaces("famA")).find((p) => p.nickname === "Beta's flat")!;
        await svc.setChoice("famA", "elderA", beta.addressId);
        assert.equal((await svc.resolveAddress({ familyId: "famA", memberUserId: "elderA" }))!.nickname, "Beta's flat");
        const { FamilyAddressChoice } = await import("../src/models/familyAddress.model");
        await FamilyAddressChoice.updateOne({ familyId: "famA", memberUserId: "elderA" }, { $set: { chosenAt: new Date(Date.now() - 46 * 60_000) } });
        assert.equal((await svc.resolveAddress({ familyId: "famA", memberUserId: "elderA" }))!.nickname, "Home");
        await assert.rejects(svc.setChoice("famB", "elderB", beta.addressId), /not found/i);
    });
    await ok("set default per member; one default per member", async () => {
        const beta = (await svc.listPlaces("famA")).find((p) => p.nickname === "Beta's flat")!;
        await svc.setDefaultPlace("famA", beta.addressId, "elderA");
        const all = await svc.listPlaces("famA", { memberUserId: "elderA" });
        assert.equal(all.filter((p) => p.defaultForUserIds.includes("elderA")).length, 1);
        assert.equal(svc.pickDefault(all, "elderA")!.nickname, "Beta's flat");
    });
    await ok("nickname unique per family (409), same nickname fine in another family", async () => {
        await assert.rejects(svc.createPlace("famA", { nickname: "home", address: A2 }, { source: "dashboard" }), /already exists/);
        const x = await svc.createPlace("famB", { nickname: "Beta's flat", address: A2 }, { source: "dashboard" });
        assert.equal(x.familyId, "famB");
    });
    await ok("validation: bad pincode / missing nickname rejected", async () => {
        await assert.rejects(svc.createPlace("famA", { nickname: "X", line1: "12 Road", pincode: "012345" }, { source: "dashboard" }), /pincode/);
        await assert.rejects(svc.createPlace("famA", { line1: "12 Road", pincode: "462001" }, { source: "dashboard" }), /nickname/);
    });
    await ok("chat save: reuses matching place; new → provisional name", async () => {
        const again = await svc.savePlaceFromChat({ familyId: "famA", memberUserId: "elderA", address: A2 });
        assert.equal(again!.created, false);
        const fresh = await svc.savePlaceFromChat({ familyId: "famA", memberUserId: "elderA", address: "Shop 3, Arera Medical Plaza, Arera Colony, Bhopal, Madhya Pradesh 462016" });
        assert.equal(fresh!.created, true);
        assert.equal(fresh!.place.nickname, "New place");
        const renamed = await svc.updatePlace("famA", fresh!.place.addressId, { nickname: "Clinic" });
        assert.equal(renamed.nickname, "Clinic");
        const firstEver = await svc.savePlaceFromChat({ familyId: "famD", memberUserId: "elderD", address: A1 });
        assert.equal(firstEver!.place.nickname, "Home");
        assert.deepEqual(firstEver!.place.defaultForUserIds, ["elderD"]);
    });
    await ok("store addresses filtered to the family book", async () => {
        const rows = await svc.filterStoreAddressesToBook("famA", [
            { line1: "Flat 12, Lake View Apartments", city: "Bhopal", pincode: "462002", label: "Home" },
            { line1: "Tower 9, DLF Phase 3", city: "Gurugram", pincode: "122002", label: "Other" },
        ]);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.place.nickname, "Home");
        assert.equal((await svc.filterStoreAddressesToBook("famC", rows)).length, 0);
    });
    await ok("delete: gone, choice cleared, migration doesn't resurrect it", async () => {
        const home = (await svc.listPlaces("famA")).find((p) => p.nickname === "Home")!;
        await svc.setChoice("famA", "elderA", home.addressId);
        await svc.deletePlace("famA", home.addressId);
        assert.equal(await svc.getPlace("famA", home.addressId), null);
        assert.equal(await svc.migrateAllLegacyAddresses(), 0);
        assert.equal((await svc.listPlaces("famA")).some((p) => p.nickname === "Home"), false);
        await assert.rejects(svc.deletePlace("famB", (await svc.listPlaces("famA"))[0]!.addressId), /not found/i);
    });

    // API auth (controller + real Family model).
    const Family = (await import("../src/models/family.model")).default;
    const { FamilyRole, FamilyMemberStatus } = await import("../src/types/family.types");
    await Family.create({
        familyId: "famAPI",
        name: "API test family",
        createdBy: "cg1",
        members: [
            { userId: "cg1", role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED },
            { userId: "el1", role: FamilyRole.CARE_RECIPIENT, status: FamilyMemberStatus.JOINED, name: "El" },
            { userId: "vo1", role: FamilyRole.VIEW_ONLY, status: FamilyMemberStatus.JOINED },
        ],
    });
    const c = await import("../src/controllers/familyAddress.controller");
    const call = async (fn: (req: never, res: never) => Promise<void>, user: string, params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}) => {
        let status = 200;
        let json: unknown;
        const res = { status: (s: number) => ((status = s), res), json: (j: unknown) => ((json = j), res) };
        try {
            await fn({ user: { userId: user }, params, body, query } as never, res as never);
        } catch (err) {
            status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 500;
            json = { message: (err as Error).message };
        }
        return { status, json: json as { data?: { address?: { addressId: string; nickname: string }; addresses?: Array<{ nickname: string; isDefaultForMember?: boolean }> }; message?: string } };
    };
    await ok("API: caregiver CRUD + set default; view-only reads; outsiders 403", async () => {
        const created = await call(c.createFamilyAddressHandler, "cg1", { familyId: "famAPI" }, { nickname: "Home", address: A1, defaultForUserIds: ["el1"] });
        assert.equal(created.status, 201, JSON.stringify(created.json));
        const id = created.json.data!.address!.addressId;
        assert.equal((await call(c.createFamilyAddressHandler, "vo1", { familyId: "famAPI" }, { nickname: "X", address: A2 })).status, 403);
        assert.equal((await call(c.listFamilyAddressesHandler, "outsider", { familyId: "famAPI" })).status, 403);
        assert.equal((await call(c.getFamilyAddressHandler, "cg1", { familyId: "famA", addressId: id })).status, 403, "not a member of famA");
        const list = await call(c.listFamilyAddressesHandler, "vo1", { familyId: "famAPI" }, {}, { memberUserId: "el1" });
        assert.equal(list.json.data!.addresses![0]!.isDefaultForMember, true);
        const patched = await call(c.updateFamilyAddressHandler, "cg1", { familyId: "famAPI", addressId: id }, { nickname: "Ghar" });
        assert.equal(patched.json.data!.address!.nickname, "Ghar");
        assert.equal((await call(c.updateFamilyAddressHandler, "cg1", { familyId: "famAPI", addressId: id }, { pincode: "12345" })).status, 400);
        assert.equal((await call(c.setDefaultFamilyAddressHandler, "cg1", { familyId: "famAPI", addressId: id }, { memberUserId: "stranger" })).status, 400);
        assert.equal((await call(c.setDefaultFamilyAddressHandler, "cg1", { familyId: "famAPI", addressId: id }, { memberUserId: "el1" })).status, 200);
        assert.equal((await call(c.createFamilyAddressHandler, "cg1", { familyId: "famAPI" }, { nickname: "Y", address: A2, memberUserIds: ["stranger"] })).status, 400);
        assert.equal((await call(c.deleteFamilyAddressHandler, "cg1", { familyId: "famAPI", addressId: id })).status, 200);
        assert.equal((await call(c.deleteFamilyAddressHandler, "cg1", { familyId: "famAPI", addressId: id })).status, 404);
    });
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
}

(async () => {
    await pure();
    const uri = process.env.TEST_MONGODB_URI;
    if (uri) {
        if (/cosmos|azure|mongodb\+srv/i.test(uri)) throw new Error("TEST_MONGODB_URI must be a throwaway local DB");
        await withDb(uri);
    } else console.log("(set TEST_MONGODB_URI to a throwaway local mongod for the DB tests)");
    console.log(process.exitCode ? "FAILED" : `all ${passed} passed`);
})();
