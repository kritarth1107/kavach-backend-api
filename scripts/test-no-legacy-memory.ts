/**
 * Drift guard for "one memory is the truth" (trust plan A1, step 5): fails the build when live code goes back to the
 * retired memory. Static, no DB:
 *  - the retired writers (the Mongo profile service, reflection, the daily snapshot, the old outreach / memory sync / v1
 *    chat services) and the dead models are gone, and nothing imports them;
 *  - the retired stores (ElderProfile, ElderUsuals, ElderWellbeingDay, DailySnapshot) are imported only by the read-only
 *    places allowed below, and no file writes them (create / update / delete / save);
 *  - nothing calls the engine's old brain or Instinct inbox (/v1/chat…, /v1/memory…), and the old memory tools stay refused.
 * `npm run test:no-legacy-memory`
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "src");
let fail = 0;
const check = (name: string, problems: string[]) => {
    if (problems.length) {
        fail++;
        console.log(`  ✗ ${name}\n${problems.map((p) => `      ${p}`).join("\n")}`);
    } else console.log(`  ✓ ${name}`);
};

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? files(p) : e.name.endsWith(".ts") ? [p] : [];
    });
}
const all = files(ROOT).map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, "utf8") }));

/** Modules that wrote the old memory, or served the v1 brain: they must not exist, and nothing may import them. */
const RETIRED_MODULES = [
    "services/profile/elderProfile.service",
    "services/profile/reflection.service",
    "services/profile/profileCore",
    "services/profile/factPolicy",
    "services/dailySnapshot.service",
    "controllers/elderProfile.controller",
    "controllers/usuals.controller",
    "services/saheliMemorySync.service",
    "services/saheliMemoryContext.service",
    "services/saheliOutreach.service",
    "services/saheliElderPipeline.service",
    "services/saheliSession.service",
    "workers/memoryConsolidationScheduler",
    "models/saheliSignal.model",
    "models/saheliGoal.model",
    "models/saheliGoalLog.model",
    "models/saheliFeedback.model",
];
const importsOf = (text: string) =>
    [...text.matchAll(/(?:from\s+|import\s*\(\s*)["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
const resolves = (from: string, spec: string) => path.normalize(path.join(path.dirname(from), spec)).replace(/\\/g, "/");

check("the retired writers and dead models are gone", RETIRED_MODULES.filter((m) => fs.existsSync(path.join(ROOT, `${m}.ts`))));
check(
    "nothing imports a retired writer",
    all.flatMap(({ file, text }) =>
        importsOf(text)
            .filter((s) => s.startsWith("."))
            .map((s) => resolves(file, s))
            .filter((r) => RETIRED_MODULES.includes(r))
            .map((r) => `${file} imports ${r}`),
    ),
);

/** The retired stores, and the only places allowed to import them (read only). */
const RETIRED_STORES: Record<string, string[]> = {
    "models/elderProfile.model": ["services/legacyMemory.service.ts", "admin/routes/support.ts"],
    "models/elderUsuals.model": [
        "services/legacyMemory.service.ts",
        // the old order flow's usuals, read only (it never orders for a family on Saheli v2)
        "services/commerceAutomation/usuals/usuals.service.ts",
        "services/commerceAutomation/usuals/usualsCore.ts",
        "services/whatsappRouting.service.ts",
    ],
    "models/elderWellbeingDay.model": [],
    "models/dailySnapshot.model": [],
};
check(
    "the retired stores are imported only by the read-only places allowed",
    all.flatMap(({ file, text }) =>
        importsOf(text)
            .filter((s) => s.startsWith("."))
            .map((s) => resolves(file, s))
            .filter((r) => r in RETIRED_STORES && !RETIRED_STORES[r]!.includes(file))
            .map((r) => `${file} imports ${r}`),
    ),
);

const STORE_NAMES = ["ElderProfile", "ElderUsuals", "ElderWellbeingDay", "DailySnapshot"];
const WRITE = /\.(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|bulkWrite|deleteOne|deleteMany|findOneAndDelete)\s*\(/;
check(
    "no file writes a retired store",
    all.flatMap(({ file, text }) => {
        const out: string[] = [];
        for (const name of STORE_NAMES) {
            const viaModel = new RegExp(`\\b${name}\\s*${WRITE.source}`);
            if (viaModel.test(text)) out.push(`${file}: ${name}.<write>(…)`);
            if (new RegExp(`new\\s+${name}\\s*\\(`).test(text)) out.push(`${file}: new ${name}(…)`);
        }
        const imported = importsOf(text).some((s) => s.startsWith(".") && resolves(file, s) in RETIRED_STORES);
        if (imported && /\.save\s*\(/.test(text) && /ElderProfile|ElderUsuals|ElderWellbeingDay|DailySnapshot/.test(text)) {
            // a document of a retired store saved back (load + mutate + save)
            if (!["services/commerceAutomation/usuals/usualsCore.ts"].includes(file)) out.push(`${file}: .save() in a file that loads a retired store`);
        }
        for (const coll of ["elderprofiles", "elderusuals", "elderwellbeingdays", "dailysnapshots"]) {
            const raw = new RegExp(`collection\\(\\s*["'\`]${coll}["'\`]\\s*\\)\\s*${WRITE.source}`);
            if (raw.test(text)) out.push(`${file}: raw write to ${coll}`);
        }
        return out;
    }),
);

check(
    "nothing calls the old brain, its Instinct inbox or its tenant and document routes (/v1/chat, /v1/memory, /v1/families, /v1/documents, /v1/care-brief)",
    all.filter(({ text }) => /\/v1\/(chat|memory|families|documents|care-brief)\b/.test(text)).map(({ file }) => file),
);

const tools = all.find((f) => f.file === "services/saheliTools.service.ts")!.text;
check(
    "the old memory tools are refused, never run",
    [
        ...(/RETIRED_MEMORY_TOOLS[^\n]*"save_memory"[^\n]*"recall_memories"/.test(tools) ? [] : ["save_memory / recall_memories are not in RETIRED_MEMORY_TOOLS"]),
        ...(/case\s+"(save_memory|recall_memories)"/.test(tools) ? ["a case still runs save_memory or recall_memories"] : []),
    ],
);

const routing = all.find((f) => f.file === "services/whatsappRouting.service.ts")!.text;
check(
    "the WhatsApp path never falls back to the old brain and writes no profile",
    [
        ...(/whatsAppMockAdapter|sendSaheliMessage|sendCaregiverSaheliMessage/.test(routing) ? ["whatsappRouting still reaches the v1 chat"] : []),
        ...(/captureStatedPreference|noteBrandPreference|rememberDoNotCallMaa|raiseUnusual\(w, scam\)|detectScamCue|detectConfusionCue/.test(routing)
            ? ["whatsappRouting still runs the old profile writes"]
            : []),
        ...(/holdTurn/.test(routing) ? [] : ["whatsappRouting does not hold a turn the brain could not answer"]),
    ],
);

console.log(fail ? `\n${fail} drift check(s) failed` : "\nall drift checks passed");
process.exit(fail ? 1 : 0);
