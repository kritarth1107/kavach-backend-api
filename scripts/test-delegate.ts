/**
 * Saheli-as-delegate tests. Offline: timing, flow snapshot, permissions, why tokens.
 * With DELEGATE_LIVE=1 (Vertex ADC): Gemini interpretation of follow-up answers / resume / approvals,
 * order-context + WHY extraction, new-info connection. `npm run test:delegate`
 */
import { followupDueAt } from "../src/services/delegate/followup.service";
import { snapshotSession, taskTitle, phaseWords } from "../src/services/delegate/tasks.service";
import { whyToken, textMentions } from "../src/services/delegate/why.service";
import { allowedAlternative, categoryAllowed, describePermissions, paiseFromLabel, pendingOrderTotal, storeAllowed, type Permissions } from "../src/services/delegate/permissions.service";

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) fail++;
    console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const ist = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

// ── Follow-up timing ─────────────────────────────────────────────────────────────────────────
const placed = new Date("2026-09-27T20:10:00+05:30");
eq("instamart → +75 min", ist(followupDueAt(placed, { partner: "instamart", category: "grocery" })), ist(new Date(placed.getTime() + 75 * 60_000)));
eq("swiggy → +90 min", ist(followupDueAt(placed, { partner: "swiggy", category: "food" })), ist(new Date(placed.getTime() + 90 * 60_000)));
eq("apollo evening → next day 11:00", ist(followupDueAt(placed, { partner: "apollo", category: "pharmacy" })), "28, 11:00");
eq("apollo 6 AM → same day 18:00", ist(followupDueAt(new Date("2026-09-27T06:00:00+05:30"), { partner: "apollo", category: "pharmacy" })), "27, 18:00");
eq("stated ETA 25 min → +70 min", ist(followupDueAt(placed, { partner: "zepto", etaMinutes: 25 })), ist(new Date(placed.getTime() + 70 * 60_000)));

// ── Flow snapshot (durable open task source) ─────────────────────────────────────────────────
eq("browser draft", snapshotSession({ browserTaskDraft: { phase: "awaiting_sku_confirm", partner: "apollo", productQuery: "Dolo 650", category: "pharmacy" } })?.productQuery, "Dolo 650");
eq("idle draft → none", snapshotSession({ browserTaskDraft: { phase: "done", productQuery: "x" } }), null);
eq("pharmacy draft", snapshotSession({ pharmacyDraft: { phase: "awaiting_confirm", partner: "apollo", searchQuery: "telma 40", items: [{ name: "Telma 40 Tablet" }] } })?.item, "Telma 40 Tablet");
eq("ride draft", snapshotSession({ rideDraft: { phase: "need_drop", pickup: { shortLabel: "Home" } } })?.rideFrom, "Home");
eq("offer (same family)", snapshotSession({ pendingOffer: { query: "dolo 650", partner: "pharmeasy", familyId: "f1", at: new Date() } }, "f1")?.flow, "offer");
eq("offer (other family) → none", snapshotSession({ pendingOffer: { query: "dolo", familyId: "f2", at: new Date() } }, "f1"), null);
eq("title", taskTitle({ kind: "open_task", item: "Dolo 650", partner: "apollo", category: "pharmacy" } as never), "Order Dolo 650 (Apollo)");
eq("ride title", taskTitle({ kind: "open_task", category: "ride", rideFrom: "Home", rideTo: "Clinic" } as never), "Ride from Home to Clinic");
eq("phase words", phaseWords("awaiting_confirm"), "confirm card was shown, waiting for *confirm*");

// ── Why tokens ───────────────────────────────────────────────────────────────────────────────
eq("why token", whyToken("Telma 40 Tablets"), "telma");
eq("why token generic first", whyToken("Tablet Dolo 650"), "dolo");
eq("mention", textMentions("doctor ne telma band kar di", "Telma 40 Tablets"), true);
eq("no mention", textMentions("aaj mausam accha hai", "Telma 40 Tablets"), false);

// ── Permissions ──────────────────────────────────────────────────────────────────────────────
const P: Permissions = {
    familyId: "f",
    groceries: true,
    food: false,
    medicines: true,
    rides: true,
    stores: { instamart: true, zepto: false, blinkit: true, swiggy: true, zomato: true, apollo: true, pharmeasy: true, tata_1mg: true, uber: true },
    spendSoftLimitInr: 1500,
    deliveryFollowUps: true,
    medicineStartCheck: true,
    resumeNudges: true,
    history: [],
};
eq("food off", categoryAllowed(P, "food"), false);
eq("pharmacy on", categoryAllowed(P, "pharmacy"), true);
eq("zepto off", storeAllowed(P, "zepto"), false);
eq("unknown store left to the hard allowlist", storeAllowed(P, "amazon"), true);
eq("zepto → instamart", allowedAlternative(P, "zepto"), "instamart");
eq("rupees label", paiseFromLabel("₹1,234.50"), 123450);
eq("pending total (mcp card)", pendingOrderTotal({ browserTaskDraft: { phase: "awaiting_mcp_confirm", mcpCard: { totalPaise: 250000, itemLine: "Ensure 1kg" }, partner: "instamart" } })?.paise, 250000);
eq("pending total (label)", pendingOrderTotal({ browserTaskDraft: { phase: "awaiting_confirm", confirm: { totalLabel: "₹1,899" }, selectedSku: { name: "BP monitor", partner: "apollo" } } })?.paise, 189900);
eq("no pending", pendingOrderTotal({ browserTaskDraft: { phase: "running" } }), null);
eq("describe asks", describePermissions(P).asks.some((l) => /1,500/.test(l)), true);

(async () => {
    if (process.env.DELEGATE_LIVE === "1") {
        const G = await import("../src/services/delegate/delegateGemini");
        const base = { role: "elder" as const, recentChat: "", now: "Mon 28 Sep, 11:10 am", approvals: [] as string[] };
        const fu = ["[f1] asked today 11:00 am: \"Amma, Telma aa gayi? 🙂\" — item: Telma 40; stage=delivery; medicine=yes; WHY: ran out of BP medicine; doctor said continue"];
        const cases: Array<[string, Parameters<typeof G.interpretDelegateTurn>[0], (d: Awaited<ReturnType<typeof G.interpretDelegateTurn>>) => boolean]> = [
            ["arrived", { ...base, message: "haan beta aa gayi", followups: fu, openTasks: [] }, (d) => d?.target === "followup" && d.outcome === "arrived"],
            ["not arrived", { ...base, message: "abhi tak nahi aayi", followups: fu, openTasks: [] }, (d) => d?.target === "followup" && d.outcome === "not_arrived"],
            ["wrong item", { ...base, message: "galat dawai bhej di, Telma 80 aa gayi", followups: fu, openTasks: [] }, (d) => d?.target === "followup" && d.outcome === "wrong_item"],
            ["unrelated", { ...base, message: "aaj ghutne mein dard hai", followups: fu, openTasks: [] }, (d) => d?.target === "none"],
            ["new order", { ...base, message: "doodh mangwa do", followups: [], openTasks: ["[t1] Order Dolo 650 (Apollo) — left yesterday 7:40 pm; where it stopped: options were shown; offered=no"] }, (d) => d?.target === "none"],
            ["greeting → offer", { ...base, message: "hi", followups: [], openTasks: ["[t1] Order Dolo 650 (Apollo) — left yesterday 7:40 pm; where it stopped: options were shown; offered=no"] }, (d) => d?.target === "resume" && d.resumeAction === "offer" && /dolo/i.test(d.reply || "")],
            ["haan wo kar do", { ...base, message: "haan wo kar do", followups: [], openTasks: ["[t1] Order Dolo 650 (Apollo) — left yesterday 7:40 pm; where it stopped: options were shown; offered=yes (today 9:00 am)"] }, (d) => d?.target === "resume" && d.resumeAction === "resume"],
            ["rehne do", { ...base, message: "nahi rehne do, beta le aaya", followups: [], openTasks: ["[t1] Order Dolo 650 (Apollo) — left yesterday; offered=yes"] }, (d) => d?.target === "resume" && d.resumeAction === "decline"],
            ["caregiver approve", { ...base, role: "caregiver", message: "haan theek hai mangwa do", followups: [], openTasks: [], approvals: ["[a1] Ensure 1kg on instamart — Ensure for ₹2,300 — above the ₹2,000 limit"] }, (d) => d?.target === "approval" && d.approvalDecision === "approve"],
        ];
        for (const [name, input, ok] of cases) {
            const d = await G.interpretDelegateTurn(input);
            const pass = ok(d);
            if (!pass) fail++;
            console.log(`${pass ? "✓" : "✗"} live: ${name} → ${JSON.stringify({ t: d?.target, o: d?.outcome, r: d?.resumeAction, a: d?.approvalDecision, reply: d?.reply })}`);
        }
        const ctx = await G.extractOrderContext({ orderLog: "Apollo: order placed ₹180 COD\nTelma 40 Tablet 15's → Home", recentChat: "User: meri BP ki dawai khatam ho gayi, doctor ne kaha hai continue karna hai\nSaheli: Telma 40 mangwa doon?\nUser: haan confirm" });
        const okc = Boolean(ctx?.isMedicine && /bp|blood pressure/i.test(ctx?.why || ""));
        if (!okc) fail++;
        console.log(`${okc ? "✓" : "✗"} live: order context → ${JSON.stringify(ctx)}`);
        const wc = await G.connectWhy({ message: "doctor ne Telma band kar di, ab nayi dawai di hai", role: "elder", whys: [{ id: "w1", subject: "Telma 40", reason: "BP medicine; doctor said continue", status: "active" }], recentChat: "" });
        const okw = wc?.change === "stopped" && wc.whyId === "w1";
        if (!okw) fail++;
        console.log(`${okw ? "✓" : "✗"} live: why stopped → ${JSON.stringify(wc)}`);
    }
    console.log(fail ? `\n${fail} failed` : "\nall passed");
    process.exit(fail ? 1 : 0);
})();
