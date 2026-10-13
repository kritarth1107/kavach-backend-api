/** The public emergency link never carries an identity document number; everything a helper needs stays. */
import assert from "node:assert/strict";
import { cardForPublic } from "../src/services/emergencyCard.service";

const card = {
    allergies: [{ name: "Penicillin" }],
    none: { allergy: false },
    profile: { blood_group: "B+", id_note: "Aadhaar 9999 8888 7777", insurance: "Star Health", age: "72" },
    medicines: [{ name: "Telma 40" }],
};
const pub = cardForPublic(card);
assert.equal((pub.profile as Record<string, unknown>).id_note, undefined, "the ID number is left out of the public card");
assert.equal(pub.profile.blood_group, "B+", "blood group stays");
assert.equal(pub.profile.insurance, "Star Health", "insurance stays");
assert.deepEqual(pub.allergies, card.allergies, "allergies stay");
assert.equal(card.profile.id_note, "Aadhaar 9999 8888 7777", "the family's own card is not changed");
assert.equal(cardForPublic(null), null, "no card stays no card");
assert.deepEqual(cardForPublic({ medicines: [] }), { medicines: [], profile: undefined }, "a card without a profile passes");
console.log("✓ public emergency card: no ID number; blood group, insurance, allergies kept; the family's card unchanged");
