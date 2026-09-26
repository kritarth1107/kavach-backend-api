/** Stall detection (no fixed step/time caps). Run: npx tsx scripts/test-stall-detector.ts */
import assert from "node:assert/strict";
import { StallDetector, actionSignature, stallConfigFromEnv, hashOf } from "../src/services/commerceAutomation/agentLayer/stallDetector";
import { dishFromGoal, pickDishName, isSwiggyRestaurantUrl } from "../src/services/commerceAutomation/swiggyRestaurantAdd";
import { shouldForwardProgressToWhatsApp, claimStillWorkingNotice, stillWorkingDelayMs } from "../src/services/commerceAutomation/browserProgressNotify.service";

let pass = 0;
const t = (name: string, fn: () => void) => {
    fn();
    pass++;
    console.log(`ok - ${name}`);
};
const clock = () => {
    let now = 1_000_000;
    return { now: () => now, tick: (ms: number) => (now += ms) };
};
const U = "https://www.swiggy.com/city/raipur/theobroma-shankar-nagar-rest916131";

t("defaults: repeat 6, no-progress 4 min, runaway 20 min / 200 steps", () => {
    const c = stallConfigFromEnv({} as NodeJS.ProcessEnv);
    assert.deepEqual(c, { repeatLimit: 6, noProgressMs: 240_000, runawayMs: 1_200_000, runawaySteps: 200 });
});

t("env overrides are honoured and clamped", () => {
    const c = stallConfigFromEnv({ BROWSER_STALL_REPEAT: "8", BROWSER_RUNAWAY_MS: "1800000", BROWSER_RUNAWAY_STEPS: "1", BROWSER_NO_PROGRESS_MS: "abc" } as NodeJS.ProcessEnv);
    assert.equal(c.repeatLimit, 8);
    assert.equal(c.runawayMs, 1_800_000);
    assert.equal(c.runawaySteps, 10); // clamped to min
    assert.equal(c.noProgressMs, 240_000);
});

t("same action on unchanged page 6x in a row → stalled (not before)", () => {
    const k = clock();
    const d = new StallDetector({}, k.now);
    for (let i = 1; i <= 5; i++) {
        k.tick(5000);
        assert.equal(d.observe({ url: U, domHash: "A", shotHash: "S", actionSig: "click:ADD" }).stop, false, `step ${i}`);
    }
    k.tick(5000);
    const v = d.observe({ url: U, domHash: "A", shotHash: "S", actionSig: "click:ADD" });
    assert.equal(v.stop, true);
    assert.equal(v.stop && v.reason, "stalled");
});

t("page change resets the repeat counter", () => {
    const k = clock();
    const d = new StallDetector({}, k.now);
    for (let i = 0; i < 5; i++) d.observe({ url: U, domHash: "A", actionSig: "scroll" });
    assert.equal(d.observe({ url: U, domHash: "B", actionSig: "scroll" }).stop, false);
    assert.equal(d.repeatCount, 1);
    for (let i = 0; i < 4; i++) assert.equal(d.observe({ url: U, domHash: "B", actionSig: "scroll" }).stop, false);
});

t("different actions on the same page are not a stall", () => {
    const d = new StallDetector({}, clock().now);
    const acts = ["scroll", "click:a", "type:x", "scroll", "click:b", "wait", "scroll", "click:c"];
    for (const a of acts) assert.equal(d.observe({ url: U, domHash: "A", actionSig: a }).stop, false);
});

t("same screenshot hash counts as unchanged even if DOM text flickers", () => {
    const d = new StallDetector({}, clock().now);
    let v: ReturnType<StallDetector["observe"]> = { stop: false };
    for (let i = 0; i < 6; i++) v = d.observe({ url: U, domHash: `dom${i}`, shotHash: "SAME", actionSig: "click:x" });
    assert.equal(v.stop && v.reason, "stalled");
});

t("long but progressing run (150 steps, new pages, 15 min) never stops", () => {
    const k = clock();
    const d = new StallDetector({}, k.now);
    for (let i = 0; i < 150; i++) {
        k.tick(6000);
        const v = d.observe({ url: `${U}?p=${i}`, domHash: `d${i}`, actionSig: "click:next" });
        assert.equal(v.stop, false, `step ${i}`);
    }
});

t("ping-pong between known pages with no new state for 4 min → no_progress", () => {
    const k = clock();
    const d = new StallDetector({}, k.now);
    d.observe({ url: U, domHash: "A", actionSig: "go:b" });
    d.observe({ url: `${U}/b`, domHash: "B", actionSig: "go:a" });
    let v: ReturnType<StallDetector["observe"]> = { stop: false };
    for (let i = 0; i < 60 && !v.stop; i++) {
        k.tick(5000);
        v = d.observe(i % 2 ? { url: `${U}/b`, domHash: "B", actionSig: "go:a" } : { url: U, domHash: "A", actionSig: "go:b" });
    }
    assert.equal(v.stop && v.reason, "no_progress");
});

t("markProgress() (scripted step succeeded) resets the no-progress timer", () => {
    const k = clock();
    const d = new StallDetector({}, k.now);
    k.tick(230_000);
    d.markProgress();
    k.tick(200_000);
    assert.equal(d.checkTime().stop, false);
    k.tick(50_000);
    assert.equal(d.checkTime().stop, true);
});

t("runaway step ceiling", () => {
    const d = new StallDetector({ runawaySteps: 20 }, clock().now);
    let v: ReturnType<StallDetector["observe"]> = { stop: false };
    for (let i = 0; i < 21; i++) v = d.observe({ url: `${U}?${i}`, domHash: String(i), actionSig: String(i) });
    assert.equal(v.stop && v.reason, "runaway_steps");
});

t("runaway time ceiling even while progressing", () => {
    const k = clock();
    const d = new StallDetector({}, k.now);
    let v: ReturnType<StallDetector["observe"]> = { stop: false };
    for (let i = 0; i < 200 && !v.stop; i++) {
        k.tick(7000);
        v = d.observe({ url: `${U}?${i}`, domHash: String(i), actionSig: "x" });
    }
    assert.equal(v.stop && v.reason, "runaway_time");
});

t("actionSignature ignores free-text reasons, keeps targets", () => {
    assert.equal(
        actionSignature([{ type: "click", x: 10, y: 20, reason: "a" }]),
        actionSignature([{ type: "click", x: 10, y: 20, reason: "b" }]),
    );
    assert.notEqual(actionSignature([{ type: "click", x: 10, y: 20 }]), actionSignature([{ type: "click", x: 11, y: 20 }]));
    assert.equal(actionSignature([]), "none");
    assert.equal(hashOf("a"), hashOf("a"));
});

t("Swiggy helpers: dish from goal, exact dish pick, restaurant URL", () => {
    assert.equal(
        dishFromGoal("Order exact SKU from Swiggy: Choco-Vanilla Oreo Cake [540g] @ ₹495 | restaurant=Theobroma | delivery_address=x"),
        "Choco-Vanilla Oreo Cake [540g]",
    );
    assert.equal(dishFromGoal("Order exact SKU from Swiggy: Paneer Tikka | restaurant=X"), "Paneer Tikka");
    const names = ["Choco-Vanilla Oreo Pastry [1 Piece]", "Choco-Vanilla Oreo Cake [540g]", "E/L Choco-Vanilla Oreo Pastry [1pc] + Wada Pao [1pc] + Cold Coffee"];
    assert.equal(pickDishName(names, "Choco-Vanilla Oreo Cake [540g]"), "Choco-Vanilla Oreo Cake [540g]");
    assert.equal(pickDishName(names, "Choco Vanilla Oreo Cake 540g"), "Choco-Vanilla Oreo Cake [540g]");
    assert.equal(pickDishName(names, "Choco-Vanilla Oreo Cake [1kg]"), null);
    assert.equal(isSwiggyRestaurantUrl(U), true);
    assert.equal(isSwiggyRestaurantUrl("https://www.swiggy.com/restaurants"), false);
});

t("WhatsApp: only OTP ask + ONE still-working line per run", () => {
    assert.equal(shouldForwardProgressToWhatsApp("otp_ready"), true);
    assert.equal(shouldForwardProgressToWhatsApp("still_working"), true);
    assert.equal(shouldForwardProgressToWhatsApp("searching"), false);
    assert.equal(shouldForwardProgressToWhatsApp("checkout"), false);
    assert.equal(claimStillWorkingNotice("fam", "u", 7), true);
    assert.equal(claimStillWorkingNotice("fam", "u", 7), false);
    assert.equal(claimStillWorkingNotice("fam", "u", 8), true); // new run (new generation)
    assert.equal(stillWorkingDelayMs({} as NodeJS.ProcessEnv), 120_000);
});

console.log(`\n${pass} passed`);
process.exit(0);
