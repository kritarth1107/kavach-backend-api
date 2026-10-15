/**
 * A morning burst of reminders must leave within a couple of minutes.
 * 3,000 stub sends, 20 at a time. No database, no WhatsApp, no model.
 * A serial send of the same work is timed on 100 of them and scaled, so the before/after is measured here.
 */
import assert from "node:assert/strict";
import { runPool } from "../src/utils/pool";

const N = 3000;
const DELAY_MS = 20;
const POOL = 20;

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const sample = 100;
    const serialStart = Date.now();
    for (let i = 0; i < sample; i++) await wait(DELAY_MS);
    const serialMs = Date.now() - serialStart;
    const serialEstimate = Math.round((serialMs / sample) * N);

    let inflight = 0;
    let maxInflight = 0;
    const start = Date.now();
    await runPool(Array.from({ length: N }, () => async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await wait(DELAY_MS);
        inflight -= 1;
    }), POOL);
    const elapsed = Date.now() - start;
    console.log(`serial estimate ${serialEstimate} ms; pool ${POOL} measured ${elapsed} ms; max in flight ${maxInflight}`);
    assert.ok(maxInflight <= POOL, `in flight ${maxInflight} exceeded ${POOL}`);
    assert.ok(maxInflight >= POOL - 1, `pool did not fill (max ${maxInflight})`);
    assert.ok(elapsed < 120_000, `burst took ${elapsed} ms, over 2 minutes`);
    assert.ok(elapsed * 4 < serialEstimate, `pool was not clearly faster (${elapsed} vs serial ${serialEstimate})`);
    console.log("1 passed");
}

void main();
