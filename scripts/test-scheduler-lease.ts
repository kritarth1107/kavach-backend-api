/**
 * Two tasks overlap during a roll. Only the one that holds the lease runs the tick.
 */
import { createMemoryLeaseStore, LEASE_TTL_MS, runIfLeader, SCHEDULER_LEASE } from "../src/workers/schedulerLease";
import { webhookAlreadyMatches } from "../src/clients/metaWhatsApp.client";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

async function twoInstancesOneTick() {
    const store = createMemoryLeaseStore();
    let ticks = 0;
    const tick = async () => {
        ticks += 1;
    };
    const run = (owner: string, now: number) =>
        runIfLeader(store, SCHEDULER_LEASE, owner, now, LEASE_TTL_MS, tick);

    const a = await run("task-a", 0);
    const b = await run("task-b", 0);
    ok("two instances, one tick", a && !b && ticks === 1, { a, b, ticks });

    const bBlocked = await run("task-b", LEASE_TTL_MS - 1);
    ok("other task still blocked before the lease expires", !bBlocked && ticks === 1, { bBlocked, ticks });

    const renewed = await run("task-a", 60_000);
    ok("holder renews and ticks again", renewed && ticks === 2, { renewed, ticks });

    const taken = await run("task-b", 60_000 + LEASE_TTL_MS);
    ok("expired lease is taken by the other task", taken && ticks === 3, { taken, ticks });

    const aBlocked = await run("task-a", 60_000 + LEASE_TTL_MS);
    ok("previous holder does not double the tick", !aBlocked && ticks === 3, { aBlocked, ticks });
}

function webhookIsIdempotent() {
    const url = "https://api.brainbehindkavach.me/api/webhooks/whatsapp";
    const match = webhookAlreadyMatches(
        url,
        [{ id: "app", overrideCallbackUri: url }],
        [{ object: "whatsapp_business_account", callbackUrl: url, fields: ["messages"], active: true }],
        "app",
    );
    ok("webhook already pointed here is a no-op", match);

    const other = webhookAlreadyMatches(
        url,
        [{ id: "app", overrideCallbackUri: "https://old.example/hook" }],
        [{ object: "whatsapp_business_account", callbackUrl: url, fields: ["messages"], active: true }],
        "app",
    );
    ok("a different callback is not treated as done", !other);

    const noMessages = webhookAlreadyMatches(
        url,
        [{ id: "app", overrideCallbackUri: url }],
        [{ object: "whatsapp_business_account", callbackUrl: url, fields: ["account_update"], active: true }],
        "app",
    );
    ok("missing messages field is not treated as done", !noMessages);
}

twoInstancesOneTick()
    .then(() => webhookIsIdempotent())
    .catch((err) => {
        console.error(err);
        fail++;
    })
    .finally(() => {
        if (fail) {
            console.error(`${fail} failed`);
            process.exit(1);
        }
        console.log("scheduler lease: all passed");
    });
