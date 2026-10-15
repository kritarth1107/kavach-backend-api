/**
 * 5,000 fake families, 3,000 of them due this minute. Throwaway database only.
 * The sender waits 15 ms and never calls WhatsApp. The database is dropped at the end.
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27017/unused NODE_ENV=test npx tsx scripts/load-reminder-burst.ts
 */
import mongoose from "mongoose";
import { testDbUri } from "./test-db";

const FAMILIES = 5000;
const DUE = 3000;
const SEND_MS = 15;

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    const uri = testDbUri("kavach_scale_5000");
    if (!uri) throw new Error("set TEST_MONGODB_URI to a local mongod");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const { default: SaheliReminder } = await import("../src/models/saheliReminder.model");
    const { runSaheliReminderTick } = await import("../src/services/saheliReminder.service");
    const { toDateKeyIST, getISTParts } = await import("../src/utils/istTime.util");
    const now = new Date();
    const dateKey = toDateKeyIST(now);
    const mins = getISTParts(now).minutesSinceMidnight;
    const hh = String(Math.floor(mins / 60)).padStart(2, "0");
    const mm = String(mins % 60).padStart(2, "0");
    const dueTime = `${hh}:${mm}`;
    const docs = Array.from({ length: FAMILIES }, (_, i) => ({
        reminderId: `scale-${i}`,
        familyId: `fam-scale-${i}`,
        recipientUserId: `person-${i}`,
        text: "Time for a glass of water",
        times: [i < DUE ? dueTime : "03:11"],
        kind: "multi_time" as const,
        repeat: "once" as const,
        date: dateKey,
        timezone: "Asia/Kolkata",
        status: "active" as const,
        createdBy: "scale",
    }));
    const insertedAt = Date.now();
    await SaheliReminder.insertMany(docs, { ordered: false });
    console.log(`inserted ${FAMILIES} in ${Date.now() - insertedAt} ms`);
    let sent = 0;
    const started = Date.now();
    const out = await runSaheliReminderTick(now, async () => {
        sent += 1;
        await wait(SEND_MS);
        return true;
    });
    const elapsed = Date.now() - started;
    console.log(JSON.stringify({ scanned: out.scanned, tickSent: out.sent, stubSent: sent, elapsedMs: elapsed, due: DUE }));
    if (out.sent !== DUE) throw new Error(`expected ${DUE} sends, got ${out.sent}`);
    if (elapsed > 120_000) throw new Error(`burst took ${elapsed} ms`);
    await mongoose.connection.db!.dropDatabase();
    await mongoose.disconnect();
    console.log("dropped kavach_scale_5000");
}

void main();
