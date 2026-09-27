/** Ola "page changed" recovery: mocked screen variants, safety gates, booking gate. No network. */
import {
    __setOlaScreenClassifierForTests,
    bookGate,
    classifyByRules,
    parseModelVerdict,
    recoverTo,
    refuseAction,
    type RecoveryLogEntry,
    type ScreenClassifier,
    type ScreenSnapshot,
} from "../src/services/rideBooking/ola/olaRecovery";
import { FakeOlaDriver, FakeOlaScreens } from "../src/services/rideBooking/ola/olaDriver";

let fail = 0;
const ok = (n: string, c: boolean, got?: unknown) => { console.log(`${c ? "✓" : "✗"} ${n}${c ? "" : ` → ${JSON.stringify(got)}`}`); if (!c) fail++; };
const snap = (lines: string[], buttons: string[], extra: Partial<ScreenSnapshot> = {}): ScreenSnapshot => ({ url: "https://book.olacabs.com/", lines, buttons, ...extra });

// A model that behaves like Gemini on these mocks (and one that misbehaves).
const goodModel: ScreenClassifier = async (s) => {
    if (s.buttons.includes("Proceed")) return { screen: "continue", action: { type: "click", target: "Proceed" }, source: "model", reason: "renamed continue" };
    if (s.lines.includes("Welcome back")) return { screen: "unexpected", action: { type: "reopen" }, source: "model" };
    return null;
};
const evilModel: ScreenClassifier = async (s) => ({ screen: "continue", action: { type: "click", target: s.buttons.find((b) => /book|next|install/i.test(b)) || "Confirm & Book" }, source: "model" });

async function run(start: string, signedIn: boolean, goal: "chosen" | "ride_list" | "confirm", model: ScreenClassifier | null, type = "Mini") {
    const pg = new FakeOlaScreens(start, () => signedIn, () => type);
    const logs: RecoveryLogEntry[] = [];
    const out = await recoverTo(pg, goal, type, { classifier: model, log: (e) => logs.push(e), maxSteps: 6, maxMs: 5000 });
    return { out, logs, pg };
}

(async () => {
    // Rules recognise known screens without the model.
    ok("rules: popup → dismiss 'Not now'", JSON.stringify(classifyByRules(snap(["Get the Ola app"], ["Install app", "Not now"]))?.action) === JSON.stringify({ type: "dismiss", target: "Not now" }));
    ok("rules: confirm screen", classifyByRules(snap(["FARE", "₹312", "Confirm & Book"], ["Confirm & Book"]))?.screen === "confirm");
    ok("rules: captcha", classifyByRules(snap(["Please verify you are human"], []))?.screen === "captcha");
    ok("rules: captcha frame", classifyByRules(snap(["x"], [], { captcha: true }))?.screen === "captcha");
    ok("rules: live ride", classifyByRules(snap(["Finding a ride for you. Please wait"], []))?.screen === "searching");
    ok("rules: phone box", classifyByRules(snap(["Enter your mobile number"], ["Next"], { authPhone: true }))?.screen === "phone_box");
    ok("rules: unknown → null (ask model)", classifyByRules(snap(["Welcome back"], ["Home"])) === null);

    // Mocked variants reach the goal.
    let r = await run("popup", false, "chosen", null);
    ok("extra popup: dismissed, ride re-selected, reaches sign-in box", r.out.ok && r.out.screen === "phone_box" && r.pg.clicks.join("|") === "Not now|Mini|Continue", { out: r.out, clicks: r.pg.clicks });
    r = await run("banner", true, "chosen", null);
    ok("festive banner (signed in): reaches Confirm & Book screen", r.out.ok && r.out.screen === "confirm", r);
    r = await run("reordered", true, "chosen", null);
    ok("reordered list: picks HER type (Mini) by label, not position", r.out.ok && r.pg.clicks[0] === "Mini", r.pg.clicks);
    r = await run("cont_renamed", false, "chosen", goodModel);
    ok("renamed button: model finds 'Proceed', reaches sign-in box", r.out.ok && r.out.screen === "phone_box" && r.pg.clicks.includes("Proceed") && r.logs.some((l) => l.source === "model"), r);
    r = await run("cont_renamed", false, "chosen", null);
    ok("renamed button, model down: reopens and still reaches sign-in", r.out.ok && r.out.screen === "phone_box", r);
    r = await run("unknown", false, "ride_list", goodModel);
    ok("unknown screen: reopen → ride list", r.out.ok && r.out.screen === "ride_list", r);
    r = await run("list", false, "ride_list", null);
    ok("already there: no clicks", r.out.ok && r.pg.clicks.length === 0, r.pg.clicks);

    // Stops (never touches): captcha, live ride, OTP box.
    r = await run("captcha", false, "chosen", evilModel);
    ok("captcha: stops, clicks nothing", !r.out.ok && r.out.why === "captcha" && r.pg.clicks.length === 0, r);
    r = await run("phone", false, "confirm", evilModel);
    ok("wants fare but sign-in box: stops (sign-in needs her confirm)", !r.out.ok && r.out.why === "needs_sign_in" && r.pg.clicks.length === 0, r);

    // Misbehaving model: every dangerous suggestion refused by code.
    r = await run("cont_renamed", false, "chosen", evilModel);
    ok("evil model: never clicks book/next/install", !r.pg.clicks.some((c) => /book|next|install/i.test(c)), r.pg.clicks);
    ok("evil model: refusals logged", r.logs.some((l) => !l.allowed && l.refused), r.logs);
    const ctx = { goal: "chosen" as const, rideType: "Mini" };
    const conf = snap(["Confirm & Book"], ["Confirm & Book", "Cash", "Continue", "Prime SUV", "Proceed", "Not now", "Next"]);
    ok("gate: Confirm & Book refused", refuseAction({ type: "click", target: "Confirm & Book" }, conf, ctx) !== null);
    ok("gate: payment 'Cash' refused (code selects Cash, not the model)", refuseAction({ type: "click", target: "Cash" }, conf, ctx) !== null);
    ok("gate: another ride type refused", refuseAction({ type: "select_ride", target: "Prime SUV" }, conf, ctx) === "not_the_chosen_ride");
    ok("gate: other type via click refused", refuseAction({ type: "click", target: "Prime SUV" }, conf, ctx) === "other_ride_type");
    ok("gate: invisible target refused", refuseAction({ type: "click", target: "Skip" }, conf, ctx) === "target_not_visible");
    ok("gate: 'Next' (sends SMS) refused", refuseAction({ type: "click", target: "Next" }, conf, ctx) !== null);
    ok("gate: dismiss must be a close button", refuseAction({ type: "dismiss", target: "Continue" }, conf, ctx) === "not_a_close_button");
    ok("gate: sign-in box open → only dismiss", refuseAction({ type: "click", target: "Continue" }, { ...conf, authPhone: true }, ctx) === "sign_in_box_open");
    ok("gate: captcha on screen → nothing but stop", refuseAction({ type: "dismiss", target: "Not now" }, { ...conf, captcha: true }, ctx) === "captcha_on_screen");
    ok("gate: renamed continue allowed", refuseAction({ type: "click", target: "Proceed" }, conf, ctx) === null);
    ok("model parse: junk screen rejected", parseModelVerdict({ screen: "book_now", action: { type: "click" } }) === null);
    ok("model parse: unknown action dropped", parseModelVerdict({ screen: "popup", action: { type: "pay" } })?.action === undefined);

    // Budget: a page that never changes.
    const stuck = { snapshot: async () => snap(["Welcome back"], ["Home"]), clickLabel: async () => true, back: async () => undefined, reopen: async () => undefined, wait: async () => undefined };
    const so = await recoverTo(stuck, "ride_list", "Mini", { classifier: async () => ({ screen: "unexpected", action: { type: "wait" }, source: "model" }), maxSteps: 6, maxMs: 3000 });
    ok("never-changing page: gives up within budget", !so.ok && (so.why === "stuck" || so.why === "budget") && so.steps <= 6, so);

    // Booking gate: second confirm + Cash read-back + same fare/pickup/type.
    const shown = { vehicle: "Mini", fare: 312, pickup: "Rajiv Chowk Gate No.6", drop: "T3", pay: "Cash" };
    ok("book gate: same → ok", bookGate(shown, { ...shown }, true).ok);
    ok("book gate: lower fare → ok", bookGate(shown, { ...shown, fare: 300 }, true).ok);
    const up = bookGate(shown, { ...shown, fare: 352 }, true);
    ok("book gate: fare up → re-ask", !up.ok && up.reask && up.why === "fare_up", up);
    const ty = bookGate(shown, { ...shown, vehicle: "Prime SUV" }, true);
    ok("book gate: type changed → re-ask", !ty.ok && ty.reask && ty.why === "type_changed", ty);
    const pk = bookGate(shown, { ...shown, pickup: "Palika Bazaar Gate 2" }, true);
    ok("book gate: pickup moved → re-ask", !pk.ok && pk.reask && pk.why === "pickup_changed", pk);
    const nc = bookGate(shown, { ...shown }, false);
    ok("book gate: Cash not read back → stop", !nc.ok && !nc.reask && nc.why === "not_cash", nc);
    ok("book gate: nothing confirmed → stop", !bookGate(undefined, { ...shown }, true).ok);
    ok("book gate: no page fare → stop", !bookGate(shown, { ...shown, fare: undefined }, true).ok);
    ok("book gate: confirmed card not Cash → stop", !bookGate({ ...shown, pay: "UPI" }, { ...shown }, true).ok);

    // Fake driver scenarios used by the chat tests: choose fails once, recovery finds the way.
    __setOlaScreenClassifierForTests(goodModel);
    for (const [sc, want] of [["popup_once", "login"], ["banner_in", "confirm"], ["renamed_button", "login"], ["reordered_in", "confirm"]] as const) {
        const d = new FakeOlaDriver(sc, 1);
        const first = await d.choose("Mini");
        const out = await d.recover!("chosen", "Mini", () => undefined);
        const got = out.ok ? (out.screen === "confirm" ? "confirm" : "login") : out.why;
        ok(`fake ${sc}: choose fails once, recovery → ${want}`, first === "failed" && got === want, { first, out });
        if (want === "confirm") ok(`fake ${sc}: fare readable after recovery`, (await d.readConfirm("Mini"))?.fare === 312);
    }
    const cd = new FakeOlaDriver("captcha", 1);
    await cd.choose("Mini");
    ok("fake captcha: stops", (await cd.recover!("chosen", "Mini", () => undefined)).ok === false);
    const fu = new FakeOlaDriver("fare_up_in", 1);
    await fu.choose("Mini");
    const r1 = await fu.readConfirm("Mini"), r2 = await fu.readConfirm("Mini");
    ok("fake fare_up: fare rises before the tap", r1?.fare === 312 && r2?.fare === 352, [r1, r2]);
    __setOlaScreenClassifierForTests(undefined);

    console.log(fail ? `\n${fail} FAILED` : "\nall ok");
    process.exit(fail ? 1 : 0);
})();
