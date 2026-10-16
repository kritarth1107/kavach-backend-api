/** Every quote shape the brain is told about. A media quote stays with the photo path (null here). */
import { quoteNote } from "../src/services/quoteNote";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const dinner = "Enjoy your dinner. I will ask in an hour what you had.";
ok("her message", quoteNote({ theirs: false, text: dinner }) === `They are replying to your message: ${dinner}`);
ok("their message", quoteNote({ theirs: true, text: "theek hai" }) === "They are replying to their earlier message: theek hai");
ok("hers with no text kept", quoteNote({ theirs: false }) === "They are replying to one of your earlier messages.");
ok("theirs with no text kept", (quoteNote({ theirs: true }) || "").includes("do not guess"));
ok("a photo is not this line", quoteNote({ theirs: true, mediaId: "m1", text: "cap" }) === null);
ok("whitespace collapsed", quoteNote({ theirs: false, text: "  dinner\n\n  soon  " }) === "They are replying to your message: dinner soon");

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("quote notes ok");
