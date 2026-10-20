/** The console's waitlist filters and numbers. Needs TEST_MONGODB_URI (a throwaway local mongod); skipped without it. */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import WaitlistEntry from "../src/models/waitlist.model";
import { joinWaitlist, listWaitlist, markRegistered, rejectWaitlist, waitlistStats } from "../src/services/waitlist.service";

(async () => {
    const uri = process.env.TEST_MONGODB_URI;
    if (!uri) { console.log("waitlist admin: skipped (no TEST_MONGODB_URI)"); return; }
    await mongoose.connect(uri);
    await WaitlistEntry.deleteMany({});
    const a = await joinWaitlist({ name: "Asha Rao", email: "asha@example.com", source: "dashboard", note: "for my mother" } as never);
    const b = await joinWaitlist({ name: "Ravi K", phone: "+91 98765 11111", source: "whatsapp" } as never);
    const c = await joinWaitlist({ name: "Meena", email: "meena@example.com", source: "dashboard" } as never);
    await WaitlistEntry.updateOne({ waitlistId: a.waitlistId }, { $set: { status: "approved", approvedAt: new Date() } });
    await markRegistered({ waitlistId: a.waitlistId }, "user-1");
    await WaitlistEntry.updateOne({ waitlistId: c.waitlistId }, { $set: { status: "approved", approvedAt: new Date() } });
    await rejectWaitlist(b.waitlistId, "admin@kavach.care");
    assert.equal((await listWaitlist({ q: "mother" })).total, 1);
    assert.equal((await listWaitlist({ q: "98765" })).total, 1);
    assert.equal((await listWaitlist({ source: "whatsapp" })).total, 1);
    assert.equal((await listWaitlist({ status: "waiting" })).entries[0].waitlistId, c.waitlistId);
    assert.equal((await listWaitlist({ status: "joined" })).entries[0].waitlistId, a.waitlistId);
    assert.equal((await listWaitlist({ q: "a.*" })).total, 0); // typed text, never a pattern
    const s = await waitlistStats();
    assert.equal(s.total, 3); assert.equal(s.joined, 1); assert.equal(s.waitingToJoin, 1); assert.equal(s.rejected, 1); assert.equal(s.signUpRate, 50);
    assert.equal(s.bySource.whatsapp, 1); assert.equal(s.daily.length, 14); assert.equal(s.newThisWeek, 3);
    await mongoose.disconnect();
    console.log("waitlist admin ok");
})().catch((e) => { console.error(e); process.exit(1); });
