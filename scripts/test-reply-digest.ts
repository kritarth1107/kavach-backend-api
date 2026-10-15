/** The daily line that replaces mail for a small Gemini blip. No AWS calls. */
import assert from "node:assert/strict";
import { digestLine } from "../src/admin/infra/aws";

const line = digestLine({ calls: 11, throttles: 2, brainP90Ms: 24600, replyP50Ms: 15600, replyP90Ms: 39000, turns: 9, singapore: 4 });
assert.match(line, /11 calls, 2 throttles/);
assert.match(line, /24\.6 s/);
assert.match(line, /15\.6 s/);
assert.match(line, /39\.0 s/);
assert.match(line, /9 turns/);
assert.match(line, /not mailed/);
assert.match(line, /4 calls went to Singapore today/);
const empty = digestLine({ calls: 0, throttles: 0, brainP90Ms: null, replyP50Ms: null, replyP90Ms: null, turns: 0, singapore: 0 });
assert.match(empty, /no samples/);
assert.match(empty, /0 calls went to Singapore today/);
console.log("ok");
