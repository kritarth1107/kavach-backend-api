/**
 * A person's dashboard page lists only the orders placed for that person (founder 2026-10-13: his mother's dashboard
 * showed his own orders and rides). The family order routes take ?subjectUserId=; without it they answer for the whole
 * family as before (WhatsApp and older callers). Only someone the asker may see can be asked for: a care recipient, or
 * the asker themselves in self care, never another caregiver's self care.
 *
 *   TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x npx tsx scripts/test-person-orders.ts
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { testDbUri } from "./test-db";

let fail = 0;
async function ok(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`✓ ${name}`);
    } catch (e) {
        fail++;
        console.log(`✗ ${name} — ${e instanceof Error ? e.message : String(e)}`);
    }
}

(async () => {
    const uri = testDbUri("person_orders");
    if (!uri) {
        console.log("person orders: skipped (no TEST_MONGODB_URI)");
        return;
    }
    await mongoose.connect(uri);
    await mongoose.connection.dropDatabase();
    const Family = (await import("../src/models/family.model")).default;
    const Order = (await import("../src/models/order.model")).default;
    const { listOrderHistory, listPendingApprovals } = await import("../src/services/order.service");
    const { subjectQuery } = await import("../src/controllers/careRecord.controller");

    const fam = "fam-person-orders";
    await Family.create({ familyId: fam, name: "Scope test", createdBy: "u-son", members: [
        { userId: "u-maa", role: "CARE_RECIPIENT", status: "JOINED", name: "Kamla" },
        { userId: "u-son", role: "PRIMARY_CAREGIVER", status: "JOINED", name: "Ravi" },
        { userId: "u-bro", role: "CO_CAREGIVER", status: "JOINED", name: "Mohan" },
    ] });
    const order = (orderId: string, subjectUserId: string, status: string, name: string) =>
        Order.create({ orderId, familyId: fam, subjectUserId, suggestedBy: "u-son", partner: "zepto", status, totalPaise: 10000,
            items: [{ name, quantity: 1, unitPricePaise: 10000 }] });
    await order("o-maa-paid", "u-maa", "paid", "Sugar for Maa");
    await order("o-maa-wait", "u-maa", "awaiting_approval", "Atta for Maa");
    await order("o-son-paid", "u-son", "paid", "Protein bars for Ravi");
    await order("o-son-wait", "u-son", "awaiting_approval", "Mints for Ravi");
    const ids = (rows: Array<{ orderId: string }>) => rows.map((o) => o.orderId).sort();

    await ok("his mother's page: only her orders, never his", async () => {
        assert.deepEqual(ids(await listOrderHistory(fam, "u-son", 20, "u-maa")), ["o-maa-paid", "o-maa-wait"]);
        assert.deepEqual(ids(await listPendingApprovals(fam, "u-son", "u-maa")), ["o-maa-wait"]);
    });
    await ok("his own self-care page: only his orders", async () => {
        assert.deepEqual(ids(await listOrderHistory(fam, "u-son", 20, "u-son")), ["o-son-paid", "o-son-wait"]);
        assert.deepEqual(ids(await listPendingApprovals(fam, "u-son", "u-son")), ["o-son-wait"]);
    });
    await ok("no person asked: the whole family's, as before (WhatsApp, older callers)", async () => {
        assert.equal((await listOrderHistory(fam, "u-son")).length, 4);
        assert.equal((await listPendingApprovals(fam, "u-son")).length, 2);
    });
    await ok("another caregiver cannot ask for his self-care orders", async () => {
        await assert.rejects(() => listOrderHistory(fam, "u-bro", 20, "u-son"));
        await assert.rejects(() => listPendingApprovals(fam, "u-bro", "u-son"));
    });
    await ok("the query value is a plain id or nothing", async () => {
        const q = (v: unknown) => subjectQuery({ query: { subjectUserId: v } } as never);
        assert.equal(q("u-maa"), "u-maa");
        assert.equal(q({ $ne: "x" }), undefined);
        assert.equal(q("a b"), undefined);
        assert.equal(q(undefined), undefined);
    });

    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    if (fail) {
        console.error(`${fail} failed`);
        process.exit(1);
    }
    console.log("person orders passed");
})().catch(async (e) => {
    console.error(e);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
});
