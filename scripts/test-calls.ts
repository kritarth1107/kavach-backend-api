/** Phone-call endpoints: the post-call webhook signature check (ElevenLabs-Signature HMAC). */
import crypto from "crypto";
import { validSignature, safeEqual } from "../src/routes/calls.routes";

let fail = 0;
const ok = (name: string, cond: boolean) => {
    console.log(`${cond ? "✓" : "✗"} ${name}`);
    if (!cond) fail++;
};
const secret = "whsec_test";
const raw = Buffer.from(JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "c1" } }));
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac("sha256", secret).update(`${t}.${raw.toString()}`).digest("hex");
ok("a valid signature passes", validSignature(`t=${t},v0=${sig}`, raw, secret));
ok("a wrong secret fails", !validSignature(`t=${t},v0=${sig}`, raw, "other"));
ok("a changed body fails", !validSignature(`t=${t},v0=${sig}`, Buffer.from("{}"), secret));
ok("an old signature fails", !validSignature(`t=${t - 4000},v0=${crypto.createHmac("sha256", secret).update(`${t - 4000}.${raw}`).digest("hex")}`, raw, secret));
ok("no header fails", !validSignature(undefined, raw, secret));
ok("constant-time compare", safeEqual("Bearer x", "Bearer x") && !safeEqual("Bearer x", "Bearer y"));
if (fail) process.exit(1);
