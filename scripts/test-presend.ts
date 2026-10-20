/** Every scheduled message asks the engine first; an engine that cannot be reached lets it go. No Mongo. */
import assert from "node:assert/strict";

(async () => {
    process.env.AI_ENGINE_URL = "http://127.0.0.1:9"; // nothing listens: the check fails open
    const { stillRight } = await import("../src/services/presendCheck.service");
    assert.deepEqual(await stillRight("fam", "p", "Gym at 20:00"), { send: true, why: "" });
    process.env.PRESEND_CHECK = "off";
    assert.deepEqual(await stillRight("fam", "p", "Gym at 20:00"), { send: true, why: "" });
    console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });
