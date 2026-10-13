/**
 * Plan B1.4: every family GET route the dashboard can call, for world families (synthetic, 30 languages, every
 * household type and data shape), as four people: the primary caregiver, another caregiver, the care recipient and
 * the primary caregiver of ANOTHER family. The engine is a recorded one (scripts/fixtures/engine, one answer per route).
 *
 * Rules: no 500 for anyone; someone from another family never gets data (2xx); the family's own primary caregiver is
 * never refused (401/403).
 *
 *   TEST_MONGODB_URI=mongodb://127.0.0.1:27017/ci npx tsx scripts/test-world-api.ts
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { testDbUri } from "./test-db";

const FIXTURES = path.join(__dirname, "fixtures");
const FAMILIES = Number(process.env.WORLD_API_FAMILIES || 20);
// Params a route may have, and how to fill them from a family; a route with any other param is skipped.
const FILL: Record<string, (f: Fam) => string | undefined> = {
    familyId: (f) => f.familyId,
    recipientUserId: (f) => cared(f)?.id,
    elderId: (f) => cared(f)?.id,
    userId: (f) => cared(f)?.id,
    memberUserId: (f) => cared(f)?.id,
};

type Person = { id: string; email: string; backendRole: string; careRecipient: boolean; usesWhatsapp: boolean };
type Fam = { id: string; familyId: string; household: string; shapes: string[]; people: Person[] };
const cared = (f: Fam) => f.people.find((p) => p.backendRole === "CARE_RECIPIENT") || f.people.find((p) => p.careRecipient);

function fakeEngine(): Promise<http.Server> {
    const answers: Record<string, unknown> = {};
    for (const file of fs.readdirSync(path.join(FIXTURES, "engine"))) {
        answers[file.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(FIXTURES, "engine", file), "utf8"));
    }
    const server = http.createServer((req, res) => {
        const url = (req.url || "").split("?")[0];
        let m = url.match(/^\/v2\/dash\/[^/]+\/[^/]+\/([a-z-]+)$/);
        let key = m ? `dash.${m[1]}` : "";
        if (!m) {
            m = url.match(/^\/v2\/admin\/(?:families\/[^/]+\/)?([a-z-]+)$/);
            key = m ? `admin.${m[1]}` : "";
        }
        const body = key && req.method === "GET" ? answers[key] : undefined;
        res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? { detail: "not recorded" }));
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

type Layer = { route?: { path: string; methods: Record<string, boolean> }; name: string; handle: { stack?: Layer[] }; regexp: RegExp };

/** Every GET route of the app, with its full path (Express 4 router stack). */
function getRoutes(app: { _router: { stack: Layer[] } }): string[] {
    const out: string[] = [];
    const prefixOf = (re: RegExp) =>
        re.source.replace(/^\^/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/i, "").replace(/\(\?=\\\/\|\$\)$/, "").replace(/\\\//g, "/").replace(/\/\?$/, "");
    const walk = (stack: Layer[], prefix: string) => {
        for (const l of stack) {
            if (l.route && l.route.methods.get) out.push(prefix + l.route.path);
            else if (l.name === "router" && l.handle.stack) walk(l.handle.stack, prefix + prefixOf(l.regexp));
        }
    };
    walk(app._router.stack, "");
    // the dashboard's routes (internal ones use the service secret, not a person's session)
    return [...new Set(out)].filter((p) => p.includes(":familyId") && p.startsWith("/api/")).sort();
}

// A route whose async handler throws without passing the error on leaves the request hanging (Express 4 does not catch
// promise rejections) and, in production, only logs an unhandled rejection. Both are failures here.
const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => {
    unhandled.push(reason instanceof Error ? `${reason.message} @ ${(reason.stack || "").split("\n")[1]?.trim()}` : String(reason));
});

async function main() {
    const uri = testDbUri("worldapi");
    if (!uri) {
        console.log("world API checks skipped: set TEST_MONGODB_URI");
        return;
    }
    const engine = await fakeEngine();
    process.env.AI_ENGINE_URL = `http://127.0.0.1:${(engine.address() as AddressInfo).port}`;
    process.env.MONGODB_URI = uri;
    process.env.JWT_SECRET = process.env.JWT_SECRET || "world-api-test-secret";
    await mongoose.connect(uri);
    await mongoose.connection.db!.dropDatabase();
    const world = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, "world-ci.json.gz"))).toString()) as { families: Fam[] };
    const fams = world.families.slice(0, FAMILIES);
    const { seedWorld } = await import("./seed-world");
    await seedWorld(fams as never);
    const app = (await import("../src/app")).default as unknown as http.RequestListener & { _router: { stack: Layer[] } };
    const config = (await import("../src/config/app.config")).default;
    const Session = (await import("../src/models/session.model")).default;
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const tokens = new Map<string, string>();
    const tokenFor = async (p: Person) => {
        if (tokens.has(p.id)) return tokens.get(p.id)!;
        const sessionId = randomUUID();
        const token = jwt.sign({ userId: p.id, email: p.email, sessionId, authProvider: "EMAIL" }, config.jwt.secret, { expiresIn: "2h" });
        await Session.create({ sessionId, userId: p.id, tokenHash: Session.hashToken(token), fingerprint: "N/A", authProvider: "EMAIL",
                               expiresAt: new Date(Date.now() + 2 * 3600_000), lastActiveAt: new Date() });
        tokens.set(p.id, token);
        return token;
    };

    const routes = getRoutes(app);
    // any other param (a session, task or document id) gets an id that does not exist: a 404 is fine, a 500 or a hang is not
    const usable = routes;
    console.log(`${routes.length} family GET routes, ${usable.length} checked for ${fams.length} families x 4 people`);
    const problems: string[] = [];
    const tally: Record<string, Record<string, number>> = {};
    let calls = 0;
    for (const [i, f] of fams.entries()) {
        const primary = f.people.find((p) => p.backendRole === "PRIMARY_CAREGIVER");
        const co = f.people.find((p) => p.backendRole === "CO_CAREGIVER");
        const rec = f.people.find((p) => p.backendRole === "CARE_RECIPIENT");
        const other = fams[(i + 1) % fams.length].people.find((p) => p.backendRole === "PRIMARY_CAREGIVER");
        const who: Array<[string, Person | undefined]> = [["primary", primary], ["caregiver", co], ["recipient", rec], ["outsider", other]];
        for (const route of usable) {
            const url = route.replace(/:(\w+)/g, (_, k: string) => encodeURIComponent((FILL[k] ? FILL[k](f) : undefined) || "world-none"));
            for (const [role, p] of who) {
                if (!p) continue;
                const res = await fetch(base + url, { headers: { authorization: `Bearer ${await tokenFor(p)}` }, signal: AbortSignal.timeout(8000) })
                    .catch(() => null);
                calls++;
                const status = res ? res.status : 0;
                (tally[role] ||= {})[String(status)] = ((tally[role] ||= {})[String(status)] || 0) + 1;
                if (!res) problems.push(`${f.id} ${role} GET ${route}: no answer (the request hung)`);
                // 502/503: an outside service (a store's sign-in, Meta) is unavailable, said plainly; any other 5xx is our crash
                else if (status >= 500 && status !== 502 && status !== 503) problems.push(`${f.id} ${role} GET ${route}: ${status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
                else if (role === "outsider" && status < 300) problems.push(`${f.id} OUTSIDER got ${status} on ${route} (another family's data)`);
                else if (role === "primary" && (status === 401 || status === 403)) problems.push(`${f.id} primary caregiver refused (${status}) on ${route}`);
            }
        }
    }
    console.log(`${calls} calls; status by person: ${JSON.stringify(tally)}`);
    if (unhandled.length) {
        const kinds = [...new Set(unhandled)];
        problems.push(...kinds.map((k) => `unhandled rejection (x${unhandled.filter((u) => u === k).length}): ${k}`));
    }
    server.close();
    engine.close();
    await mongoose.disconnect();
    if (problems.length) {
        const byRoute: Record<string, number> = {};
        for (const p of problems) {
            const r = p.split(" ").find((x) => x.startsWith("/api")) || "?";
            byRoute[r] = (byRoute[r] || 0) + 1;
        }
        console.log(`${problems.length} problems on ${Object.keys(byRoute).length} routes:`);
        for (const p of problems.slice(0, 40)) console.log("  " + p);
        process.exit(1);
    }
    console.log("world API: every route held its rules");
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
