/**
 * The nightly "0 writes to the old stores" check (trust plan A1, step 5). Since the memory move, nothing may write the
 * retired stores: the Mongo ElderProfile, ElderUsuals, ElderWellbeingDay and DailySnapshot collections, and the engine's
 * Instinct tables (family_memories, memory_entities, memory_profiles). Once a day after 07:00 IST the writes of the last
 * 24 hours are counted (Mongo by createdAt/updatedAt, the engine through GET /v2/jobs/legacy-writes); the result is kept
 * per day (legacy_write_checks), and anything but 0, or an engine that cannot be counted, emails the team (alertOps).
 * "Done when": 7 days in a row at 0 (legacyWriteReport).
 */
import mongoose from "mongoose";
import LegacyWriteCheck, { type ILegacyWriteCheck } from "../models/legacyWriteCheck.model";

export const RETIRED_COLLECTIONS: Record<string, string> = {
    ElderProfile: "elderprofiles",
    ElderUsuals: "elderusuals",
    ElderWellbeingDay: "elderwellbeingdays",
    DailySnapshot: "dailysnapshots",
};
const CHECK_HOUR_IST = 7;

function istDay(d: Date): string {
    return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}
function istHour(d: Date): number {
    return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(d)) % 24;
}

/** Writes to each retired Mongo collection since `since` (a document created or changed). */
export async function countMongoWrites(since: Date): Promise<Record<string, number>> {
    const db = mongoose.connection.db;
    const out: Record<string, number> = {};
    for (const [name, coll] of Object.entries(RETIRED_COLLECTIONS)) {
        out[name] = db ? await db.collection(coll).countDocuments({ $or: [{ createdAt: { $gte: since } }, { updatedAt: { $gte: since } }] }) : 0;
    }
    return out;
}

export type EngineCounter = (hours: number) => Promise<Record<string, number> | null>;

async function engineCounts(hours: number): Promise<Record<string, number> | null> {
    try {
        const { aiEngineJson } = await import("../clients/aiEngine.client");
        const got = await aiEngineJson<{ counts?: Record<string, number> }>("GET", `/v2/jobs/legacy-writes?hours=${hours}`, undefined, 15_000);
        return got.counts ?? null;
    } catch (err) {
        console.warn(`[legacy-writes] engine count failed: ${err instanceof Error ? err.message : err}`);
        return null;
    }
}

/** Count now and keep today's row (once per IST day). force: run even before 07:00 or when today's row exists. */
export async function runLegacyWriteCheck(
    now = new Date(),
    opts: { force?: boolean; engine?: EngineCounter; alert?: (key: string, subject: string, text: string) => Promise<unknown> } = {},
): Promise<ILegacyWriteCheck | null> {
    const day = istDay(now);
    if (!opts.force && (istHour(now) < CHECK_HOUR_IST || (await LegacyWriteCheck.exists({ day })))) return null;
    const since = new Date(now.getTime() - 24 * 3600_000);
    const counts = await countMongoWrites(since);
    const engine = await (opts.engine ?? engineCounts)(24);
    if (engine) Object.assign(counts, engine);
    const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
    const bad = total > 0 || !engine;
    const row: ILegacyWriteCheck = { day, at: now, since, counts, total, engineChecked: Boolean(engine), alerted: bad };
    await LegacyWriteCheck.updateOne({ day }, { $set: row }, { upsert: true });
    if (bad) {
        const alert = opts.alert ?? (async (k, s, t) => (await import("./opsAlert.service")).alertOps(k, s, t));
        const lines = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `- ${k}: ${n}`);
        await alert(
            "legacy-writes",
            total > 0 ? `Old memory stores were written: ${total} writes in 24 h` : "Old memory stores: the engine's Instinct tables could not be counted",
            [
                "Since the memory move (trust plan A1) the old stores must get 0 writes. Last 24 hours:",
                ...(lines.length ? lines : ["- Mongo: 0"]),
                engine ? "" : "The engine's count (GET /v2/jobs/legacy-writes) failed, so family_memories / memory_entities / memory_profiles were not checked.",
                "Find the writer and remove it; the drift guards (scripts/test-no-legacy-memory.ts, the engine's test) should have caught it.",
            ].filter(Boolean).join("\n"),
        );
    }
    console.log(`[legacy-writes] ${day}: total=${total} engine=${engine ? "ok" : "unreachable"}`);
    return row;
}

/** The last `days` daily rows, newest first, and whether every one of them was 0 (the 7-day bar). */
export async function legacyWriteReport(days = 7): Promise<{ days: ILegacyWriteCheck[]; zeroDays: number; allZero: boolean }> {
    const rows = await LegacyWriteCheck.find({}).sort({ day: -1 }).limit(days).lean<ILegacyWriteCheck[]>();
    const zeroDays = rows.filter((r) => r.total === 0 && r.engineChecked).length;
    return { days: rows, zeroDays, allZero: rows.length >= days && zeroDays === days };
}
