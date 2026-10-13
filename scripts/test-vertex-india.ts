/**
 * People's data stays in India (founder D5, 13 Oct 2026): every Gemini call that carries a person's words, photos, voice
 * or records runs in Mumbai (asia-south1) on the model served there, never at "global". VERTEX_INDIA_ONLY=off restores
 * the old routing. Pure checks, no network.
 * Usage: npx tsx scripts/test-vertex-india.ts
 */
import assert from "node:assert/strict";

let passed = 0;
const ok = (name: string, fn: () => void) => {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.stack || err.message : err}`);
        process.exitCode = 1;
    }
};

async function main() {
    delete process.env.VERTEX_INDIA_ONLY;
    delete process.env.VERTEX_INDIA_MODEL;
    process.env.GCP_REGION = "asia-south1";
    const V = await import("../src/clients/vertexGemini.client");
    ok("by default every people's-data call goes to Mumbai on the model served there", () => {
        assert.deepEqual(V.personalRoute(V.GEMINI_PRO_MODEL), { model: "gemini-3.5-flash", location: "asia-south1" });
        assert.deepEqual(V.personalRoute(V.preferPro(process.env.VERTEX_STT_MODEL)), { model: "gemini-3.5-flash", location: "asia-south1" });
    });
    ok("never global while India-only is on", () => {
        for (const m of ["gemini-3.1-pro-preview", "gemini-3.6-flash", "gemini-2.5-pro", ""]) assert.notEqual(V.personalRoute(m).location, "global");
    });
    ok("VERTEX_INDIA_MODEL picks another Mumbai model", () => {
        process.env.VERTEX_INDIA_MODEL = "gemini-3.5-flash-lite";
        assert.equal(V.personalRoute("x").model, "gemini-3.5-flash-lite");
        delete process.env.VERTEX_INDIA_MODEL;
    });
    ok("VERTEX_INDIA_ONLY=off brings back the old Pro-at-global routing", () => {
        process.env.VERTEX_INDIA_ONLY = "off";
        assert.deepEqual(V.personalRoute(V.GEMINI_PRO_MODEL), { model: V.GEMINI_PRO_MODEL, location: "global" });
        delete process.env.VERTEX_INDIA_ONLY;
    });
    console.log(`vertex india: ${passed} passed`);
}

main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
