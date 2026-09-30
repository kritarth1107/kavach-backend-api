/**
 * Production entry for a flagged test phone.
 * Phrase routes do not call this. called only from the agent loop.
 * Live store placement stays held. The model writes the reply from tool results.
 */

import type { ElderContext, GoalDoc, LoopResult, ToolResult } from "./types";
import { runAgentLoop, type AgentDeps } from "./loop";
import { PROMPT_VERSION, SAHELI_PRO_PROMPT } from "./prompt";
import { draftFromHits, liveRideSearch, liveStoreSearch } from "./liveTools";
import { factIsSubstring } from "./schema";

const EPISODE_KEEP = 200;
const EPISODE_PROMPT = 40;

type FamilyAlert = { reason: string; note: string; at: string; speaker: string };
type MedicineRow = { name: string; time: string; status: string; lastRemindedAt: string | null };
type ReminderRow = { text: string; when: string; held: boolean; at: string };
type ReadingRow = { kind: string; value: string; at: string };
type FamilyMemory = {
    facts: string[];
    nameToUse: string;
    allergies: string[];
    episodes: string[];
    alerts: FamilyAlert[];
    record: string;
    medicines: MedicineRow[];
    reminders: ReminderRow[];
    readings: ReadingRow[];
    routines: string[];
    moods: string[];
    familyId: string;
    caregivers: string[];
    careRecipients: string[];
};

const goals = new Map<string, GoalDoc>();
const claimed = new Set<string>();
const memory = new Map<string, FamilyMemory>();
const traces = new Map<string, LoopResult>();

function blankMemory(familyId: string): FamilyMemory {
    return {
        facts: [],
        nameToUse: "",
        allergies: [],
        episodes: [],
        alerts: [],
        record: "",
        medicines: [],
        reminders: [],
        readings: [],
        routines: [],
        moods: [],
        familyId,
        caregivers: [],
        careRecipients: [],
    };
}

function remember(familyId: string) {
    return memory.get(familyId) || blankMemory(familyId);
}

async function loadHistory(familyId: string) {
    const mem = remember(familyId);
    mem.familyId = familyId;
    try {
        const { default: mongoose } = await import("mongoose");
        if (mongoose.connection.readyState !== 1) return mem;
        const { default: History } = await import("../../models/saheliFamilyHistory.model");
        const doc = await History.findOne({ familyId }).lean<{
            facts?: string[];
            episodes?: string[];
            alerts?: FamilyAlert[];
            record?: string;
            medicines?: MedicineRow[];
            reminders?: ReminderRow[];
            readings?: ReadingRow[];
            routines?: string[];
            moods?: string[];
        }>();
        if (doc) {
            mem.facts = Array.isArray(doc.facts) ? doc.facts : [];
            mem.episodes = Array.isArray(doc.episodes) ? doc.episodes.slice(-EPISODE_KEEP) : [];
            mem.alerts = Array.isArray(doc.alerts) ? doc.alerts : [];
            mem.record = typeof doc.record === "string" ? doc.record : "";
            mem.medicines = Array.isArray(doc.medicines) ? doc.medicines : [];
            mem.reminders = Array.isArray(doc.reminders) ? doc.reminders : [];
            mem.readings = Array.isArray(doc.readings) ? doc.readings : [];
            mem.routines = Array.isArray(doc.routines) ? doc.routines : [];
            mem.moods = Array.isArray(doc.moods) ? doc.moods : [];
        }
    } catch {
        /* history is optional when mongo is down */
    }
    memory.set(familyId, mem);
    return mem;
}

async function saveHistory(familyId: string) {
    const mem = remember(familyId);
    try {
        const { default: mongoose } = await import("mongoose");
        if (mongoose.connection.readyState !== 1 || !mem.familyId) return;
        const { default: History } = await import("../../models/saheliFamilyHistory.model");
        await History.updateOne(
            { familyId },
            {
                $set: {
                    familyId: mem.familyId,
                    facts: mem.facts,
                    episodes: mem.episodes.slice(-EPISODE_KEEP),
                    alerts: mem.alerts.slice(-50),
                    record: mem.record,
                    medicines: mem.medicines,
                    reminders: mem.reminders.slice(-80),
                    readings: mem.readings.slice(-80),
                    routines: mem.routines.slice(-40),
                    moods: mem.moods.slice(-40),
                },
                $setOnInsert: { elderId: familyId },
            },
            { upsert: true },
        );
    } catch {
        /* keep the in-process copy */
    }
}

function elderContext(input: {
    elderId: string;
    phone: string;
    familyId: string;
    speaker?: { name: string; role: string } | null;
}): ElderContext {
    const mem = remember(input.familyId);
    return {
        elderId: input.elderId,
        phone: input.phone,
        nameToUse: mem.nameToUse,
        language: "en",
        allergies: mem.allergies,
        dietRules: [],
        blockedMedicines: [],
        facts: mem.facts,
        blockedFacts: [],
        medicines: mem.medicines,
        openGoal: goals.get(input.elderId) || null,
        lastMessages: mem.episodes.slice(-EPISODE_PROMPT),
        signals: [],
        pickupLabel: null,
        speaker: input.speaker || null,
        household: { caregivers: mem.caregivers, careRecipients: mem.careRecipients },
        record: mem.record,
        reminders: mem.reminders.map((row) => ({ text: row.text, when: row.when, held: row.held })),
        readings: mem.readings.map((row) => ({ kind: row.kind, value: row.value })),
        routines: mem.routines,
    };
}

function speakerLine(speaker: { name: string; role: string } | null | undefined, text: string): string {
    if (!speaker?.name) return `User: ${text}`;
    const role = speaker.role === "caregiver" ? "Caregiver" : "Care recipient";
    return `${role} ${speaker.name}: ${text}`;
}

async function pro(payload: Record<string, unknown>): Promise<unknown | null> {
    const { vertexGenerateText, vertexLocationForModel, vertexProModel } = await import("../../clients/vertexGemini.client");
    const model = vertexProModel();
    const text = await vertexGenerateText({
        model,
        location: vertexLocationForModel(model),
        system: SAHELI_PRO_PROMPT,
        prompt: JSON.stringify({ promptVersion: PROMPT_VERSION, ...payload }).slice(0, 14000),
        json: true,
        timeoutMs: 45000,
        temperature: 0.2,
        maxOutputTokens: 4096,
    });
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function takeLoopTrace(messageId: string): LoopResult | undefined {
    return traces.get(messageId);
}

/** Flagged turn. Returns null when this message id was already claimed. */
export async function runFlaggedElderTurn(input: {
    phone: string;
    elderId: string;
    familyId: string;
    text: string;
    messageId: string;
    speaker?: { name: string; role: "caregiver" | "care_recipient" } | null;
    household?: { caregivers: string[]; careRecipients: string[] } | null;
}): Promise<string | null> {
    const mem = await loadHistory(input.familyId);
    if (input.household) {
        mem.caregivers = input.household.caregivers;
        mem.careRecipients = input.household.careRecipients;
    }
    const ctx = elderContext(input);
    const deps: AgentDeps = {
        pro,
        flashModel: pro,
        groundReplies: true,
        tools: {
            draft_order: async (args, goal) => draftFromHits(args, goal),
            ride_search: async (args) => liveRideSearch(args),
            ride_book: async () => ({ ok: false, error: "not_booked", data: { booked: false } }) satisfies ToolResult,
            place_order: async () => ({ ok: false, error: "not_placed", data: { ordered: false, payment: "cash" } }) satisfies ToolResult,
            save_fact: async (args) => {
                const text = String(args.text || "").trim();
                if (text && !mem.facts.includes(text)) mem.facts.push(text);
                memory.set(input.familyId, mem);
                ctx.facts = mem.facts;
                await saveHistory(input.familyId);
                return { ok: true, data: { saved: text } };
            },
            save_preference: async (args) => {
                const text = String(args.text || "").trim();
                if (text && !mem.facts.includes(text)) mem.facts.push(text);
                memory.set(input.familyId, mem);
                ctx.facts = mem.facts;
                await saveHistory(input.familyId);
                return { ok: true, data: { saved: text } };
            },
            alert_caregiver: async (args) => {
                const note = String(args.note || args.text || "").trim();
                const reason = String(args.reason || "").trim();
                const row = {
                    reason,
                    note,
                    at: new Date().toISOString(),
                    speaker: input.speaker?.name || "",
                };
                mem.alerts.push(row);
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { sent: true, to: mem.caregivers, note, reason } };
            },
            save_upload: async (args) => {
                const text = String(args.text || input.text || "").trim();
                if (!factIsSubstring(text, input.text, [mem.record])) return { ok: false, error: "fact_not_in_message" };
                mem.record = text;
                ctx.record = text;
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { saved: true, chars: text.length } };
            },
            schedule_reminder: async (args) => {
                const text = String(args.text || "").trim();
                const when = String(args.when || "").trim();
                if (!text || !factIsSubstring(text, input.text, [mem.record, ...mem.facts, ...mem.medicines.map((m) => m.name)])) {
                    return { ok: false, error: "fact_not_in_message" };
                }
                const row = { text, when, held: true, at: new Date().toISOString() };
                mem.reminders.push(row);
                ctx.reminders = mem.reminders.map((item) => ({ text: item.text, when: item.when, held: item.held }));
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { held: true, sent: false, when, text } };
            },
            mark_dose: async (args) => {
                const name = String(args.name || "").trim();
                const status = String(args.status || "").trim().toLowerCase();
                if (!["taken", "skipped", "refused", "missed"].includes(status)) return { ok: false, error: "bad_status" };
                if (!factIsSubstring(name, input.text, [mem.record, ...mem.medicines.map((m) => m.name)])) return { ok: false, error: "fact_not_in_message" };
                let row = mem.medicines.find((m) => m.name.toLowerCase() === name.toLowerCase());
                if (!row) {
                    row = { name, time: "", status, lastRemindedAt: null };
                    mem.medicines.push(row);
                }
                row.status = status;
                ctx.medicines = mem.medicines;
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { name, status, lastRemindedAt: row.lastRemindedAt } };
            },
            medicine_due: async () => {
                const due = mem.medicines.filter((m) => !m.lastRemindedAt).map((m) => ({ name: m.name, time: m.time, lastRemindedAt: null }));
                return { ok: true, data: { due, remindersHeld: mem.reminders.length, sent: false } };
            },
            log_reading: async (args) => {
                const kind = String(args.kind || "").trim();
                const value = String(args.value || "").trim();
                if (!kind || !value || !factIsSubstring(value, input.text, [])) return { ok: false, error: "fact_not_in_message" };
                mem.readings.push({ kind, value, at: new Date().toISOString() });
                ctx.readings = mem.readings.map((row) => ({ kind: row.kind, value: row.value }));
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { kind, value } };
            },
            log_mood: async (args) => {
                const text = String(args.text || "").trim();
                if (!text || !factIsSubstring(text, input.text, [])) return { ok: false, error: "fact_not_in_message" };
                mem.moods.push(text);
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { text } };
            },
            save_routine: async (args) => {
                const text = String(args.text || "").trim();
                if (!text || !factIsSubstring(text, input.text, [])) return { ok: false, error: "fact_not_in_message" };
                if (!mem.routines.includes(text)) mem.routines.push(text);
                ctx.routines = mem.routines;
                memory.set(input.familyId, mem);
                await saveHistory(input.familyId);
                return { ok: true, data: { text } };
            },
        },
        claim: (id) => {
            if (claimed.has(id)) return false;
            claimed.add(id);
            return true;
        },
        loadGoal: () => goals.get(input.elderId) || null,
        saveGoal: (goal) => {
            goals.set(input.elderId, goal);
        },
        context: ctx,
        adapters: {
            linkedSearch: async ({ store, query }) => liveStoreSearch({ store, query }),
            browserSearch: async () => ({ ok: false, error: "no_second_search" }),
        },
    };
    const result = await runAgentLoop({ messageId: input.messageId, userText: input.text }, deps);
    traces.set(input.messageId, result);
    mem.episodes.push(speakerLine(input.speaker, input.text), `Saheli: ${result.say}`);
    mem.episodes = mem.episodes.slice(-EPISODE_KEEP);
    memory.set(input.familyId, mem);
    await saveHistory(input.familyId);
    if (result.skipped) return null;
    if (result.blockedText) {
        console.warn(`[agent-loop] blocked reply for ${input.familyId}`);
    }
    return result.say;
}
