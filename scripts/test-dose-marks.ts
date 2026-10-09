/** Saheli marks the dose the person means: by title, at the dose time she names, and a correction re-marks a marked one. */
import { pickScheduleItem } from "../src/services/saheliCareAction.service";

let fail = 0;
const ok = (name: string, cond: boolean, got?: unknown) => {
    console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : ` → ${JSON.stringify(got)}`}`);
    if (!cond) fail++;
};

const items = [
    { scheduleId: "bp", title: "BP 1", time: "8:00 AM", status: "completed" },
    { scheduleId: "vit", title: "Vitamin D3 60,000 IU", time: "10:00 AM", status: "due" },
    { scheduleId: "met-am", title: "Metformin 500mg", time: "8:00 AM", status: "completed" },
    { scheduleId: "met-pm", title: "Metformin 500mg", time: "8:00 PM", status: "due" },
];
const notMissed = (i: { status: string }) => i.status !== "missed";
const notDone = (i: { status: string }) => i.status !== "completed";

ok("a correction finds the dose already marked taken", pickScheduleItem(items, "bp", undefined, notMissed)?.scheduleId === "bp");
ok("a key with underscores matches the title", pickScheduleItem(items, "vitamin_d3_60", undefined, notDone)?.scheduleId === "vit");
ok("the dose time picks the evening Metformin", pickScheduleItem(items, "Metformin", "20:00", notMissed)?.scheduleId === "met-pm");
ok("the dose time picks the morning Metformin even if marked", pickScheduleItem(items, "Metformin", "08:00", notMissed)?.scheduleId === "met-am");
ok("without a time an unmarked one comes first", pickScheduleItem(items, "Metformin", undefined, notDone)?.scheduleId === "met-pm");
ok("no match → nothing", pickScheduleItem(items, "Folvite", undefined, notDone) === undefined);

if (fail) {
    console.error(`${fail} failed`);
    process.exit(1);
}
