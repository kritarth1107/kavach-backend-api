/**
 * One memory is the truth (trust plan A1) and the brain's failures are never silent (A1, C5), on the backend:
 *  - the WhatsApp path writes nothing to the retired Mongo profile (ElderProfile, ElderUsuals) and never calls the old
 *    brain or the Instinct inbox (/v1/chat, /v1/memory);
 *  - when the brain cannot answer (the engine's 503): one holding line in the person's language at once (written ahead,
 *    no model call), the turn is retried every 30 s for 10 minutes and answered normally; still failing, the team is
 *    emailed and the person told their message is saved; later messages carry the waiting ones;
 *  - the reminder's fallback text uses the engine's name rule (cached 60 s, dropped when the engine says it changed);
 *  - save_memory / recall_memories are refused; the memory move's export reads the old stores without writing;
 *  - the nightly count of writes to the old stores alerts the team when it is not 0.
 * Pure checks always; the DB checks need TEST_MONGODB_URI (a throwaway local mongod; CI has one).
 * Usage: TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-one-memory.ts
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { testDbUri } from "./test-db";

process.env.JWT_SECRET = process.env.JWT_SECRET || "one-memory-test-secret";
process.env.AES_SECRET = process.env.AES_SECRET || "one-memory-test-aes-secret";
process.env.WHATSAPP_PROVIDER = "mock";
process.env.AI_ENGINE_URL = "http://ai-engine.test";
process.env.BRAIN_V2 = "live";
delete process.env.BRAIN_V2_LIVE_FAMILIES;

let passed = 0;
const ok = (name: string, fn: () => void | Promise<void>) =>
    Promise.resolve()
        .then(fn)
        .then(
            () => {
                passed++;
                console.log(`  ✓ ${name}`);
            },
            (err) => {
                console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack || err.message : err}`);
                process.exitCode = 1;
            },
        );

/** The AI engine, faked. Every request is recorded; /v1/* (the old brain, the Instinct inbox) must never be asked. */
const engine = {
    calls: [] as Array<{ method: string; path: string; body: Record<string, unknown> }>,
    turn: (_body: Record<string, unknown>): { status: number; body: unknown } => ({ status: 200, body: { reply: "Namaste ji", actions: [], alerts: [], model: "fake" } }),
    person: { name: null as string | null, avoid: [] as string[], language: null as string | null, dialect: null, script: null, voice: null, known: false },
    legacy: { family_memories: 0, memory_entities: 0, memory_profiles: 0 } as Record<string, number>,
};
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.startsWith("http://ai-engine.test")) {
        const p = u.slice("http://ai-engine.test".length);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        engine.calls.push({ method: init?.method || "GET", path: p, body });
        if (p === "/v2/turn") {
            const r = engine.turn(body);
            return json(r.body, r.status);
        }
        if (p.startsWith("/v2/person/")) return json(engine.person);
        if (p.startsWith("/v2/jobs/legacy-writes")) return json({ counts: engine.legacy, total: Object.values(engine.legacy).reduce((a, b) => a + b, 0) });
        if (p.startsWith("/v2/events")) return json({ ok: true });
        return json({ detail: "not faked" }, 404);
    }
    if (u.includes("graph.facebook.com")) return json({ messages: [{ id: `wamid.${randomUUID()}` }] });
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)) return realFetch(url as string, init);
    return json({ error: "no outside requests in this test" }, 503);
}) as typeof fetch;
const v1Calls = () => engine.calls.filter((c) => c.path.startsWith("/v1/"));

async function pure() {
    console.log("pure");
    const H = await import("../src/services/brainHold.service");
    const { LANGUAGES } = await import("../src/services/language.service");
    const P = await import("../src/clients/enginePerson.client");

    await ok("a holding line and a 'your message is saved' line are written ahead for every language Saheli speaks", () => {
        for (const l of LANGUAGES) {
            const lines = H.HOLD_LINES[l.code];
            assert.ok(lines?.holding && lines.trouble, `missing ${l.code}`);
            assert.equal(H.holdLines({ language: l.code }), lines);
        }
    });
    await ok("a dialect speaks its base language; Roman letters only where asked; nothing known → English", () => {
        assert.equal(H.holdLines({ language: "hi", dialect: "mwr" }).holding, H.HOLD_LINES.hi!.holding);
        assert.equal(H.holdLines({ language: "hi", script: "roman" }).holding, "Ek minute, main abhi jawab deti hoon 🙏");
        assert.equal(H.holdLines({}).holding, "One moment, I'll reply shortly 🙏");
        assert.equal(H.holdLines({ language: "bn" }).trouble, H.HOLD_LINES.bn!.trouble);
    });
    await ok("Saheli's own text never uses a name the person asked not to be called (the care record's avoid list)", () => {
        assert.equal(P.withoutAvoidedNames("Maa, time for your Metformin.", { name: "Leela ji", avoid: ["Maa"] }), "Leela ji, time for your Metformin.");
        assert.equal(P.withoutAvoidedNames("Good morning maa! Dawai le lijiye", { name: null, avoid: ["Maa"] }), "Good morning! Dawai le lijiye");
        assert.equal(P.withoutAvoidedNames("मां, दवाई का समय", { name: "लीला जी", avoid: ["मां"] }), "लीला जी, दवाई का समय");
        assert.equal(P.withoutAvoidedNames("Maanvi called", { name: "X", avoid: ["Maa"] }), "Maanvi called"); // a whole word only
    });
    await ok("the old memory tools are refused (the care record's remember and recall are the only memory)", async () => {
        const { executeSaheliTool } = await import("../src/services/saheliTools.service");
        for (const tool of ["save_memory", "recall_memories"]) {
            const out = await executeSaheliTool({ tool: tool as never, args: { content: "x" }, familyId: "f", recipientUserId: "u", actorUserId: "u" });
            assert.equal(out.ok, false);
            assert.match(String(out.error), /retired/);
        }
        assert.equal(v1Calls().length, 0);
    });
    await ok("the person view is cached 60 s and dropped at once when the engine says it changed", async () => {
        P.resetEnginePersonCache();
        engine.person = { ...engine.person, name: "Kamla ji", avoid: ["Maa"] };
        const t0 = Date.now();
        const reads = () => engine.calls.filter((c) => c.path === "/v2/person/fam-c/user-c").length;
        assert.equal((await P.getEnginePerson("fam-c", "user-c", { now: t0 })).name, "Kamla ji");
        engine.person = { ...engine.person, name: "Kamla Devi" };
        assert.equal((await P.getEnginePerson("fam-c", "user-c", { now: t0 + 30_000 })).name, "Kamla ji");
        assert.equal(reads(), 1);
        P.forgetEnginePerson("fam-c", "user-c"); // what the person_memory_changed tool does (its family check needs the DB)
        assert.equal((await P.getEnginePerson("fam-c", "user-c", { now: t0 + 31_000 })).name, "Kamla Devi");
        assert.equal(reads(), 2);
        engine.person = { ...engine.person, name: "Kamla" };
        assert.equal((await P.getEnginePerson("fam-c", "user-c", { now: t0 + 31_000 + 60_001 })).name, "Kamla");
        assert.equal(reads(), 3);
    });
}

async function withDb(uri: string) {
    console.log("db");
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const Family = (await import("../src/models/family.model")).default;
    const User = (await import("../src/models/users.model")).default;
    const ChannelIdentity = (await import("../src/models/channelIdentity.model")).default;
    const ElderProfile = (await import("../src/models/elderProfile.model")).default;
    const ElderUsuals = (await import("../src/models/elderUsuals.model")).default;
    const BrainRetryTurn = (await import("../src/models/brainRetryTurn.model")).default;
    const { FamilyMemberStatus, FamilyRole } = await import("../src/types/family.types");
    const { ChannelType } = await import("../src/types/careRecord.types");
    const { handleWhatsAppInbound } = await import("../src/services/whatsappRouting.service");
    const H = await import("../src/services/brainHold.service");
    const P = await import("../src/clients/enginePerson.client");

    const mk = (first: string) =>
        User.create({ email: `${first.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`, firstName: first, lastName: "Test", passwordHash: "x",
                      emailVerified: true, phone: { countryCode: "+99", number: String(1_000_000_000 + Math.floor(Math.random() * 8e9)) } });
    const cg = await mk("Ravi");
    const elder = await mk("Kamla");
    const fam = await Family.create({
        name: "Test family", createdBy: cg.userId,
        members: [
            { userId: cg.userId, role: FamilyRole.PRIMARY_CAREGIVER, status: FamilyMemberStatus.JOINED, name: "Ravi" },
            { userId: elder.userId, role: FamilyRole.CARE_RECIPIENT, status: FamilyMemberStatus.JOINED, name: "Kamla" },
        ],
    });
    const phone = "+919000012345";
    await ChannelIdentity.create({ channelType: ChannelType.WHATSAPP, channelIdentifier: phone, familyId: fam.familyId, userId: elder.userId,
                                   role: FamilyRole.CARE_RECIPIENT, active: true });
    const say = async (text: string) => {
        const t = Date.now();
        const out = await handleWhatsAppInbound({ from: phone, text, messageId: `wamid.${randomUUID()}` } as never);
        return { content: String(out.content ?? ""), ms: Date.now() - t, out };
    };

    await ok("the WhatsApp path writes nothing to the old profile or usuals, and never asks the old brain", async () => {
        engine.turn = () => ({ status: 200, body: { reply: "Theek hai, yaad rakhungi.", actions: [], alerts: [], model: "fake" } });
        for (const text of ["main sirf Amul leti hoon", "mujhe purane gaane pasand hai", "ek aadmi ne phone kiya, OTP bata do bol raha tha", "aaj meri dawai kab leni hai?"]) {
            const r = await say(text);
            assert.equal(r.content, "Theek hai, yaad rakhungi.");
        }
        assert.equal(await ElderProfile.countDocuments({}), 0);
        assert.equal(await ElderUsuals.countDocuments({}), 0);
        assert.equal(v1Calls().length, 0);
        assert.equal(engine.calls.filter((c) => c.path === "/v2/turn").length, 4);
    });

    await ok("the engine's 503: one holding line in her language within 15 s, the turn queued, the old brain never called", async () => {
        P.resetEnginePersonCache();
        engine.person = { ...engine.person, language: "hi", known: true };
        engine.turn = () => ({ status: 503, body: { detail: "Saheli is unavailable" } });
        const r = await say("aaj BP 150/90 aaya");
        assert.equal(r.content, H.HOLD_LINES.hi!.holding);
        assert.equal(r.out.holding, true);
        assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
        const rows = await BrainRetryTurn.find({ userId: elder.userId, status: "queued" }).lean();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.text, "aaj BP 150/90 aaya");
        assert.equal(v1Calls().length, 0);
    });

    await ok("a message while one waits carries it to the brain (one answer, in order)", async () => {
        const seen: string[] = [];
        engine.turn = (body) => {
            seen.push(String(body.text));
            return { status: 200, body: { reply: "Aapka BP note kar liya.", actions: [], alerts: [], model: "fake" } };
        };
        const r = await say("aur sar dard bhi hai");
        assert.equal(r.content, "Aapka BP note kar liya.");
        assert.match(seen[0]!, /aaj BP 150\/90 aaya[\s\S]*aur sar dard bhi hai/);
        assert.equal(await BrainRetryTurn.countDocuments({ userId: elder.userId, status: "queued" }), 0);
        assert.equal(await BrainRetryTurn.countDocuments({ userId: elder.userId, status: "merged" }), 1);
    });

    const held = async (ago: number) => {
        await BrainRetryTurn.deleteMany({});
        const now = Date.now();
        await BrainRetryTurn.create({ familyId: fam.familyId, userId: elder.userId, role: FamilyRole.CARE_RECIPIENT, phone, messageRef: `wamid.${randomUUID()}`,
                                      text: "dawai kab leni hai", status: "queued", attempts: 1, nextAt: new Date(now - 1000), firstFailedAt: new Date(now - ago) });
    };
    const fakeDeps = () => {
        const d = {
            sent: [] as string[], alerts: [] as string[], tries: 0, succeedOn: Infinity,
            brain: async () => {
                d.tries++;
                if (d.tries >= d.succeedOn) return { reply: "Subah 8 baje, khane ke baad." };
                throw new Error("Brain v2 HTTP 503");
            },
            send: async (_row: unknown, text: string) => { d.sent.push(text); },
            alert: async (key: string) => { d.alerts.push(key); },
            lines: async () => H.HOLD_LINES.hi!,
        };
        return d;
    };

    await ok("a held turn is retried every 30 s and, when the brain answers, the answer goes out once as a normal reply", async () => {
        await held(40_000);
        const d = fakeDeps();
        d.succeedOn = 2;
        let now = Date.now();
        let out = await H.runBrainRetryTick(new Date(now), d as never);
        assert.deepEqual([out.tried, out.answered], [1, 0]);
        const row = await BrainRetryTurn.findOne({}).lean();
        assert.equal(new Date(row!.nextAt).getTime() - now, H.RETRY_EVERY_MS);
        out = await H.runBrainRetryTick(new Date(now + 10_000), d as never);
        assert.equal(out.tried, 0); // not due yet
        now += H.RETRY_EVERY_MS;
        out = await H.runBrainRetryTick(new Date(now), d as never);
        assert.deepEqual([out.tried, out.answered], [1, 1]);
        assert.deepEqual(d.sent, ["Subah 8 baje, khane ke baad."]);
        assert.equal((await BrainRetryTurn.findOne({}).lean())!.status, "answered");
        out = await H.runBrainRetryTick(new Date(now + H.RETRY_EVERY_MS), d as never);
        assert.equal(out.tried, 0);
        assert.deepEqual(d.alerts, []);
    });

    await ok("still failing after 10 minutes: the team is emailed and she hears 'your message is saved'; then every 5 min, then given up at 3 h with another email", async () => {
        await held(H.RETRY_WINDOW_MS + 1000);
        const d = fakeDeps();
        let now = Date.now();
        let out = await H.runBrainRetryTick(new Date(now), d as never);
        assert.equal(out.trouble, 1);
        assert.deepEqual(d.sent, [H.HOLD_LINES.hi!.trouble]);
        assert.deepEqual(d.alerts, ["brain-hold-10min"]);
        const row = await BrainRetryTurn.findOne({}).lean();
        assert.equal(row!.status, "queued");
        assert.equal(new Date(row!.nextAt).getTime() - now, H.SLOW_EVERY_MS);
        now += H.SLOW_EVERY_MS;
        out = await H.runBrainRetryTick(new Date(now), d as never);
        assert.deepEqual([out.tried, out.trouble], [1, 0]); // the saved line goes once
        assert.equal(d.sent.length, 1);
        await BrainRetryTurn.updateOne({}, { $set: { firstFailedAt: new Date(now - H.GIVE_UP_AFTER_MS - 1000), nextAt: new Date(now) } });
        out = await H.runBrainRetryTick(new Date(now), d as never);
        assert.equal(out.gaveUp, 1);
        assert.deepEqual(d.alerts, ["brain-hold-10min", "brain-hold-gave-up"]);
        assert.equal((await BrainRetryTurn.findOne({}).lean())!.status, "gave_up");
    });

    await ok("the retry goes through the real brain call (same message id, so a turn the engine finished is not done twice)", async () => {
        await held(40_000);
        const refs: string[] = [];
        engine.turn = (body) => {
            refs.push(String(body.message_ref));
            return { status: 200, body: { reply: "Ho gaya.", actions: [], alerts: [], model: "fake" } };
        };
        const d = fakeDeps();
        const V2 = await import("../src/services/brainV2.service");
        const out = await H.runBrainRetryTick(new Date(), {
            ...d,
            brain: (row: { messageRef: string; familyId: string; userId: string; role: string; text: string }) =>
                V2.runBrainV2({ identity: { familyId: row.familyId, userId: row.userId, role: row.role }, text: row.text, messageRef: row.messageRef, mode: "live" }),
        } as never);
        assert.equal(out.answered, 1);
        const row = await BrainRetryTurn.findOne({}).lean();
        assert.deepEqual(refs, [row!.messageRef]);
        assert.deepEqual(d.sent, ["Ho gaya."]);
    });

    await ok("the reminder's fallback text uses the engine's name rule, never an avoided name", async () => {
        P.resetEnginePersonCache();
        engine.person = { name: "Leela ji", avoid: ["Maa"], language: "en", dialect: null, script: null, voice: null, known: true };
        const { careNudgeFallbackText } = await import("../src/services/saheliCareNudge.service");
        const r = await careNudgeFallbackText({ familyId: fam.familyId, recipientUserId: elder.userId, displayName: "Maa", title: "Metformin 500 mg",
                                                time: "08:00", nudgeKind: "dose_due", preferredLanguage: "english" });
        assert.ok(!/\bmaa\b/i.test(r.text), r.text);
        assert.ok(engine.calls.some((c) => c.path === `/v2/person/${fam.familyId}/${elder.userId}`));
        assert.equal(await ElderProfile.countDocuments({}), 0);
    });

    await ok("the engine's change push drops the cached name at once (person_memory_changed)", async () => {
        P.resetEnginePersonCache();
        engine.person = { ...engine.person, name: "Leela ji" };
        await P.getEnginePerson(fam.familyId, elder.userId);
        engine.person = { ...engine.person, name: "Leela Devi" };
        const { executeSaheliTool } = await import("../src/services/saheliTools.service");
        assert.deepEqual(await executeSaheliTool({ tool: "person_memory_changed", args: {}, familyId: fam.familyId, recipientUserId: elder.userId, actorUserId: elder.userId }), { ok: true });
        assert.equal((await P.getEnginePerson(fam.familyId, elder.userId)).name, "Leela Devi");
    });

    await ok("the memory move's export lists families with old memory and reads them without writing", async () => {
        await ElderProfile.collection.insertOne({ familyId: fam.familyId, recipientUserId: elder.userId, tuning: { addressAs: "Amma" },
            facts: [{ id: "f1", category: "preferences", text: "Likes ginger tea", status: "learned", confidence: 0.8 }], updatedAt: new Date(0), createdAt: new Date(0) });
        const { executeSaheliTool } = await import("../src/services/saheliTools.service");
        const list = await executeSaheliTool({ tool: "export_legacy_memory", args: { list: true }, familyId: "-", recipientUserId: "-", actorUserId: "-" });
        assert.deepEqual(list.families, [{ family_id: fam.familyId, actor_id: elder.userId }]);
        const before = JSON.stringify(await ElderProfile.collection.find({}).toArray());
        const data = await executeSaheliTool({ tool: "export_legacy_memory", args: {}, familyId: fam.familyId, recipientUserId: elder.userId, actorUserId: elder.userId }) as Record<string, any>;
        const me = data.people.find((p: { id: string }) => p.id === elder.userId);
        assert.equal(me.profile.facts[0].id, "f1");
        assert.equal(me.profile.tuning.addressAs, "Amma");
        assert.deepEqual(me.caregiver_ids, [cg.userId]);
        assert.equal(JSON.stringify(await ElderProfile.collection.find({}).toArray()), before);
    });

    await ok("the nightly count of writes to the old stores: 0 is quiet, anything else emails the team; 7 zero days meet the bar", async () => {
        const L = await import("../src/services/legacyWriteCheck.service");
        const LegacyWriteCheck = (await import("../src/models/legacyWriteCheck.model")).default;
        await LegacyWriteCheck.deleteMany({});
        const alerts: string[] = [];
        const alert = async (k: string) => { alerts.push(k); };
        const base = new Date("2026-10-20T02:00:00Z"); // 07:30 IST
        // the export row above was written "long ago" (updatedAt 1970): not a write in the window
        let row = await L.runLegacyWriteCheck(base, { engine: async () => ({ family_memories: 0, memory_entities: 0, memory_profiles: 0 }), alert });
        assert.equal(row!.total, 0);
        assert.deepEqual(alerts, []);
        assert.equal(await L.runLegacyWriteCheck(new Date(base.getTime() + 3600_000), { engine: async () => ({}), alert }), null); // once a day
        await ElderUsuals.collection.insertOne({ familyId: "x", recipientUserId: "y", createdAt: new Date(base.getTime() + 86_000_000), updatedAt: new Date(base.getTime() + 86_000_000) });
        row = await L.runLegacyWriteCheck(new Date(base.getTime() + 86_400_000), { engine: async () => ({ family_memories: 2, memory_entities: 0, memory_profiles: 0 }), alert });
        assert.deepEqual([row!.counts.ElderUsuals, row!.counts.family_memories, row!.total], [1, 2, 3]);
        assert.deepEqual(alerts, ["legacy-writes"]);
        row = await L.runLegacyWriteCheck(new Date(base.getTime() + 2 * 86_400_000), { engine: async () => null, alert });
        assert.equal(row!.engineChecked, false);
        assert.deepEqual(alerts, ["legacy-writes", "legacy-writes"]); // the engine not counted is not a pass
        for (let i = 3; i < 10; i++) await L.runLegacyWriteCheck(new Date(base.getTime() + i * 86_400_000), { engine: async () => ({ family_memories: 0 }), alert });
        const rep = await L.legacyWriteReport(7);
        assert.equal(rep.allZero, true);
        assert.equal((await L.legacyWriteReport(9)).allZero, false);
    });

    assert.equal(v1Calls().length, 0, "the old brain was asked");
    await mongoose.disconnect();
}

(async () => {
    await pure();
    const uri = testDbUri("one_memory");
    if (uri) await withDb(uri);
    else console.log("(DB checks skipped: set TEST_MONGODB_URI to a throwaway local mongod)");
    console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
    process.exit(process.exitCode ?? 0);
})();
