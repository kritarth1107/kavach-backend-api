/**
 * Saheli's place tools (list_places / save_place / remove_place / delivery_place matched): the family address book from
 * WhatsApp, with the dashboard's rules (order lab 2026-10-10: "Saheli has no tool to save a new delivery place").
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/pltest NODE_ENV=test npx tsx scripts/test-place-tools.ts
 * Synthetic addresses only.
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";

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

const HOME = "C-12, Green Park Society, Near Lotus Hotel, Bhopal, Madhya Pradesh 462001";
const FLAT = "Flat 7, Silver Oak Residency, Vijay Nagar, Indore, Madhya Pradesh 452010";

async function pure() {
    console.log("pure");
    const { findByWords } = await import("../src/services/placeTools.service");
    const p = (nickname: string, city: string, pincode: string) => ({ nickname, city, pincode, defaultForUserIds: [] as string[] }) as never;
    const places = [p("Home", "Bhopal", "462001"), p("Beta's flat", "Indore", "452010")];
    await ok("words find a place by name, pincode, or a city only one place has", () => {
        assert.equal((findByWords(places, "beta ke flat") as { nickname: string })?.nickname, "Beta's flat");
        assert.equal((findByWords(places, "452010") as { nickname: string })?.nickname, "Beta's flat");
        assert.equal((findByWords(places, "Indore") as { nickname: string })?.nickname, "Beta's flat");
        assert.equal(findByWords(places, "Delhi"), null);
        assert.equal(findByWords([...places, p("Clinic", "Indore", "452011")], "Indore"), null, "two places in that city: ask");
    });
}

async function withDb(uri: string) {
    console.log("with DB");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const Family = (await import("../src/models/family.model")).default;
    const { FamilyRole, FamilyMemberStatus } = await import("../src/types/family.types");
    await Family.create({
        familyId: "famP",
        name: "Place tools family",
        createdBy: "cg1",
        members: [
            { userId: "cg1", role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED },
            { userId: "el1", role: FamilyRole.CARE_RECIPIENT, status: FamilyMemberStatus.JOINED, name: "El" },
            { userId: "vo1", role: FamilyRole.VIEW_ONLY, status: FamilyMemberStatus.JOINED },
        ],
    });
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");
    const { listPlaces } = await import("../src/services/familyAddressBook.service");
    const tool = (tool: string, args: Record<string, unknown>, actor = "el1") =>
        executeSaheliTool({ tool: tool as never, args, familyId: "famP", recipientUserId: "el1", actorUserId: actor });

    await ok("no places yet: the list says to ask for an address", async () => {
        const r = (await tool("list_places", {})) as { places: unknown[]; note: string };
        assert.equal(r.places.length, 0);
        assert.match(r.note, /full address with pincode/);
    });
    await ok("the elder saves their first address: named Home and their default", async () => {
        const r = (await tool("save_place", { address: HOME })) as { ok: boolean; created: boolean; place: { name: string; isDefault: boolean } };
        assert.equal(r.ok, true);
        assert.equal(r.created, true);
        assert.equal(r.place.name, "Home");
        assert.equal(r.place.isDefault, true);
        const [row] = await listPlaces("famP");
        assert.equal(row!.source, "whatsapp");
        assert.equal(row!.city, "Bhopal");
    });
    await ok("a second address needs a name; with one it is saved with its receiver, not the default", async () => {
        const nameless = (await tool("save_place", { address: FLAT }, "cg1")) as { ok: boolean; error: string };
        assert.equal(nameless.ok, false);
        assert.match(nameless.error, /what to call/);
        const r = (await tool("save_place", { address: FLAT, name: "beta's flat", receiver_name: "Vish", receiver_phone: "9000012345" }, "cg1")) as {
            ok: boolean;
            place: { name: string; receiver: string; isDefault: boolean };
        };
        assert.equal(r.ok, true);
        assert.equal(r.place.name, "Beta's flat");
        assert.equal(r.place.receiver, "Vish, ending 2345");
        assert.equal(r.place.isDefault, false);
    });
    await ok("the same address again is not saved twice", async () => {
        const r = (await tool("save_place", { address: FLAT.replace("Flat 7", "Flat 7 ") })) as { created: boolean; place: { name: string } };
        assert.equal(r.created, false);
        assert.equal(r.place.name, "Beta's flat");
        assert.equal((await listPlaces("famP")).length, 2);
    });
    await ok("a name already used for another address is not overwritten silently", async () => {
        const r = (await tool("save_place", { address: "House 3, Lake Road, Bhopal, Madhya Pradesh 462003", name: "Home" })) as { ok: boolean; error: string };
        assert.equal(r.ok, false);
        assert.match(r.error, /already saved/);
    });
    await ok("change a saved place: rename, receiver, default", async () => {
        const r = (await tool("save_place", { place: "beta ka flat", name: "Vish's Home", make_default: true })) as { ok: boolean; place: { name: string; isDefault: boolean } };
        assert.equal(r.ok, true);
        assert.equal(r.place.name, "Vish's Home");
        assert.equal(r.place.isDefault, true);
        const bad = (await tool("save_place", { place: "Office", name: "X" })) as { ok: boolean; places: string[] };
        assert.equal(bad.ok, false);
        assert.deepEqual(bad.places.sort(), ["Home", "Vish's Home"]);
    });
    await ok("a bad address or phone is refused with a reason", async () => {
        assert.match(((await tool("save_place", { address: "near the temple", name: "Mandir" })) as { error: string }).error, /pincode/);
        assert.match(((await tool("save_place", { place: "Home", receiver_phone: "12" })) as { error: string }).error, /10–13 digits/);
    });
    await ok("view-only members cannot save; only caregivers remove, after a yes", async () => {
        assert.equal(((await tool("save_place", { address: HOME, name: "X" }, "vo1")) as { ok: boolean }).ok, false);
        assert.match(((await tool("remove_place", { place: "Home", confirmed: true })) as { error: string }).error, /caregiver/);
        assert.match(((await tool("remove_place", { place: "Home" }, "cg1")) as { error: string }).error, /confirm/);
        const r = (await tool("remove_place", { place: "Home", confirmed: true }, "cg1")) as { ok: boolean; left: string[] };
        assert.equal(r.ok, true);
        assert.deepEqual(r.left, ["Vish's Home"]);
    });
    await ok("delivery_place says when the named place is not saved (no silent default)", async () => {
        const miss = (await tool("delivery_place", { words: "Clinic" })) as { matched: boolean; nickname: string; saved: string[] };
        assert.equal(miss.matched, false);
        assert.deepEqual(miss.saved, ["Vish's Home (Indore 452010)"]);
        const hit = (await tool("delivery_place", { words: "vish ka ghar" })) as { matched: boolean; nickname: string };
        assert.equal(hit.matched, true);
        assert.equal(hit.nickname, "Vish's Home");
        assert.equal(((await tool("delivery_place", { words: "" })) as { matched: unknown }).matched, null);
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
