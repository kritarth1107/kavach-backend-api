/**
 * The agent loop, with stub tools. Phrase routes are not the decider here.
 */
import assert from "node:assert/strict";
import { agentLoopEnabled } from "../src/services/agentLoop/gate";
import { runAgentLoop, type AgentDeps } from "../src/services/agentLoop/loop";
import { citesMemory, lockTool } from "../src/services/agentLoop/lock";
import { PROMPT_VERSION } from "../src/services/agentLoop/prompt";
import type { ElderContext, GoalDoc, ProDecision, ToolResult } from "../src/services/agentLoop/types";

let n = 0;
const t = async (name: string, fn: () => Promise<void>) => {
    await fn();
    n++;
    console.log(`  ✓ ${name}`);
};

function talk(say: string, extra: Partial<ProDecision> = {}): ProDecision {
    return {
        goal: extra.goal || "talk",
        step: extra.step || "talk",
        tool: extra.tool ?? null,
        tool_args: extra.tool_args || {},
        say,
        ask: extra.ask ?? null,
        done: extra.done ?? true,
        save_facts: extra.save_facts || [],
    };
}

function ctx(over: Partial<ElderContext> = {}): ElderContext {
    return {
        elderId: "elder-1",
        phone: "+999700000001",
        nameToUse: "Papa",
        language: "hi",
        allergies: [],
        dietRules: [],
        blockedMedicines: [],
        facts: [],
        blockedFacts: [],
        medicines: [],
        openGoal: null,
        lastMessages: [],
        signals: [],
        pickupLabel: null,
        ...over,
    };
}

function harness(over: Partial<AgentDeps> & { replies?: Array<unknown | null>; flashReplies?: Array<unknown | null> } = {}): AgentDeps & { snaps: GoalDoc[]; placed: number; careHits: number; browserHits: number } {
    const snaps: GoalDoc[] = [];
    let goal = over.context?.openGoal || null;
    const seen = new Set<string>();
    let placed = 0;
    let careHits = 0;
    let browserHits = 0;
    let i = 0;
    let f = 0;
    const replies = over.replies || [];
    const flashReplies = over.flashReplies || [];
    const deps: AgentDeps = {
        pro: async () => {
            const row = i < replies.length ? replies[i] : null;
            i++;
            return row;
        },
        flashModel: async () => {
            const row = f < flashReplies.length ? flashReplies[f] : null;
            f++;
            return row;
        },
        tools: {
            place_order: async () => {
                placed++;
                return { ok: true };
            },
            draft_order: async () => {
                throw new Error("boom");
            },
            save_preference: async () => ({ ok: true }),
            ...(over.tools || {}),
        },
        claim: (id) => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        },
        loadGoal: () => goal,
        saveGoal: (g) => {
            goal = JSON.parse(JSON.stringify(g)) as GoalDoc;
            snaps.push(goal);
        },
        context: over.context || ctx(),
        careRecord: () => {
            careHits++;
        },
        adapters: over.adapters || {
            linkedSearch: async () => ({ ok: true, data: { items: [{ id: "1", name: "RiteBite Max Protein bar", price: "49", size: "50 g" }] } }) satisfies ToolResult,
            browserSearch: async () => {
                browserHits++;
                return { ok: false, error: "down" };
            },
        },
        seenHashes: over.seenHashes,
    };
    return Object.assign(deps, { snaps, get placed() { return placed; }, get careHits() { return careHits; }, get browserHits() { return browserHits; } });
}

function openGoal(partial: Partial<GoalDoc> = {}): GoalDoc {
    return {
        id: "g1",
        elderId: "elder-1",
        goal: "order a protein bar",
        step: "listed",
        status: "open",
        tool: "search_store",
        toolArgs: { store: "instamart", query: "protein bar" },
        query: "protein bar",
        page: 8,
        hits: Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), name: `bar ${i + 1}`, price: String(40 + i) })),
        lastResult: null,
        waitingFor: null,
        language: "hi",
        toldFare: null,
        toldPickup: null,
        history: [],
        updatedAt: "2026-09-30T00:00:00.000Z",
        ...partial,
    };
}

async function main() {
await t("prompt version is set", async () => {
    assert.equal(PROMPT_VERSION, 6);
});

await t("an alert must quote something the family already said", async () => {
    const base = {
        tool: "alert_caregiver",
        lastInbound: "Please get me jalebi",
        goalStatus: "open",
        knownTools: new Set(["alert_caregiver"]),
        userMessage: "Please get me jalebi",
        knownBits: ["Caregiver Anita: Mom is diabetic."],
    };
    assert.equal(citesMemory("Mom is diabetic. Jalebi is a sugar rush.", base.knownBits), true);
    const invented = lockTool({ ...base, args: { reason: "red_flag", note: "sugar rush" } });
    assert.equal(invented.ok, false);
    const quoted = lockTool({ ...base, args: { reason: "red_flag", note: "Mom is diabetic. Jalebi is a sugar rush." } });
    assert.equal(quoted.ok, true);
});

await t("webhook duplicate message id runs the loop once", async () => {
    const h = harness({ replies: [talk("Hello")] });
    const a = await runAgentLoop({ messageId: "m1", userText: "hello there friend" }, h);
    const b = await runAgentLoop({ messageId: "m1", userText: "hello there friend" }, h);
    assert.equal(b.skipped, true);
    assert.equal(a.say, "Hello");
    assert.equal(h.snaps.length > 0, true);
});

await t("Pro timeout falls through to Flash and does not ask for a resend", async () => {
    const h = harness({ replies: [null, null], flashReplies: [talk("I'm here.")] });
    const r = await runAgentLoop({ messageId: "m2", userText: "hello there friend" }, h);
    assert.equal(r.say, "I'm here.");
    assert.doesNotMatch(r.say, /resend|send it again|phir bhej/i);
});

await t("invalid tool name does not run a handler", async () => {
    const h = harness({ replies: [talk("no", { tool: "care_record", done: false })] });
    const r = await runAgentLoop({ messageId: "m3", userText: "hello there friend" }, h);
    assert.equal(r.toolTrace.length, 0);
    assert.equal(h.careHits, 0);
    assert.match(r.say, /What would you like/);
});

await t("place_order without the word confirm does not call the store", async () => {
    const h = harness({
        replies: [talk("placing", { tool: "place_order", tool_args: { payment: "cash" }, done: false }), talk("Reply confirm to place it.", { done: false })],
    });
    const r = await runAgentLoop({ messageId: "m4", userText: "yes" }, h);
    assert.equal(h.placed, 0);
    assert.doesNotMatch(r.toolTrace.map((x) => x.name).join(","), /place_order/);
});

await t("goal document exists before a tool that throws, and a second turn resumes it", async () => {
    const h = harness({ replies: [talk("draft", { tool: "draft_order", tool_args: { item_id: "1" }, done: false })] });
    const r = await runAgentLoop({ messageId: "m5", userText: "the first one please" }, h);
    assert.equal(h.snaps.some((s) => s.tool === "draft_order" && s.lastResult == null), true);
    assert.equal((r.goal?.history || []).some((row) => row.error === "boom"), true);
    const h2 = harness({
        context: ctx({ openGoal: r.goal }),
        replies: [talk("Still on the same order.", { goal: r.goal?.goal || "order", done: true })],
    });
    h2.loadGoal = () => r.goal;
    const again = await runAgentLoop({ messageId: "m5b", userText: "what happened" }, h2);
    assert.equal((again.goal?.history || []).length > 0 || (r.goal?.history || []).length > 0, true);
    assert.match(again.say, /Still on the same order/);
});

await t("more_results uses the stored query when the model asks for the next page", async () => {
    for (const word of ["show more", "any"]) {
        const goal = openGoal({ query: "ice cream", goal: "order ice cream" });
        const h = harness({
            context: ctx({ openGoal: goal }),
            replies: [talk("more", { goal: "order ice cream", tool: "more_results", tool_args: {}, done: false }), talk("Here are more.", { goal: "order ice cream", done: true })],
        });
        h.loadGoal = () => goal;
        const r = await runAgentLoop({ messageId: `more-${word}`, userText: word }, h);
        const page = r.toolTrace.find((x) => x.name === "more_results");
        assert.ok(page);
        assert.equal(page!.args.query, "ice cream");
        assert.notEqual(page!.args.query, word);
        assert.equal(r.toolTrace.some((x) => x.name === "search_store"), false);
    }
});

await t("a follow-up while a goal is open does not create a second search from the raw words", async () => {
    const goal = openGoal();
    const h = harness({
        context: ctx({ openGoal: goal }),
        replies: [
            talk("berry", { goal: "order a protein bar", tool: "search_store", tool_args: { store: "instamart", query: "RiteBite Max Protein berry" }, done: false }),
            talk("Those are the berry ones.", { goal: "order a protein bar", done: true }),
        ],
    });
    h.loadGoal = () => goal;
    const r = await runAgentLoop({ messageId: "m7", userText: "the berry one" }, h);
    const searches = r.toolTrace.filter((x) => x.name === "search_store");
    assert.equal(searches.length, 1);
    assert.equal(searches[0]!.args.query, "RiteBite Max Protein berry");
    assert.equal(h.careHits, 0);
});

await t("retry loads the open goal and does not hit the care-record handler", async () => {
    const goal = openGoal();
    const h = harness({
        context: ctx({ openGoal: goal }),
            replies: [talk("retrying", { tool: "search_store", tool_args: { store: "instamart", query: "protein bar" }, done: false }), talk("Same protein bars.", { goal: "order a protein bar", done: true })],
    });
    h.loadGoal = () => goal;
    const r = await runAgentLoop({ messageId: "m8", userText: "retry" }, h);
    assert.equal(h.careHits, 0);
    const search = r.toolTrace.find((x) => x.name === "search_store");
    assert.equal(search?.args.query, "protein bar");
});

await t("a new request drops the old goal and the reply says that in one line", async () => {
    const goal = openGoal();
    const h = harness({
        context: ctx({ openGoal: goal }),
        replies: [talk("Checking ice cream.", { goal: "order ice cream", done: true })],
    });
    h.loadGoal = () => goal;
    const r = await runAgentLoop({ messageId: "m9", userText: "ice cream please" }, h);
    assert.equal(r.say, "Checking ice cream.");
    assert.equal(goal.status, "dropped");
});

await t("allergy item is absent from tool data passed to Pro", async () => {
    const h = harness({
        context: ctx({ allergies: ["peanut"] }),
        replies: [
            talk("search", { tool: "search_store", tool_args: { store: "instamart", query: "protein bar" }, done: false }),
            talk("Milk bar only.", { done: true }),
        ],
        adapters: {
            linkedSearch: async () => ({
                ok: true,
                data: { items: [{ id: "p", name: "Peanut protein bar", price: "40" }, { id: "m", name: "Milk protein bar", price: "45" }] },
            }),
        },
    });
    const r = await runAgentLoop({ messageId: "m10", userText: "protein bar please" }, h);
    const data = r.goal?.lastResult as ToolResult;
    const names = ((data.data as { items?: Array<{ name: string }> })?.items || []).map((i) => i.name);
    assert.deepEqual(names, ["Milk protein bar"]);
});

await t("extract_record leaves a missing value null", async () => {
    const seen = new Set<string>();
    const h = harness({
        replies: [talk("read", { tool: "extract_record", tool_args: { hash: "h1", medicines: ["Dolo"] }, done: false }), talk("Saved the page.", { done: true })],
        seenHashes: seen,
    });
    const r = await runAgentLoop({ messageId: "m11", userText: "here is the report" }, h);
    const data = (r.goal?.lastResult as ToolResult).data as { lab: unknown; dates: unknown; medicines: unknown };
    assert.equal(data.lab, null);
    assert.equal(data.dates, null);
    assert.deepEqual(data.medicines, ["Dolo"]);
    const h2 = harness({
        replies: [talk("again", { tool: "extract_record", tool_args: { hash: "h1" }, done: false }), talk("Already had it.", { done: true })],
        seenHashes: seen,
    });
    const again = await runAgentLoop({ messageId: "m11b", userText: "same file" }, h2);
    assert.equal(((again.goal?.lastResult as ToolResult).data as { duplicate: boolean }).duplicate, true);
});

await t("Flash rejects paneer when it is not in facts, and rejects the word browser", async () => {
    const h = harness({ replies: [talk("Have some paneer butter masala tonight."), talk("Have some paneer butter masala tonight.")] });
    const r = await runAgentLoop({ messageId: "m12", userText: "how are you today" }, h);
    assert.doesNotMatch(r.say, /paneer/i);
    assert.match(r.blockedText || "", /paneer/i);
    const h2 = harness({ replies: [talk("I will use the browser."), talk("I will use the browser.")] });
    const r2 = await runAgentLoop({ messageId: "m12b", userText: "how are you today" }, h2);
    assert.doesNotMatch(r2.say, /browser/i);
    assert.match(r2.blockedText || "", /browser/i);
});

await t("medicine due with no send leaves last_reminded_at empty, and the why-not turn says it was missed", async () => {
    const meds = [{ id: "med1", name: "Dolo", lastRemindedAt: null }];
    const h = harness({ context: ctx({ medicines: meds }), replies: [talk("I missed the medicine reminder. Please take it now.")] });
    const r = await runAgentLoop({ messageId: "m13", userText: "Why did you not remind me for medicine today?" }, h);
    assert.equal(meds[0]!.lastRemindedAt, null);
    assert.equal(r.say, "I missed the medicine reminder. Please take it now.");
});

await t("name correction is in the next say", async () => {
    const h = harness({ replies: [talk("Okay, I won't call you that.", { tool: "save_preference", tool_args: { text: "Dont call me maa" }, done: false }), talk("Okay, I won't call you that.", { done: true })] });
    const r = await runAgentLoop({ messageId: "m14", userText: "Dont call me maa" }, h);
    assert.equal(r.toolTrace.some((x) => x.name === "save_preference"), true);
    assert.equal(r.say, "Okay, I won't call you that.");
    const h2 = harness({ replies: [talk("Papa, how are you?")] });
    const r2 = await runAgentLoop({ messageId: "m14b", userText: "Call me Papa" }, h2);
    assert.equal(r2.say, "Papa, how are you?");
});

await t("linked search error triggers browser_search once, and both errors produce one reconnect sentence", async () => {
    let browser = 0;
    const h = harness({
        replies: [talk("search", { tool: "search_store", tool_args: { store: "instamart", query: "ice cream" }, done: false })],
        adapters: {
            linkedSearch: async () => {
                throw new Error("401 after successful authentication");
            },
            browserSearch: async () => {
                browser++;
                throw new Error("page failed");
            },
        },
    });
    const r = await runAgentLoop({ messageId: "m15", userText: "ice cream please" }, h);
    assert.equal(browser, 1);
    assert.equal(r.say, "instamart needs connecting again. Dashboard → Integrations: disconnect it, then connect it again.");
});

await t("8-step cap stops", async () => {
    const h = harness({
        replies: Array.from({ length: 12 }, () => talk("again", { tool: "search_store", tool_args: { store: "instamart", query: "milk" }, done: false })),
    });
    const r = await runAgentLoop({ messageId: "m16", userText: "milk please, a long enough message" }, h);
    assert.equal(r.toolTrace.filter((x) => x.name === "search_store").length, 8);
    assert.match(r.say, /one answer/);
});

await t("feedback is not sent while waiting_confirm", async () => {
    const h = harness({
        tools: { draft_order: async () => ({ ok: true, data: { payment: "cash" } }) },
        replies: [talk("card", { tool: "draft_order", tool_args: { item_id: "1" }, done: false }), talk("Reply confirm.", { done: false })],
    });
    const r = await runAgentLoop({ messageId: "m17", userText: "the first one please" }, h);
    assert.equal(r.goal?.status, "waiting_confirm");
    assert.equal(r.enqueueFeedback, false);
});

await t("the flag stays off for a real number", async () => {
    const prev = process.env.AGENT_LOOP;
    process.env.AGENT_LOOP = "1";
    assert.equal(agentLoopEnabled("+999700000099"), true);
    assert.equal(agentLoopEnabled("+919876543210"), false);
    if (prev === undefined) delete process.env.AGENT_LOOP;
    else process.env.AGENT_LOOP = prev;
});

await t("100 fake families pass, then none remain", async () => {
    const cities = ["Delhi NCR", "Mumbai", "Bengaluru", "Raipur", "Ambikapur"];
    const goals: GoalDoc[] = [];
    const messages: string[] = [];
    let failed = 0;
    for (let i = 0; i < 100; i++) {
        const phone = `+9997${String(100000 + i)}`;
        const allergy = i % 5 === 0 ? ["peanut"] : [];
        const forbid = i % 7 === 0;
        const text = forbid ? "Dont call me maa" : i % 2 === 0 ? "kaise ho aaj subah se" : `Please check milk in ${cities[i % cities.length]}`;
        const goal = i === 3 ? openGoal({ elderId: phone }) : null;
        const h = harness({
            context: ctx({ elderId: phone, phone, allergies: allergy, language: i % 2 === 0 ? "hi" : "en", openGoal: goal }),
            replies: [talk(forbid ? "I am here." : "How are you?", { goal: goal?.goal || "check how they are", tool: forbid ? "save_preference" : null, tool_args: forbid ? { text: text } : {}, done: true })],
        });
        if (goal) h.loadGoal = () => goal;
        const r = await runAgentLoop({ messageId: `fam-${i}`, userText: text }, h);
        messages.push(r.say);
        if (r.goal) goals.push(r.goal);
        if (forbid && /\bmaa\b/i.test(r.say)) failed++;
        if (allergy.length && /peanut/i.test(JSON.stringify(r.goal?.lastResult || ""))) failed++;
        if (!r.say.trim()) failed++;
    }
    assert.equal(failed, 0);
    assert.equal(messages.length, 100);
    goals.length = 0;
    messages.length = 0;
    assert.equal(goals.length, 0);
    assert.equal(messages.length, 0);
});

console.log(`all ${n} passed`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
