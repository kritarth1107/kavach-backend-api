/**
 * Goal-driven recovery for Ola's page. When a fixed step doesn't find what it expects, this looks
 * at the current screen (visible text + button labels, plus a screenshot for the model), works out
 * which screen it is, and does ONE safe step toward the goal — then looks again. Bounded by steps
 * and time; gives up honestly.
 *
 * Deterministic parts (cannot be overridden by the model):
 *  - Known screens are recognised by rules first; the model is only asked when rules can't tell.
 *  - A captcha / "are you human" check, an OTP box, or a live ride stops recovery at once.
 *  - The model can only pick an action from a closed set, and a click target must be one of the
 *    buttons actually visible on the page. Anything that books, pays, changes payment, sends or
 *    resends a code, submits sign-in, calls or cancels is refused (FORBIDDEN_CLICK).
 *  - "select_ride" always clicks the ride type the elder chose — never another one.
 *  - Recovery never presses Confirm & Book. Booking stays in book() behind the elder's second
 *    confirm, a Cash read-back and the fare/pickup check (see bookGate).
 * Every decision is logged ("ola_recover_step") so real page changes can be hardened later.
 */
import { OLA_TYPES, classifyRidePage } from "./olaCopy";

export type OlaScreen =
    | "ride_list"
    | "continue"
    | "phone_box"
    | "otp_box"
    | "confirm"
    | "searching"
    | "assigned"
    | "popup"
    | "error"
    | "captcha"
    | "unexpected";

/** What the fixed step was trying to reach. */
export type OlaGoal =
    /** Ride list with the ride types (after opening the route). */
    | "ride_list"
    /** After choosing a type: the sign-in phone box (signed out) or the Confirm & Book screen (signed in). */
    | "chosen"
    /** The Confirm & Book screen only (reading the fare, or right before booking). */
    | "confirm";

export type RecoveryActionType = "select_ride" | "click" | "dismiss" | "back" | "reopen" | "wait" | "stop";
export type RecoveryAction = { type: RecoveryActionType; target?: string };

export type ScreenSnapshot = {
    url: string;
    /** Visible text lines in order. */
    lines: string[];
    /** Visible clickable labels (buttons, links, role=button, ride rows). */
    buttons: string[];
    /** JPEG, base64 — only for the model. */
    screenshotB64?: string;
    /** A sign-in iframe with a phone field is on screen. */
    authPhone?: boolean;
    /** A sign-in iframe asking for the code is on screen. */
    authOtp?: boolean;
    /** A captcha frame is visible. */
    captcha?: boolean;
};

export type ScreenVerdict = { screen: OlaScreen; action?: RecoveryAction; reason?: string; source: "rules" | "model" };

export type RecoveryCtx = { goal: OlaGoal; rideType: string; step: number; history: Array<{ screen: OlaScreen; action: RecoveryAction }> };

export type ScreenClassifier = (snap: ScreenSnapshot, ctx: RecoveryCtx) => Promise<ScreenVerdict | null>;

/** The page operations recovery may use. Implemented by the real driver and the test fakes. */
export interface RecoveryPage {
    snapshot(withScreenshot: boolean): Promise<ScreenSnapshot>;
    /** Click the smallest visible element whose own text is exactly `label`. */
    clickLabel(label: string): Promise<boolean>;
    back(): Promise<void>;
    reopen(): Promise<void>;
    wait(ms: number): Promise<void>;
}

export type RecoveryOutcome =
    | { ok: true; screen: OlaScreen; steps: number }
    | { ok: false; why: StopWhy | "budget" | "stuck" | "error"; screen?: OlaScreen; steps: number };

export type RecoveryLogEntry = {
    goal: OlaGoal;
    step: number;
    screen: OlaScreen;
    source: "rules" | "model" | "none";
    action: RecoveryAction;
    allowed: boolean;
    refused?: string;
    reason?: string;
    did?: boolean;
    url?: string;
};

// ── Safety ───────────────────────────────────────────────────────────────────────────────────
/** Never clicked by recovery, whatever the model says. */
export const FORBIDDEN_CLICK =
    /confirm|book|request|pay|upi|wallet|money|card|cash|credit|coupon|promo|cancel|call|sos|emergency|share|otp|code|resend|send|verify|next|submit|log ?in|sign ?in|sign ?up|register|captcha|robot|human|allow|install|download|app store|play store|delete|remove|schedule|rental|outstation|change|edit|add/i;
/** Popup / interstitial close controls. */
export const DISMISS_LABEL = /^(×|✕|x|close|dismiss|skip|not now|no thanks|no,? thanks|maybe later|later|got it|ok(ay)?|okay,? got it|continue on web|use (the )?web( version)?|stay on web|i understand|understood|accept( all)?|agree)$/i;
const CONTINUE_LABEL = /^(continue|proceed|choose\s+\w+(\s+\w+)?|select\s+\w+(\s+\w+)?|go ahead)$/i;
const CAPTCHA_RE = /captcha|are you (a )?(human|robot)|verify (you are|you're) (a )?human|i'?m not a robot|unusual traffic|security check|bot (check|detection)/i;

export function sameLabel(a: string, b: string): boolean {
    return a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The deterministic gate every proposed action goes through. Returns a refusal reason, or null
 * when the action is allowed on this screen.
 */
export function refuseAction(a: RecoveryAction, snap: ScreenSnapshot, ctx: Pick<RecoveryCtx, "goal" | "rideType">): string | null {
    if (snap.captcha || CAPTCHA_RE.test(snap.lines.join(" "))) return a.type === "stop" ? null : "captcha_on_screen";
    switch (a.type) {
        case "stop":
        case "wait":
        case "back":
        case "reopen":
            return null;
        case "select_ride": {
            if (!a.target || !sameLabel(a.target, ctx.rideType)) return "not_the_chosen_ride";
            if (!snap.buttons.some((b) => sameLabel(b, ctx.rideType)) && !snap.lines.some((l) => sameLabel(l, ctx.rideType))) return "ride_not_visible";
            return null;
        }
        case "click":
        case "dismiss": {
            const t = String(a.target || "").trim();
            if (!t) return "no_target";
            if (!snap.buttons.some((b) => sameLabel(b, t))) return "target_not_visible";
            // Another ride type is never clicked.
            if (OLA_TYPES.some((x) => sameLabel(x, t)) && !sameLabel(t, ctx.rideType)) return "other_ride_type";
            if (a.type === "dismiss" && !DISMISS_LABEL.test(t)) return "not_a_close_button";
            // While a sign-in box is up, only closing popups is allowed (nothing that sends a code).
            if ((snap.authPhone || snap.authOtp) && a.type !== "dismiss") return "sign_in_box_open";
            if (a.type === "click" && !DISMISS_LABEL.test(t) && FORBIDDEN_CLICK.test(t) && !CONTINUE_LABEL.test(t)) return "forbidden_label";
            if (a.type === "click" && /confirm|book|pay|cash|send|otp|next|submit|log ?in|sign ?in/i.test(t)) return "forbidden_label";
            return null;
        }
    }
    return "unknown_action";
}

// ── Rules first ──────────────────────────────────────────────────────────────────────────────
function hasRideList(snap: ScreenSnapshot): boolean {
    const n = OLA_TYPES.filter((t) => snap.lines.some((l) => sameLabel(l, t))).length;
    return n >= 2;
}

/** Deterministic screen recognition. Null = rules can't tell; ask the model. */
export function classifyByRules(snap: ScreenSnapshot): ScreenVerdict | null {
    const text = snap.lines.join("\n");
    if (snap.captcha || CAPTCHA_RE.test(text)) return { screen: "captcha", source: "rules" };
    const life = classifyRidePage(text);
    if (life === "assigned" || life === "started") return { screen: "assigned", source: "rules" };
    if (life === "searching") return { screen: "searching", source: "rules" };
    if (snap.authOtp || /enter (the )?(4.digit )?otp|otp sent to|sent to \+?91/i.test(text)) return { screen: "otp_box", source: "rules" };
    if (snap.authPhone || /enter your mobile number/i.test(text)) return { screen: "phone_box", source: "rules" };
    // A known popup close control on top of anything else: close it first.
    const close = snap.buttons.find((b) => DISMISS_LABEL.test(b.trim()));
    if (close && !snap.buttons.some((b) => /confirm\s*&\s*book/i.test(b))) return { screen: "popup", action: { type: "dismiss", target: close }, source: "rules" };
    if (snap.buttons.some((b) => /^confirm\s*&\s*book$/i.test(b.trim())) || snap.lines.some((l) => /^confirm\s*&\s*book$/i.test(l))) return { screen: "confirm", source: "rules" };
    const cont = snap.buttons.find((b) => /^continue$/i.test(b.trim()));
    if (cont) return { screen: "continue", action: { type: "click", target: cont }, source: "rules" };
    if (hasRideList(snap)) return { screen: "ride_list", source: "rules" };
    if (/something went wrong|try again|oops|error/i.test(text) && snap.lines.length < 25) return { screen: "error", source: "rules" };
    return null;
}

/** Given the screen, the next step toward the goal (deterministic). Null = goal reached. */
export type StopWhy = "captcha" | "otp_box" | "live_ride" | "needs_sign_in";
export function nextStepFor(screen: OlaScreen, ctx: RecoveryCtx, suggested?: RecoveryAction): RecoveryAction | "done" | { stop: StopWhy } {
    const { goal } = ctx;
    if (screen === "captcha") return { stop: "captcha" };
    if (screen === "searching" || screen === "assigned") return { stop: "live_ride" };
    if (screen === "otp_box") return { stop: "otp_box" };
    if (goal === "ride_list" && screen === "ride_list") return "done";
    if (goal === "chosen" && (screen === "confirm" || screen === "phone_box")) return "done";
    if (goal === "confirm" && screen === "confirm") return "done";
    switch (screen) {
        case "ride_list":
            return { type: "select_ride", target: ctx.rideType };
        case "continue":
            return suggested?.type === "click" ? suggested : { type: "click", target: "Continue" };
        case "popup":
            return suggested && (suggested.type === "dismiss" || suggested.type === "back") ? suggested : { type: "back" };
        case "error":
            return { type: "reopen" };
        case "phone_box":
            // Wanted the fare screen but Ola asks to sign in: that is the fixed flow's job (after the elder's confirm).
            return { stop: "needs_sign_in" };
        case "confirm":
            // goal ride_list but already on confirm: go back one screen.
            return { type: "back" };
        default:
            return suggested && suggested.type !== "select_ride" ? suggested : { type: "reopen" };
    }
}

// ── The loop ─────────────────────────────────────────────────────────────────────────────────
export type RecoveryOptions = {
    maxSteps?: number;
    maxMs?: number;
    classifier?: ScreenClassifier | null;
    log?: (e: RecoveryLogEntry) => void;
};

export async function recoverTo(page: RecoveryPage, goal: OlaGoal, rideType: string, opts: RecoveryOptions = {}): Promise<RecoveryOutcome> {
    const maxSteps = opts.maxSteps ?? 6;
    const until = Date.now() + (opts.maxMs ?? 45_000);
    const ctx: RecoveryCtx = { goal, rideType, step: 0, history: [] };
    const log = opts.log || (() => undefined);
    let lastScreen: OlaScreen | undefined;
    let repeats = 0;
    for (let step = 1; step <= maxSteps; step++) {
        ctx.step = step;
        if (Date.now() > until) return { ok: false, why: "budget", screen: lastScreen, steps: step - 1 };
        let snap: ScreenSnapshot;
        try {
            snap = await page.snapshot(false);
        } catch {
            return { ok: false, why: "error", screen: lastScreen, steps: step - 1 };
        }
        let verdict = classifyByRules(snap);
        if (!verdict && opts.classifier) {
            try {
                const withShot = await page.snapshot(true).catch(() => snap);
                verdict = await opts.classifier(withShot, ctx);
            } catch {
                verdict = null;
            }
        }
        const screen: OlaScreen = verdict?.screen || "unexpected";
        const next = nextStepFor(screen, ctx, verdict?.action);
        if (next === "done") {
            log({ goal, step, screen, source: verdict?.source || "none", action: { type: "stop" }, allowed: true, reason: "goal_reached", url: snap.url });
            return { ok: true, screen, steps: step - 1 };
        }
        if ("stop" in next) {
            log({ goal, step, screen, source: verdict?.source || "none", action: { type: "stop" }, allowed: true, reason: next.stop, url: snap.url });
            return { ok: false, why: next.stop, screen, steps: step - 1 };
        }
        const refused = refuseAction(next, snap, ctx);
        const entry: RecoveryLogEntry = { goal, step, screen, source: verdict?.source || "none", action: next, allowed: !refused, refused: refused || undefined, reason: verdict?.reason?.slice(0, 160), url: snap.url };
        if (refused) {
            log(entry);
            // A refused model idea: fall back to the safest generic step once, else give up.
            if (refused === "captcha_on_screen") return { ok: false, why: "captcha", screen, steps: step - 1 };
            if (next.type === "reopen" || ctx.history.some((h) => h.action.type === "reopen")) return { ok: false, why: "stuck", screen, steps: step - 1 };
            ctx.history.push({ screen, action: { type: "reopen" } });
            await page.reopen().catch(() => undefined);
            await page.wait(2500);
            continue;
        }
        repeats = screen === lastScreen && ctx.history.at(-1)?.action.type === next.type ? repeats + 1 : 0;
        lastScreen = screen;
        if (repeats >= 2) {
            log({ ...entry, allowed: false, refused: "no_progress" });
            return { ok: false, why: "stuck", screen, steps: step - 1 };
        }
        let did = true;
        if (next.type === "select_ride" || next.type === "click" || next.type === "dismiss") did = await page.clickLabel(next.target!).catch(() => false);
        else if (next.type === "back") await page.back().catch(() => undefined);
        else if (next.type === "reopen") await page.reopen().catch(() => undefined);
        log({ ...entry, did });
        ctx.history.push({ screen, action: next });
        await page.wait(next.type === "wait" ? 2500 : 1800);
    }
    return { ok: false, why: "budget", screen: lastScreen, steps: maxSteps };
}

// ── The model (Vertex Gemini, same model/config as the browser agent) ────────────────────────
let testClassifier: ScreenClassifier | null | undefined;
export function __setOlaScreenClassifierForTests(c: ScreenClassifier | null | undefined): void {
    testClassifier = c;
}

const SCREENS: OlaScreen[] = ["ride_list", "continue", "phone_box", "otp_box", "confirm", "searching", "assigned", "popup", "error", "captcha", "unexpected"];

export function parseModelVerdict(raw: Record<string, unknown> | null): ScreenVerdict | null {
    if (!raw) return null;
    const screen = String(raw.screen || "") as OlaScreen;
    if (!SCREENS.includes(screen)) return null;
    const a = (raw.action || {}) as Record<string, unknown>;
    const type = String(a.type || "") as RecoveryActionType;
    const action = ["select_ride", "click", "dismiss", "back", "reopen", "wait", "stop"].includes(type) ? { type, target: a.target ? String(a.target).slice(0, 60) : undefined } : undefined;
    return { screen, action, reason: raw.reason ? String(raw.reason).slice(0, 200) : undefined, source: "model" };
}

const PROMPT = (snap: ScreenSnapshot, ctx: RecoveryCtx) => `You look at a screen of book.olacabs.com (Ola cab booking website) for an automated helper.
Goal: ${ctx.goal === "ride_list" ? "see the list of ride types" : ctx.goal === "chosen" ? `after choosing the ride type "${ctx.rideType}", reach the sign-in phone box or the Confirm & Book screen` : "reach the Confirm & Book screen"}.
Classify the screen as exactly one of: ${SCREENS.join(", ")}.
("continue" = a ride page with a button that moves on to sign-in; "popup" = a dialog, banner or interstitial covering the page.)
Then suggest ONE next action toward the goal:
- {"type":"select_ride","target":"${ctx.rideType}"} to pick the ride type (only this one),
- {"type":"click","target":"<exact visible button text>"} for a Continue-like button (renamed buttons allowed),
- {"type":"dismiss","target":"<exact close button text>"} to close a popup,
- {"type":"back"}, {"type":"reopen"}, {"type":"wait"} or {"type":"stop"}.
Never suggest booking, paying, changing payment, cancelling, calling, signing in, sending or entering codes, or solving any captcha/robot check.
Visible buttons: ${JSON.stringify(snap.buttons.slice(0, 40))}
Visible text: ${JSON.stringify(snap.lines.slice(0, 80)).slice(0, 2500)}
URL: ${snap.url.replace(/[?#].*$/, "")}
Reply with JSON only: {"screen":"...","action":{...},"reason":"short"}`;

export const geminiScreenClassifier: ScreenClassifier = async (snap, ctx) => {
    if (testClassifier !== undefined) return testClassifier ? testClassifier(snap, ctx) : null;
    if (process.env.OLA_AI_RECOVERY === "0") return null;
    const g = await import("../../commerceAutomation/geminiComputerUse.service");
    const token = await g.getAccessToken();
    if (!token) {
        console.log(JSON.stringify({ evt: "ola_screen_model", result: "no_token" }));
        return null;
    }
    const project = g.gcpProjectId();
    const location = g.visionLocation();
    const host = location === "global" ? "https://aiplatform.googleapis.com" : `https://${location}-aiplatform.googleapis.com`;
    const url = `${host}/v1/projects/${project}/locations/${location}/publishers/google/models/${g.browserModel()}:generateContent`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const started = Date.now();
    const note = (result: string, extra: Record<string, unknown> = {}) =>
        console.log(JSON.stringify({ evt: "ola_screen_model", goal: ctx.goal, step: ctx.step, result, ms: Date.now() - started, shot: Boolean(snap.screenshotB64), ...extra }));
    try {
        const parts: Array<Record<string, unknown>> = [{ text: PROMPT(snap, ctx) }];
        if (snap.screenshotB64) parts.push({ inlineData: { mimeType: "image/jpeg", data: snap.screenshotB64 } });
        const res = await fetch(url, {
            signal: ctrl.signal,
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-goog-user-project": project },
            // Thinking models spend output tokens before the JSON: leave room.
            body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json" } }),
        });
        if (!res.ok) {
            note(`http_${res.status}`, { body: (await res.text().catch(() => "")).slice(0, 200) });
            return null;
        }
        const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> };
        const raw = j.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text || "").join("") || "";
        const v = parseModelVerdict(g.parseJsonObject(raw));
        note(v ? "ok" : "unparsed", v ? { screen: v.screen, action: v.action } : { raw: raw.slice(0, 200) });
        return v;
    } catch (err) {
        note("error", { error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
        return null;
    } finally {
        clearTimeout(timer);
    }
};

// ── Booking gate (pure, deterministic) ───────────────────────────────────────────────────────
export type ConfirmShown = { vehicle: string; fare?: number; pickup?: string; drop?: string; pay?: string };
export type BookGate = { ok: true } | { ok: false; reask: true; why: "fare_up" | "type_changed" | "pickup_changed"; page: ConfirmShown } | { ok: false; reask: false; why: "no_page_fare" | "not_cash" | "not_confirmed" };

const normPlace = (s?: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Right before pressing Confirm & Book: the page must show the same ride type, a fare not above
 * the one the elder confirmed, the same pickup, and Cash (read back from the picker).
 */
export function bookGate(shown: ConfirmShown | undefined, page: ConfirmShown | null, cashVerified: boolean): BookGate {
    if (!shown || shown.fare == null || !/^cash$/i.test(String(shown.pay || ""))) return { ok: false, reask: false, why: "not_confirmed" };
    if (!page || page.fare == null) return { ok: false, reask: false, why: "no_page_fare" };
    if (!cashVerified) return { ok: false, reask: false, why: "not_cash" };
    if (page.vehicle && !sameLabel(page.vehicle, shown.vehicle)) return { ok: false, reask: true, why: "type_changed", page };
    if (page.fare > shown.fare) return { ok: false, reask: true, why: "fare_up", page };
    if (shown.pickup && page.pickup && normPlace(shown.pickup) !== normPlace(page.pickup)) return { ok: false, reask: true, why: "pickup_changed", page };
    return { ok: true };
}
