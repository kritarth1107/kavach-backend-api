/**
 * Daily snapshot: Gemini 3.5 Pro summary of one IST day of a care recipient's activity
 * with Saheli. Scheduled (~21:00 IST) + on demand from the caregiver dashboard.
 */
import ActivityLog from "../models/activityLog.model";
import DailySnapshot, { type IDailySnapshot } from "../models/dailySnapshot.model";
import { parseJsonLoose, vertexGenerateText, vertexProModel } from "../clients/vertexGemini.client";
import { istDayKey } from "./activityLog.service";

export function serializeSnapshot(doc: Partial<IDailySnapshot> | null | undefined) {
    if (!doc) return null;
    return {
        dayKey: doc.dayKey,
        status: doc.status,
        summary: doc.summary ?? "",
        highlights: doc.highlights ?? [],
        concerns: doc.concerns ?? [],
        mood: doc.mood ?? null,
        counts: doc.counts ?? { messages: 0, voiceNotes: 0, orders: 0, rides: 0, reminders: 0, healthFlags: 0, nudges: 0 },
        model: doc.modelName ?? null,
        generatedAt: doc.generatedAt ? new Date(doc.generatedAt).toISOString() : null,
        source: doc.source ?? "scheduled",
    };
}

function istTime(d: Date): string {
    return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).format(d);
}

export async function generateDailySnapshot(input: {
    familyId: string;
    recipientUserId: string;
    dayKey?: string;
    elderName?: string;
    source: "scheduled" | "on_demand";
}) {
    const dayKey = input.dayKey || istDayKey();
    const rows = await ActivityLog.find({ recipientUserId: input.recipientUserId, dayKey })
        .sort({ createdAt: 1 })
        .limit(1500)
        .lean();
    const counts = {
        messages: rows.filter((r) => r.kind === "message_in").length,
        voiceNotes: rows.filter((r) => r.kind === "voice_note").length,
        orders: rows.filter((r) => r.kind === "order_placed").length,
        rides: rows.filter((r) => r.kind === "ride").length,
        reminders: rows.filter((r) => r.kind === "reminder").length,
        healthFlags: rows.filter((r) => r.kind === "health" && r.severity === "error").length,
        nudges: rows.filter((r) => r.kind === "nudge").length,
    };
    const base = { familyId: input.familyId, recipientUserId: input.recipientUserId, dayKey, source: input.source, counts };
    if (!rows.length) {
        const doc = await DailySnapshot.findOneAndUpdate(
            { recipientUserId: input.recipientUserId, dayKey },
            { $set: { ...base, status: "empty", summary: "No activity with Saheli on this day.", highlights: [], concerns: [], mood: null, generatedAt: new Date() } },
            { upsert: true, new: true },
        ).lean();
        return serializeSnapshot(doc);
    }
    // Compact transcript: skip noisy step chatter + diagnostics; keep the story.
    const lines = rows
        .filter((r) => r.kind !== "diag" && r.kind !== "order_step")
        .map((r) => `${istTime(new Date(r.createdAt as Date))} [${r.kind}] ${r.title}${r.detail ? ` — ${String(r.detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`)
        .slice(-400);
    const model = vertexProModel();
    const who = input.elderName?.trim() || "the care recipient";
    const raw = await vertexGenerateText({
        model,
        json: true,
        timeoutMs: 45_000,
        maxOutputTokens: 2048,
        temperature: 0.3,
        system:
            `You write a caregiver's daily snapshot of ${who}'s day with Saheli (their WhatsApp companion). ` +
            "Use ONLY the log. Warm, factual, short. Never diagnose or interpret health; quote what they said. " +
            'Reply ONLY JSON: {"summary":"3-5 sentence overview","highlights":["≤6 short bullets"],"concerns":["health/mood/safety items worth a caregiver\'s attention, else empty"],"mood":"one word or null"}',
        prompt: `Day: ${dayKey} (IST)\nActivity log:\n${lines.join("\n")}`,
    });
    const parsed = parseJsonLoose<{ summary?: string; highlights?: string[]; concerns?: string[]; mood?: string | null }>(raw);
    const set = parsed?.summary
        ? {
              ...base,
              status: "ready" as const,
              summary: String(parsed.summary).slice(0, 3000),
              highlights: (parsed.highlights ?? []).map(String).slice(0, 8),
              concerns: (parsed.concerns ?? []).map(String).slice(0, 8),
              mood: parsed.mood ? String(parsed.mood).slice(0, 30) : null,
              modelName: model,
              generatedAt: new Date(),
          }
        : {
              ...base,
              status: "failed" as const,
              summary: "Couldn't generate the summary right now — the activity feed has the full day.",
              highlights: [],
              concerns: [],
              mood: null,
              modelName: model,
              generatedAt: new Date(),
          };
    const doc = await DailySnapshot.findOneAndUpdate(
        { recipientUserId: input.recipientUserId, dayKey },
        { $set: set },
        { upsert: true, new: true },
    ).lean();
    return serializeSnapshot(doc);
}

export async function getDailySnapshot(recipientUserId: string, dayKey: string, familyId?: string) {
    return serializeSnapshot(await DailySnapshot.findOne({ recipientUserId, dayKey, ...(familyId ? { familyId } : {}) }).lean());
}

export async function listDailySnapshots(recipientUserId: string, limit = 14, familyId?: string) {
    const rows = await DailySnapshot.find({ recipientUserId, ...(familyId ? { familyId } : {}) })
        .sort({ dayKey: -1 })
        .limit(Math.min(Math.max(limit, 1), 60))
        .lean();
    return rows.map((r) => serializeSnapshot(r));
}

let lastScheduledDay = "";
/** Called from the 1-minute scheduler tick: once per IST day after 21:00, snapshot active recipients. */
export async function runDailySnapshotTick(now = new Date()): Promise<number> {
    if (process.env.DAILY_SNAPSHOT_ENABLED === "false") return 0;
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(now));
    const today = istDayKey(now);
    if (hour < 21 || lastScheduledDay === today) return 0;
    lastScheduledDay = today;
    const yesterday = istDayKey(new Date(now.getTime() - 24 * 3600_000));
    let made = 0;
    for (const dayKey of [yesterday, today]) {
        const pairs = (await ActivityLog.aggregate([
            { $match: { dayKey } },
            { $group: { _id: { r: "$recipientUserId", f: "$familyId" } } },
            { $limit: 500 },
        ])) as Array<{ _id: { r: string; f: string } }>;
        for (const p of pairs) {
            if (dayKey === yesterday) {
                const exists = await DailySnapshot.findOne({ recipientUserId: p._id.r, dayKey, status: "ready" }).lean();
                if (exists) continue;
            }
            try {
                await generateDailySnapshot({ familyId: p._id.f, recipientUserId: p._id.r, dayKey, source: "scheduled" });
                made++;
            } catch (err) {
                console.warn("daily snapshot failed:", err instanceof Error ? err.message : err);
            }
        }
    }
    if (made) console.log(`Daily snapshots generated: ${made}`);
    return made;
}
