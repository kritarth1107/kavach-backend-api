/** The admin insights: the growth funnel and the attention list without the engine, and the spend-alert settings. Needs TEST_MONGODB_URI. */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import Family from "../src/models/family.model";
import User from "../src/models/users.model";
import WaitlistEntry from "../src/models/waitlist.model";
import { alertSettings, attention, growth, saveAlertSettings } from "../src/admin/infra/insights";

(async () => {
    const uri = process.env.TEST_MONGODB_URI;
    if (!uri) { console.log("admin insights: skipped (no TEST_MONGODB_URI)"); return; }
    await mongoose.connect(uri);
    await Promise.all([Family.deleteMany({}), User.deleteMany({}), WaitlistEntry.deleteMany({})]);
    await User.collection.insertMany([{ userId: "u1", email: "insights-u1@example.test", firstName: "Asha", lastName: "Rao", phone: "+919000000001", createdAt: new Date(), onboarding: { status: "done", at: new Date() } },
        { userId: "u2", email: "insights-u2@example.test", firstName: "Maa", phone: "+919000000002", createdAt: new Date() }]);
    await Family.collection.insertOne({ familyId: "fam-t1", name: "Test family", createdAt: new Date(), members: [
        { userId: "u1", role: "PRIMARY_CAREGIVER", status: "JOINED" }, { userId: "u2", role: "CARE_RECIPIENT", status: "JOINED" }] });
    await WaitlistEntry.collection.insertMany([{ waitlistId: "w1", source: "dashboard", status: "approved", createdAt: new Date(Date.now() - 86_400_000), approvedAt: new Date() },
        { waitlistId: "w2", source: "whatsapp", status: "pending", createdAt: new Date() }]);
    const g = await growth();
    assert.equal(g.funnel[0].n, 2); assert.equal(g.funnel[1].n, 1); assert.equal(g.funnel[2].n, 2); assert.equal(g.funnel[3].n, 1);
    assert.equal(g.sources.waitlistWhatsapp, 1);
    const a = await attention();
    const fam = a.families.find((f) => f.familyId === "fam-t1")!;
    assert.ok(fam.flags.some((f) => f.text.includes("has never written")), "an elder who never wrote is flagged");
    assert.equal(fam.members.length, 2);
    assert.equal((await alertSettings()).email, false);
    const s = await saveAlertSettings({ jumpPct: 80, email: true, minInr: -5 }, "test@kavach.care");
    assert.equal(s.jumpPct, 80); assert.equal(s.email, true); assert.equal(s.minInr, 500);
    await mongoose.disconnect();
    console.log("admin insights ok");
})().catch((e) => { console.error(e); process.exit(1); });
