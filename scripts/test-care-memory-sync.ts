/** Care-memory → CareSchedule bridge: dose times are normalized before rows are written. */
import { normalizeTimes } from "../src/services/careMemorySync.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const t = normalizeTimes(["8:00", "21:00", "08:00", "25:00", "night", 7]);
ok("pads, dedupes, sorts, drops bad times", JSON.stringify(t) === JSON.stringify(["08:00", "21:00"]), t);
ok("non-array gives no times", normalizeTimes("08:00").length === 0);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
console.log("all passed");
