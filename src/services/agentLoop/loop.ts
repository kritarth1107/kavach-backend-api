/**
 * One inbound message. Phrase routes do not call this.
 * called only from the agent loop.
 */

import { argsHash, extractRecord, factOkFor, knownToolSet, moreResults, nextLanguage, scrubLocationNumbers, searchStore, type StoreAdapters } from "./catalog";
import { flashCheck, safeLine, stillOnItLine } from "./flashCheck";
import { lockTool } from "./lock";
import { PROMPT_VERSION } from "./prompt";
import { factIsSubstring, parseProDecision } from "./schema";
import type { ElderContext, GoalDoc, LoopResult, ProDecision, ToolResult } from "./types";

const MAX_TOOLS = 8;

export type AgentDeps = {
    pro: (payload: Record<string, unknown>) => Promise<unknown | null>;
    flashModel?: (payload: Record<string, unknown>) => Promise<unknown | null>;
    tools: Record<string, (args: Record<string, unknown>, goal: GoalDoc) => Promise<ToolResult>>;
    claim: (messageId: string) => boolean;
    loadGoal: () => GoalDoc | null;
    saveGoal: (goal: GoalDoc) => void;
    context: ElderContext;
    adapters?: StoreAdapters;
    seenHashes?: Set<string>;
    now?: () => string;
    /** When the model drops a live item name, use the tool list. Scripted tests leave this off. */
    groundReplies?: boolean;
    /** Test spy. The care-record handler must stay uncalled. */
    careRecord?: () => void;
};

function blankGoal(ctx: ElderContext, now: string): GoalDoc {
    return {
        id: `goal-${ctx.elderId}-${now}`,
        elderId: ctx.elderId,
        goal: "",
        step: "",
        status: "open",
        tool: null,
        toolArgs: {},
        query: ctx.openGoal?.query || null,
        page: ctx.openGoal?.page || 0,
        hits: ctx.openGoal?.hits || [],
        lastResult: null,
        waitingFor: null,
        language: ctx.language || "en",
        toldFare: ctx.openGoal?.toldFare ?? null,
        toldPickup: ctx.openGoal?.toldPickup ?? null,
        history: [],
        updatedAt: now,
    };
}

function payload(ctx: ElderContext, userText: string, extra: Record<string, unknown>): Record<string, unknown> {
    return {
        promptVersion: PROMPT_VERSION,
        elder: {
            nameToUse: ctx.nameToUse,
            language: ctx.language,
            allergies: ctx.allergies,
            facts: ctx.facts,
            blockedFacts: ctx.blockedFacts,
            openGoal: ctx.openGoal
                ? {
                      goal: ctx.openGoal.goal,
                      query: ctx.openGoal.query,
                      status: ctx.openGoal.status,
                      page: ctx.openGoal.page,
                      hits: ctx.openGoal.hits.slice(0, 24).map((h) => ({ id: h.id, name: h.name, price: h.price, size: h.size })),
                  }
                : null,
            episodes: ctx.lastMessages,
            speaker: ctx.speaker || null,
            household: ctx.household || null,
            record: ctx.record || "",
            learned: ctx.learned || "",
            medicines: ctx.medicines || [],
            reminders: ctx.reminders || [],
            readings: ctx.readings || [],
            routines: ctx.routines || [],
        },
        userText,
        ...extra,
    };
}

async function decide(deps: AgentDeps, body: Record<string, unknown>): Promise<ProDecision | "down" | "invalid"> {
    let raw = await deps.pro(body);
    if (raw == null) raw = await deps.pro(body);
    if (raw == null && deps.flashModel) raw = await deps.flashModel(body);
    if (raw == null) return "down";
    let parsed = parseProDecision(raw);
    if (!parsed.ok) {
        raw = await deps.pro({ ...body, repair: parsed.error });
        if (raw == null) return "down";
        parsed = parseProDecision(raw);
        if (!parsed.ok) return "invalid";
    }
    return parsed.value;
}

function listSay(items: Array<{ name: string; price?: string; size?: string }>, start: number, more: boolean): string {
    const lines = items.map((it, i) => {
        const size = it.size ? ` ${it.size}` : "";
        const price = it.price ? ` — ${it.price}` : "";
        return `${start + i + 1}. ${it.name}${size}${price}`;
    });
    return more ? `${lines.join("\n")}\nReply show more for the next prices.` : lines.join("\n");
}

export async function runAgentLoop(input: { messageId: string; userText: string; voiceFailed?: boolean }, deps: AgentDeps): Promise<LoopResult> {
    const now = () => deps.now?.() || new Date().toISOString();
    const trace: LoopResult["toolTrace"] = [];
    const decisions: ProDecision[] = [];
    const empty = (say: string, goal: GoalDoc | null, extra: Partial<LoopResult> = {}): LoopResult => ({
        say,
        enqueueFeedback: false,
        decisions,
        toolTrace: trace,
        goal,
        ...extra,
    });
    if (!deps.claim(input.messageId)) return empty("", null, { skipped: true });
    if (input.voiceFailed) return empty("I couldn't hear that. Please type it.", deps.loadGoal());

    const ctx = deps.context;
    let goal = deps.loadGoal() || ctx.openGoal || blankGoal(ctx, now());
    goal.language = nextLanguage(goal.language || ctx.language, input.userText);

    const toolTexts: string[] = [];
    let toolCalls = 0;
    let lockFails = 0;
    let decision: ProDecision | null = null;
    let repair = "";

    while (toolCalls < MAX_TOOLS) {
        const turned = await decide(deps, payload(ctx, input.userText, { goal, repair, lastTool: goal.lastResult }));
        repair = "";
        if (turned === "down" || turned === "invalid") {
            if (deps.groundReplies && goal.hits.length) break;
            if (turned === "down") {
                goal.status = "open";
                deps.saveGoal(goal);
                return empty(stillOnItLine(), goal);
            }
            return empty("What would you like me to do?", goal);
        }
        decisions.push(turned);
        decision = turned;
        const shopping = goal.hits.length > 0 || goal.status === "waiting_confirm";
        if (shopping && goal.goal && decision.goal && goal.goal !== decision.goal && decision.tool !== "more_results" && decision.tool !== "draft_order") {
            goal.status = "dropped";
            goal.history.push({ step: "dropped", tool: null, argsHash: "", ok: true, at: now() });
            deps.saveGoal(goal);
            const fresh = blankGoal(ctx, now());
            fresh.goal = decision.goal;
            fresh.language = goal.language;
            goal = fresh;
        } else if (!goal.goal) {
            goal.goal = decision.goal;
        }
        goal.step = decision.step;
        goal.language = nextLanguage(goal.language, input.userText);

        for (const fact of decision.save_facts) {
            if (!factIsSubstring(fact.text, input.userText, toolTexts)) continue;
            const args = { text: fact.text };
            if (deps.tools.save_fact) {
                trace.push({ name: "save_fact", args });
                await deps.tools.save_fact(args, goal);
            }
        }

        if (decision.ask && !decision.tool) {
            goal.status = "waiting_user";
            goal.waitingFor = decision.ask;
            deps.saveGoal(goal);
            decision.say = decision.ask;
            break;
        }
        if (!decision.tool) {
            goal.status = decision.done ? "done" : goal.status;
            deps.saveGoal(goal);
            break;
        }

        const known = knownToolSet();
        if (!known.has(decision.tool)) {
            goal.history.push({ step: decision.step, tool: decision.tool, argsHash: "", ok: false, error: "unknown_tool", at: now() });
            deps.saveGoal(goal);
            return empty("What would you like me to do?", goal);
        }

        let locked = lockTool({
            tool: decision.tool,
            args: decision.tool_args,
            lastInbound: input.userText,
            goalStatus: goal.status,
            knownTools: known,
            toldFare: goal.toldFare,
            toldPickup: goal.toldPickup,
            userMessage: input.userText,
            factOk: factOkFor(input.userText, toolTexts),
            knownBits: [...ctx.facts, ...ctx.lastMessages],
        });
        if (!locked.ok && locked.error === "fact_not_in_message") {
            decision.tool_args = { text: input.userText.trim() };
            locked = lockTool({
                tool: decision.tool,
                args: decision.tool_args,
                lastInbound: input.userText,
                goalStatus: goal.status,
                knownTools: known,
                toldFare: goal.toldFare,
                toldPickup: goal.toldPickup,
                userMessage: input.userText,
                factOk: factOkFor(input.userText, toolTexts),
                knownBits: [...ctx.facts, ...ctx.lastMessages],
            });
        }
        if (!locked.ok) {
            lockFails += 1;
            goal.history.push({ step: decision.step, tool: decision.tool, argsHash: argsHash(decision.tool_args), ok: false, error: locked.error, at: now() });
            deps.saveGoal(goal);
            if (lockFails >= 2) {
                return empty(locked.error === "needs_confirm" ? "Reply confirm when you want me to place it." : "I didn't catch that. Please say it once more.", goal);
            }
            repair = locked.error;
            decision = null;
            continue;
        }

        goal.tool = decision.tool;
        goal.toolArgs = decision.tool_args;
        goal.status = "open";
        goal.updatedAt = now();
        if (decision.tool === "search_store" || decision.tool === "browser_search") {
            const q = String(decision.tool_args.query || "");
            if (q) goal.query = q;
        }
        deps.saveGoal(goal);

        let result: ToolResult;
        try {
            result = await runTool(decision.tool, decision.tool_args, goal, ctx, deps, trace);
        } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : "tool_threw" };
        }
        toolCalls += 1;
        goal.lastResult = result;
        const traced = trace[trace.length - 1];
        if (traced) traced.result = { ok: result.ok, error: result.error, data: result.data };
        goal.history.push({ step: decision.step, tool: decision.tool, argsHash: argsHash(decision.tool_args), ok: result.ok, error: result.error, at: now() });
        if (result.ok && result.data) toolTexts.push(JSON.stringify(result.data));
        if (decision.tool === "search_store" || decision.tool === "browser_search") {
            const items = (result.data as { items?: GoalDoc["hits"] } | undefined)?.items;
            if (items?.length) {
                goal.hits = items;
                goal.page = Math.min(8, items.length);
            }
        }
        if (decision.tool === "more_results") {
            const items = (result.data as { items?: GoalDoc["hits"] } | undefined)?.items || [];
            goal.page += items.length || 8;
        }
        const reconnect = result.error === "reconnect" && result.data && typeof result.data === "object" ? (result.data as { message?: string }).message : "";
        if (reconnect) {
            decision.say = reconnect;
            decision.tool = null;
            decision.done = false;
            deps.saveGoal(goal);
            break;
        }
        if ((decision.tool === "draft_order" || decision.tool === "ride_draft") && result.ok) {
            goal.status = "waiting_confirm";
            deps.saveGoal(goal);
            break;
        }
        deps.saveGoal(goal);
        if (decision.done) break;
        repair = JSON.stringify(result).slice(0, 1500);
        if (toolCalls >= MAX_TOOLS) {
            decision.say = "I need one answer before I go further. What should I do next?";
            decision.ask = decision.say;
            decision.done = false;
            break;
        }
    }

    let say = (decision?.say || stillOnItLine()).replace(/,?\s*\bname_to_use\b/gi, ctx.nameToUse ? ` ${ctx.nameToUse}` : "").replace(/\s{2,}/g, " ").trim();
    const pin = ctx.pickupLabel === "Current location" ? { lat: NaN, lng: NaN } : null;
    say = scrubLocationNumbers(say, pin);

    const warned = [...decisions].reverse().find((d) => d.tool === "alert_caregiver" && d.say.trim());
    if (warned && !say.toLowerCase().includes(warned.say.trim().slice(0, 24).toLowerCase())) {
        say = `${warned.say.trim()}\n${say}`.trim();
    }
    const allowed = [
        ...ctx.facts,
        ...ctx.lastMessages,
        input.userText,
        ...toolTexts,
        ctx.nameToUse,
        ...goal.hits.flatMap((h) => [h.name, h.price || ""]),
    ];
    let checked = flashCheck({ say, allowed });
    if (!checked.ok && decision) {
        const rewritten = await decide(deps, payload(ctx, input.userText, { repair: `rewrite: ${checked.reasons.join(",")}`, say }));
        if (rewritten !== "down" && rewritten !== "invalid") {
            say = rewritten.say.replace(/,?\s*\bname_to_use\b/gi, ctx.nameToUse ? ` ${ctx.nameToUse}` : "").replace(/\s{2,}/g, " ").trim();
            checked = flashCheck({ say, allowed });
        }
    }
    let blockedText: string | undefined;
    if (!checked.ok) {
        blockedText = say;
        say = safeLine();
    }
    let grounded = false;
    const lastTool = trace[trace.length - 1]?.name;
    if (deps.groundReplies && goal.hits.length && (lastTool === "search_store" || lastTool === "browser_search" || lastTool === "more_results" || lastTool === "draft_order")) {
        const named = goal.hits.some((h) => h.name && say.toLowerCase().includes(h.name.toLowerCase().slice(0, Math.min(24, h.name.length))));
        const list = () => {
            const start = Math.max(0, goal.page - 8);
            const page = goal.hits.slice(start, start + 8);
            return listSay(page.length ? page : goal.hits.slice(0, 8), page.length ? start : 0, goal.hits.length > (page.length ? start + page.length : 8));
        };
        if (lastTool === "draft_order") {
            const hit = goal.hits.find((h) => h.id === String(goal.toolArgs.item_id || "")) || null;
            if (hit?.price && !say.includes(hit.price)) {
                const card = `Confirm this order\n1 × ${hit.name}${hit.size ? ` ${hit.size}` : ""} — ${hit.price}\nCash on delivery\nReply confirm to place it. Nothing is ordered yet.`;
                say = warned ? `${warned.say.trim()}\n${card}` : card;
                grounded = true;
            }
        } else if (!named) {
            const lines = list();
            say = warned ? `${warned.say.trim()}\n${lines}` : lines;
            grounded = true;
        }
    }
    if (warned && !say.toLowerCase().includes(warned.say.trim().slice(0, 24).toLowerCase())) {
        say = `${warned.say.trim()}\n${say}`.trim();
    }
    const enqueueFeedback = goal.status === "done";
    deps.saveGoal(goal);
    return { say, blockedText, grounded, enqueueFeedback, decisions, toolTrace: trace, goal };
}

async function runTool(
    name: string,
    args: Record<string, unknown>,
    goal: GoalDoc,
    ctx: ElderContext,
    deps: AgentDeps,
    trace: LoopResult["toolTrace"],
): Promise<ToolResult> {
    trace.push({ name, args: name === "more_results" ? { query: goal.query } : args });
    if (name === "more_results") return moreResults(goal);
    if (name === "search_store") {
        const q = String(args.query || "");
        const prev = goal.lastResult as ToolResult | null;
        if (q && q === goal.query && goal.hits.length && prev?.ok) {
            return { ok: true, data: { items: goal.hits, query: q, source: "stored" } };
        }
        return searchStore(args, [...ctx.allergies, ...ctx.dietRules, ...ctx.blockedMedicines], deps.adapters || {});
    }
    if (name === "browser_search") {
        const browser = deps.adapters?.browserSearch;
        if (!browser) return { ok: false, error: "browser_unavailable" };
        return browser({ store: String(args.store || ""), query: String(args.query || goal.query || "") });
    }
    if (name === "extract_record") return extractRecord(args, deps.seenHashes || new Set());
    if (name === "place_order" || name === "ride_book" || name === "start_sign_in") {
        const fn = deps.tools[name];
        if (!fn) return { ok: false, error: "held", data: { payment: "cash" } };
        return fn(args, goal);
    }
    const fn = deps.tools[name];
    if (!fn) return { ok: false, error: "not_wired" };
    return fn(args, goal);
}

export function feedbackAllowed(status: string | undefined): boolean {
    return status === "done";
}
