/**
 * Tool catalog. Pro receives the name and the arg shape, not this code.
 * called only from the agent loop.
 */

import { factIsSubstring } from "./schema";
import type { GoalDoc, ToolResult } from "./types";

export const TOOL_NAMES = [
    "search_store",
    "more_results",
    "draft_order",
    "place_order",
    "browser_search",
    "ride_search",
    "ride_draft",
    "start_sign_in",
    "ride_book",
    "ride_status",
    "ride_cancel",
    "mark_dose",
    "log_reading",
    "log_mood",
    "save_preference",
    "save_fact",
    "alert_caregiver",
    "ask_one",
    "save_upload",
    "extract_record",
    "medicine_due",
    "schedule_reminder",
    "save_routine",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function knownToolSet(): Set<string> {
    return new Set(TOOL_NAMES);
}

export type CatalogItem = { id: string; name: string; price?: string; size?: string };

export type StoreAdapters = {
    /** Linked session. Throw or return ok:false to force one browser_search. */
    linkedSearch?: (args: { store: string; query: string }) => Promise<ToolResult>;
    /** called only from the agent loop, and only after linked search fails. */
    browserSearch?: (args: { store: string; query: string }) => Promise<ToolResult>;
    placeOrder?: (args: Record<string, unknown>) => Promise<ToolResult>;
};

const PAGE = 8;

export function stripAllergens<T extends { name: string }>(items: T[], bans: string[]): T[] {
    const needles = bans.map((b) => b.trim().toLowerCase()).filter((b) => b.length >= 3);
    return items.filter((it) => !needles.some((b) => it.name.toLowerCase().includes(b)));
}

export function itemsOf(data: unknown): CatalogItem[] {
    if (!data || typeof data !== "object") return [];
    const items = (data as { items?: unknown }).items;
    if (!Array.isArray(items)) return [];
    return items.filter((it): it is CatalogItem => Boolean(it) && typeof it === "object" && typeof (it as CatalogItem).name === "string");
}

/** Next page of prices already stored on the goal. The latest user text is not a query. */
export function moreResults(goal: GoalDoc | null): ToolResult {
    if (!goal?.query) return { ok: false, error: "no_query" };
    const start = goal.page;
    const items = goal.hits.slice(start, start + PAGE);
    return { ok: true, data: { query: goal.query, source: "stored", items, page: start } };
}

/**
 * Linked session first. On failure, browser_search once with the same query.
 * Reconnect copy only when both fail. Allergies are removed before the result is returned.
 */
export async function searchStore(args: Record<string, unknown>, bans: string[], adapters: StoreAdapters): Promise<ToolResult> {
    const store = String(args.store || "");
    const query = String(args.query || "");
    const linked = adapters.linkedSearch || (async () => ({ ok: false, error: "no_linked_session" }));
    let first: ToolResult;
    try {
        first = await linked({ store, query });
    } catch (err) {
        first = { ok: false, error: err instanceof Error ? err.message : "linked_failed" };
    }
    const finish = (result: ToolResult, source: string): ToolResult => {
        const items = stripAllergens(itemsOf(result.data), bans).slice(0, 24);
        return { ok: items.length > 0, data: { ...(typeof result.data === "object" && result.data ? result.data : {}), items, source, query }, error: items.length ? undefined : result.error };
    };
    if (first.ok && itemsOf(first.data).length) return finish(first, "linked");
    const browser = adapters.browserSearch || (async () => ({ ok: false, error: "browser_unavailable" }));
    let second: ToolResult;
    try {
        second = await browser({ store, query });
    } catch (err) {
        second = { ok: false, error: err instanceof Error ? err.message : "browser_failed" };
    }
    if (second.ok && itemsOf(second.data).length) return finish(second, "browser");
    const note = [first, second]
        .map((row) => (row.data && typeof row.data === "object" ? (row.data as { note?: string }).note : ""))
        .find((line) => line && !/401|invalid_grant|unauthorized/i.test(line));
    if (note) return { ok: false, error: "search_failed", data: { query, message: note } };
    return {
        ok: false,
        error: "reconnect",
        data: { query, source: "both", message: `${store || "That store"} needs connecting again. Dashboard → Integrations: disconnect it, then connect it again.` },
    };
}

/** Missing fields stay null. A duplicate hash does not invent a second record. */
export function extractRecord(page: Record<string, unknown>, seenHashes: Set<string>): ToolResult {
    const hash = typeof page.hash === "string" ? page.hash : "";
    if (hash && seenHashes.has(hash)) return { ok: true, data: { duplicate: true, medicines: null, dates: null, lab: null } };
    if (hash) seenHashes.add(hash);
    return {
        ok: true,
        data: {
            duplicate: false,
            medicines: page.medicines ?? null,
            dates: page.dates ?? null,
            lab: page.lab ?? null,
        },
    };
}

export function reminderSay(lastRemindedAt: string | null): string {
    if (lastRemindedAt) return "I reminded you. Please take it now.";
    return "I missed the medicine reminder. Please take it now.";
}

export function applyReminderSend<T extends { lastRemindedAt: string | null }>(med: T, sent: boolean, at: string): T {
    if (!sent) return { ...med, lastRemindedAt: med.lastRemindedAt ?? null };
    return { ...med, lastRemindedAt: at };
}

/** A one-word reply must not change the language of the elder's longer messages. */
export function nextLanguage(prev: string, message: string): string {
    const t = message.trim();
    if (/^(ok|okay|haan|ha|yes|no|\d{1,2})$/i.test(t)) return prev || "en";
    if (/[\u0900-\u097F]/.test(t) && t.length > 8) return "hi";
    if (t.length > 24) return "en";
    return prev || "en";
}

export function pickupFromMessage(text: string): { label: string; lat: number; lng: number } | null {
    const m = text.match(/\[location lat=(-?\d+(?:\.\d+)?) lng=(-?\d+(?:\.\d+)?)/i);
    if (!m) return null;
    return { label: "Current location", lat: Number(m[1]), lng: Number(m[2]) };
}

export function scrubLocationNumbers(say: string, pin: { lat: number; lng: number } | null): string {
    if (!pin) return say;
    return say.split(String(pin.lat)).join("").split(String(pin.lng)).join("").replace(/\s{2,}/g, " ").trim();
}

export function argsHash(args: Record<string, unknown>): string {
    return JSON.stringify(args).slice(0, 180);
}

export function factOkFor(userMessage: string, toolTexts: string[]) {
    return (text: string) => factIsSubstring(text, userMessage, toolTexts);
}
