/**
 * Food and nutrition (nutrition plan §N8, §N10; engine INTERFACES.md §3): the dashboard's proxy to the engine's food log,
 * the doctor links (ShareLink kind "nutrition") and the nutrition.page switch.
 *
 * Rules checked: only a joined caregiver (about the person they care for, or about themselves) reaches the food log and
 * makes or revokes a doctor link; never the person cared for, a view-only member or another family. A link expires
 * (default 7 days), can be revoked, counts opens and carries no phone number or internal id. No link is made while the
 * page is switched off, on the dashboard or on WhatsApp.
 *
 *   TEST_MONGODB_URI=mongodb://127.0.0.1:27999/x NODE_ENV=test npx tsx scripts/test-nutrition.ts
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { testDbUri } from "./test-db";

let passed = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack || err.message : err}`);
        process.exitCode = 1;
    }
};

type Seen = { method: string; path: string; body: Record<string, unknown> | null };
const seen: Seen[] = [];
const REPORT = {
    subjectId: "eld-n", days: 7, from: "2026-10-08", to: "2026-10-14", daysLogged: 3,
    averages: { energy_kcal: 1500, protein_g: 52 }, daily: [], targets: [], rules: [], mealPattern: { breakfast: 3 },
    skipped: {}, topFoods: [{ name: "Egg, boiled", times: 4, kcalShare: 20 }], confidence: { said: 4 }, deviations: [], weight: [],
    note: "Numbers come from what was logged.",
};

function fakeEngine(): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            const path = req.url || "";
            seen.push({ method: req.method || "", path, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
            const bare = path.split("?")[0];
            let out: unknown = { result: "saved", say: "Saved." };
            if (bare.endsWith("/nutrition/report")) out = REPORT;
            else if (bare.endsWith("/nutrition") && req.method === "GET") out = { subjectId: "eld-n", day: "2026-10-14", today: { meals: [] } };
            else if (bare.endsWith("/nutrition/foods")) out = { foods: [{ id: "f1", name: "Egg, boiled" }] };
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(out));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
    const uri = testDbUri("nutritiontest");
    if (!uri) {
        console.log("nutrition: no TEST_MONGODB_URI, DB checks skipped");
        return;
    }
    const engine = await fakeEngine();
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    process.env.MONGODB_URI = uri;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "nutrition-test-secret";
    process.env.LIVE_FRONTEND_URL = "https://app.example.test";
    delete process.env.NUTRITION_PAGE;
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();

    const { default: Family } = await import("../src/models/family.model");
    const { default: User } = await import("../src/models/users.model");
    const people = [
        { id: "cg-n", first: "Asha", role: "PRIMARY_CAREGIVER", phone: { countryCode: "+91", number: "9000000001" } },
        { id: "co-n", first: "Ravi", role: "CO_CAREGIVER", phone: { countryCode: "+91", number: "9000000002" } },
        { id: "eld-n", first: "Kamala", role: "CARE_RECIPIENT", phone: { countryCode: "+91", number: "9000000003" } },
        { id: "view-n", first: "Neha", role: "VIEW_ONLY" },
        { id: "doc-n", first: "Rao", role: "FAMILY_DOCTOR" },
        { id: "cg-x", first: "Other", role: "PRIMARY_CAREGIVER" },
        { id: "eld-x", first: "OtherElder", role: "CARE_RECIPIENT" },
    ];
    for (const p of people) {
        await User.create({
            userId: p.id, firstName: p.first, email: `${p.id}@example.test`, passwordHash: "x-test-not-a-real-hash",
            ...(p.phone ? { phone: p.phone, phoneKey: `${p.phone.countryCode}${p.phone.number}` } : {}),
        });
    }
    await Family.create({
        familyId: "fam-n", name: "Test family", createdBy: "cg-n", status: "ACTIVE",
        members: people.filter((p) => !p.id.endsWith("-x")).map((p) => ({ userId: p.id, role: p.role, status: "JOINED", name: p.first })),
    });
    await Family.create({
        familyId: "fam-x", name: "Other family", createdBy: "cg-x", status: "ACTIVE",
        members: [{ userId: "cg-x", role: "PRIMARY_CAREGIVER", status: "JOINED" }, { userId: "eld-x", role: "CARE_RECIPIENT", status: "JOINED" }],
    });

    const app = (await import("../src/app")).default as unknown as http.RequestListener;
    const config = (await import("../src/config/app.config")).default;
    const Session = (await import("../src/models/session.model")).default;
    const flags = await import("../src/services/featureFlags.service");
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tokens = new Map<string, string>();
    const tokenFor = async (userId: string) => {
        if (tokens.has(userId)) return tokens.get(userId)!;
        const sessionId = randomUUID();
        const token = jwt.sign({ userId, email: `${userId}@example.test`, sessionId, authProvider: "EMAIL" }, config.jwt.secret, { expiresIn: "1h" });
        await Session.create({ sessionId, userId, tokenHash: Session.hashToken(token), fingerprint: "N/A", authProvider: "EMAIL",
                               expiresAt: new Date(Date.now() + 3600_000), lastActiveAt: new Date() });
        tokens.set(userId, token);
        return token;
    };
    const call = async (who: string | null, method: string, path: string, body?: unknown) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (who) headers.authorization = `Bearer ${await tokenFor(who)}`;
        const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const json = (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; message?: string };
        return { status: res.status, data: json.data as Record<string, unknown> | undefined, message: json.message };
    };
    const nu = (f: string, s: string) => `/api/families/${f}/subjects/${s}/care-memory/nutrition`;
    const last = () => seen[seen.length - 1];

    // ── who can reach the food log ──
    await ok("a caregiver reads the food page through the engine, with day and range passed on", async () => {
        const r = await call("cg-n", "GET", `${nu("fam-n", "eld-n")}?days=30&day=2026-10-12`);
        assert.equal(r.status, 200);
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition?days=30&day=2026-10-12");
    });
    await ok("a bad range or day is dropped, not passed to the engine", async () => {
        await call("cg-n", "GET", `${nu("fam-n", "eld-n")}?days=9&day=yesterday`);
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition");
    });
    await ok("a co-caregiver and a self-care caregiver (about themselves) can read it", async () => {
        assert.equal((await call("co-n", "GET", nu("fam-n", "eld-n"))).status, 200);
        assert.equal((await call("cg-n", "GET", nu("fam-n", "cg-n"))).status, 200);
        assert.equal(last().path, "/v2/dash/fam-n/cg-n/nutrition");
    });
    await ok("the person cared for, a view-only member and a doctor are refused", async () => {
        for (const who of ["eld-n", "view-n", "doc-n"]) {
            const before = seen.length;
            assert.equal((await call(who, "GET", nu("fam-n", "eld-n"))).status, 403, who);
            assert.equal(seen.length, before, `${who} reached the engine`);
        }
    });
    await ok("a caregiver cannot read another caregiver's own food log", async () => {
        assert.notEqual((await call("cg-n", "GET", nu("fam-n", "co-n"))).status, 200);
    });
    await ok("another family's caregiver is refused, and so is a request without a session", async () => {
        assert.equal((await call("cg-x", "GET", nu("fam-n", "eld-n"))).status, 403);
        assert.equal((await call(null, "GET", nu("fam-n", "eld-n"))).status, 401);
    });

    // ── what the dashboard sends, as the engine expects it ──
    await ok("adding food goes to the engine's log_food path with the caregiver as actor, in snake_case", async () => {
        const r = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries`, {
            items: [{ name: "boiled egg", quantity: 2, unit: "piece", foodId: "f1" }], meal: "breakfast", eatenAt: "2026-10-14T08:30",
        });
        assert.equal(r.status, 200);
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition/entries");
        const b = last().body!;
        assert.deepEqual(b.actor, { id: "cg-n", name: "Asha" });
        assert.deepEqual(b.items, [{ name: "boiled egg", quantity: 2, unit: "piece", food_id: "f1" }]);
        assert.equal(b.meal, "breakfast");
        assert.equal(b.eaten_at, "2026-10-14T08:30");
    });
    await ok("bad food input is refused before the engine (no items, no name, a silly amount, a bad meal or time)", async () => {
        const before = seen.length;
        for (const body of [{ items: [] }, { items: [{ quantity: 1 }] }, { items: [{ name: "egg", quantity: -1 }] },
                            { items: [{ name: "egg" }], meal: "brunch" }, { items: [{ name: "egg" }], eatenAt: "this morning" }]) {
            assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries`, body)).status, 400, JSON.stringify(body));
        }
        assert.equal(seen.length, before);
    });
    await ok("an answer to Saheli's question goes back to the same job; cancel needs no items", async () => {
        const job = randomUUID();
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries`, { answerTo: job, items: [{ name: "boiled egg", quantity: 3, unit: "piece" }] });
        assert.equal(last().body!.answer_to, job);
        assert.equal(last().body!.cancel, undefined);
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries`, { answerTo: job, cancel: true });
        assert.equal(last().body!.cancel, true);
        assert.deepEqual(last().body!.items, []);
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries`, { cancel: true })).status, 400);
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries`, { answerTo: "x", cancel: true })).status, 400);
    });
    await ok("correcting and deleting an entry go to change_food's routes", async () => {
        const id = randomUUID();
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries/${id}`, { set: { quantity: 3, eatenAt: "2026-10-14T09:00" } });
        assert.equal(last().path, `/v2/dash/fam-n/eld-n/nutrition/entries/${id}`);
        assert.deepEqual(last().body!.set, { quantity: 3, eaten_at: "2026-10-14T09:00" });
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries/${id}/delete`, {});
        assert.equal(last().path, `/v2/dash/fam-n/eld-n/nutrition/entries/${id}/delete`);
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/entries/not-an-id/delete`, {})).status, 400);
    });
    await ok("targets keep who set them and how strict they are", async () => {
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/targets`, { set: { protein_g: 60 }, setBy: "doctor", how: "strict" });
        assert.equal(last().body!.set_by, "doctor");
        assert.equal(last().body!.how, "strict");
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/targets`, { set: { protein_g: 60 }, setBy: "neighbour" })).status, 400);
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/targets`, { setBy: "self" })).status, 400);
    });
    await ok("settings, pantry and 'did they eat it?' reach their routes", async () => {
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/settings`, { tracking: "off", dailySummaryTo: ["cg-n"] });
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition/settings");
        assert.deepEqual(last().body!.daily_summary_to, ["cg-n"]);
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/pantry`, { action: "used", item: "protein bar", count: 1 });
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition/pantry");
        const task = randomUUID();
        await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/consumed`, { taskId: task, consumed: "part", portionEaten: "half" });
        assert.deepEqual({ ...last().body, actor: undefined }, { actor: undefined, task_id: task, consumed: "part", portion_eaten: "half" });
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/consumed`, { taskId: task, consumed: "maybe" })).status, 400);
    });
    await ok("food autocomplete: an empty search asks nothing of the engine", async () => {
        const before = seen.length;
        const r = await call("cg-n", "GET", `${nu("fam-n", "eld-n")}/foods?q=`);
        assert.deepEqual(r.data, { foods: [] });
        assert.equal(seen.length, before);
        await call("cg-n", "GET", `${nu("fam-n", "eld-n")}/foods?q=egg&limit=99`);
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition/foods?q=egg&limit=20");
    });
    await ok("the food log's history is reachable (kind food)", async () => {
        await call("cg-n", "GET", `/api/families/fam-n/subjects/eld-n/care-memory/memory-history?kind=food`);
        assert.match(last().path, /\/memory-history\?kind=food/);
    });

    // ── the switch ──
    await ok("the page is off by default; the dashboard reads the switch", async () => {
        flags.setFlagSnapshot({});
        assert.equal(flags.nutritionPageEnabled({}), false);
        assert.equal(flags.nutritionPageEnabled({ NUTRITION_PAGE: "on" }, {}), true);
        assert.equal(flags.nutritionPageEnabled({ NUTRITION_PAGE: "on" }, { "nutrition.page": false }), false);
        const r = await call("cg-n", "GET", "/api/families/fam-n/features");
        assert.equal(r.status, 200);
        assert.equal(r.data!.nutritionPage, false);
        assert.equal((await call("cg-x", "GET", "/api/families/fam-n/features")).status, 403);
    });
    await ok("while the page is off, no doctor link is made", async () => {
        flags.setFlagSnapshot({});
        const r = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 7 });
        assert.equal(r.status, 403);
        const { default: ShareLink } = await import("../src/models/shareLink.model");
        assert.equal(await ShareLink.countDocuments({}), 0);
    });

    // ── doctor links ──
    flags.setFlagSnapshot({ "nutrition.page": true });
    let share: Record<string, unknown> = {};
    await ok("a caregiver makes a link: 7 days by default, at /n/<token>", async () => {
        const r = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 14, label: "  Dr. Test  " });
        assert.equal(r.status, 200);
        share = r.data!;
        assert.match(String(share.url), /^https:\/\/app\.example\.test\/n\/[A-Za-z0-9_-]{20,}$/);
        assert.equal(share.days, 14);
        assert.equal(share.label, "Dr. Test");
        assert.equal(share.active, true);
        const ms = new Date(String(share.expiresAt)).getTime() - Date.now();
        assert.ok(ms > 6.9 * 86_400_000 && ms <= 7 * 86_400_000, `expires in ${ms} ms`);
    });
    await ok("a link's lifetime and window are checked", async () => {
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 5 })).status, 400);
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 7, expiresInDays: 90 })).status, 400);
        const r = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 30, expiresInDays: 1 });
        const ms = new Date(String(r.data!.expiresAt)).getTime() - Date.now();
        assert.ok(ms <= 86_400_000 && ms > 0.9 * 86_400_000);
    });
    await ok("a self-care caregiver can share their own report", async () => {
        assert.equal((await call("cg-n", "POST", `${nu("fam-n", "cg-n")}/shares`, { days: 7 })).status, 200);
    });
    await ok("the person cared for, view-only, a doctor and another family cannot make, list or revoke links", async () => {
        for (const who of ["eld-n", "view-n", "doc-n", "cg-x"]) {
            assert.equal((await call(who, "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 7 })).status, 403, who);
            assert.equal((await call(who, "GET", `${nu("fam-n", "eld-n")}/shares`)).status, 403, who);
            assert.equal((await call(who, "DELETE", `${nu("fam-n", "eld-n")}/shares/${share.id}`)).status, 403, who);
        }
    });
    await ok("the doctor's page: the name and the report, no phone number, no internal id; each open counted", async () => {
        const token = String(share.url).split("/n/")[1];
        const r = await call(null, "GET", `/api/public/nutrition/${token}`);
        assert.equal(r.status, 200);
        assert.equal(last().path, "/v2/dash/fam-n/eld-n/nutrition/report?days=14");
        const d = r.data!;
        assert.deepEqual(d.person, { name: "Kamala" });
        assert.equal(d.days, 14);
        const text = JSON.stringify(d);
        assert.doesNotMatch(text, /9000000|\+91|phone/i);
        assert.doesNotMatch(text, /eld-n|fam-n|cg-n/);
        assert.equal((d.report as Record<string, unknown>).daysLogged, 3);
        await call(null, "GET", `/api/public/nutrition/${token}`);
        const list = await call("cg-n", "GET", `${nu("fam-n", "eld-n")}/shares`);
        const mine = (list.data!.shares as Array<Record<string, unknown>>).find((s) => s.id === share.id)!;
        assert.equal(mine.opens, 2);
        assert.ok(mine.lastOpenedAt);
    });
    await ok("a co-caregiver revokes it; the page closes at once; a second revoke changes nothing", async () => {
        const token = String(share.url).split("/n/")[1];
        const r = await call("co-n", "DELETE", `${nu("fam-n", "eld-n")}/shares/${share.id}`);
        assert.deepEqual(r.data, { revoked: true });
        assert.equal((await call(null, "GET", `/api/public/nutrition/${token}`)).status, 404);
        assert.deepEqual((await call("cg-n", "DELETE", `${nu("fam-n", "eld-n")}/shares/${share.id}`)).data, { revoked: false });
        const list = await call("cg-n", "GET", `${nu("fam-n", "eld-n")}/shares`);
        const mine = (list.data!.shares as Array<Record<string, unknown>>).find((s) => s.id === share.id)!;
        assert.equal(mine.active, false);
        assert.ok(mine.revokedAt);
    });
    await ok("a link cannot be revoked through another person's page", async () => {
        const s = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 7 });
        assert.equal((await call("cg-n", "DELETE", `${nu("fam-n", "cg-n")}/shares/${s.data!.id}`)).status, 404);
        assert.equal((await call("cg-n", "DELETE", `${nu("fam-n", "eld-n")}/shares/nope`)).status, 400);
    });
    await ok("an expired link is closed; a made-up token is not found", async () => {
        const { default: ShareLink } = await import("../src/models/shareLink.model");
        const s = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 7 });
        await ShareLink.updateOne({ _id: s.data!.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        const token = String(s.data!.url).split("/n/")[1];
        assert.equal((await call(null, "GET", `/api/public/nutrition/${token}`)).status, 404);
        assert.equal((await call(null, "GET", "/api/public/nutrition/short")).status, 404);
        assert.equal((await call(null, "GET", `/api/public/nutrition/${"a".repeat(30)}`)).status, 404);
    });
    await ok("a link closes when the person leaves the family", async () => {
        const s = await call("cg-n", "POST", `${nu("fam-n", "eld-n")}/shares`, { days: 7 });
        const token = String(s.data!.url).split("/n/")[1];
        await Family.updateOne({ familyId: "fam-n", "members.userId": "eld-n" }, { $set: { "members.$.status": "REMOVED" } });
        assert.equal((await call(null, "GET", `/api/public/nutrition/${token}`)).status, 404);
        await Family.updateOne({ familyId: "fam-n", "members.userId": "eld-n" }, { $set: { "members.$.status": "JOINED" } });
    });

    // ── Saheli on WhatsApp (host tool nutrition_share_link) ──
    const { executeSaheliTool } = await import("../src/services/saheliTools.service");
    const tool = (actor: string, subject: string, days = 7) =>
        executeSaheliTool({ tool: "nutrition_share_link", args: { days }, familyId: "fam-n", recipientUserId: subject, actorUserId: actor });
    await ok("on WhatsApp a caregiver gets a link; the person cared for never does", async () => {
        flags.setFlagSnapshot({ "nutrition.page": true });
        const r = await tool("cg-n", "eld-n", 30);
        assert.match(String(r.url), /\/n\//);
        assert.equal(r.days, 30);
        const elder = await tool("eld-n", "eld-n");
        assert.equal(elder.url, null);
        assert.equal((await tool("view-n", "eld-n")).url, null);
        assert.equal((await tool("cg-n", "co-n")).url, null);
    });
    await ok("on WhatsApp no link is made while the page is off", async () => {
        flags.setFlagSnapshot({});
        const r = await tool("cg-n", "eld-n");
        assert.equal(r.url, null);
    });

    server.close();
    engine.close();
    // Writes a handler started without waiting (open counts, care events) finish before the client closes; closing under
    // them threw MongoClientClosedError as an unhandled rejection and failed the run about half the time.
    await new Promise((r) => setTimeout(r, 750));
    await mongoose.disconnect();
}

main()
    .then(() => console.log(`nutrition: ${passed} passed`))
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    })
    .finally(() => setTimeout(() => process.exit(), 200).unref());
