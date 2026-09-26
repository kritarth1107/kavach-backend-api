/**
 * Progress-based stop rules for browser agents (no fixed step/time caps).
 *
 * A run stops only when it is truly stuck:
 *  - "stalled": the SAME action on the SAME page (same URL and same DOM text or same screenshot)
 *    repeated `repeatLimit` times in a row (default 6) with no page change;
 *  - "no_progress": no NEW page state (URL / DOM text) seen for `noProgressMs` (default 4 min);
 *  - "runaway_steps" / "runaway_time": a very generous safety ceiling (default 200 steps /
 *    20 min) that exists only to stop infinite loops and cost blow-ups.
 *
 * All knobs are env-configurable: BROWSER_STALL_REPEAT, BROWSER_NO_PROGRESS_MS,
 * BROWSER_RUNAWAY_MS, BROWSER_RUNAWAY_STEPS.
 */
import { createHash } from "crypto";

export type StallConfig = {
    repeatLimit: number;
    noProgressMs: number;
    runawayMs: number;
    runawaySteps: number;
};

export type StallStopReason = "stalled" | "no_progress" | "runaway_steps" | "runaway_time";

export type StallVerdict = { stop: false } | { stop: true; reason: StallStopReason; detail: string };

export type StallObservation = {
    url: string;
    /** Hash (or raw text) of the visible DOM / accessibility text. */
    domHash?: string;
    /** Hash of the screenshot bytes. */
    shotHash?: string;
    /** Normalised signature of the action(s) about to be taken for this observation. */
    actionSig?: string;
};

function num(v: string | undefined, fallback: number, min: number, max: number): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.max(Math.round(n), min), max);
}

export function stallConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StallConfig {
    return {
        repeatLimit: num(env.BROWSER_STALL_REPEAT, 6, 3, 50),
        noProgressMs: num(env.BROWSER_NO_PROGRESS_MS, 240_000, 30_000, 3_600_000),
        runawayMs: num(env.BROWSER_RUNAWAY_MS, 1_200_000, 60_000, 3_600_000),
        runawaySteps: num(env.BROWSER_RUNAWAY_STEPS, 200, 10, 2_000),
    };
}

/** The runaway ceiling in ms — the only wall-clock budget browser runs get. */
export function browserRunawayMs(env: NodeJS.ProcessEnv = process.env): number {
    return stallConfigFromEnv(env).runawayMs;
}

export function hashOf(data: string | Buffer | Uint8Array | undefined | null): string {
    if (data == null) return "";
    return createHash("sha1").update(data).digest("hex").slice(0, 16);
}

/** Stable signature for a planned action list (type + target), ignoring free-text reasons. */
export function actionSignature(actions: unknown[]): string {
    return actions
        .map((a) => {
            const o = (a || {}) as Record<string, unknown>;
            const parts = [o.type, o.selector, o.text, o.key, o.url, o.x, o.y, o.direction]
                .filter((v) => v !== undefined && v !== null && v !== "")
                .map((v) => String(v).slice(0, 80));
            return parts.join(":");
        })
        .join("+") || "none";
}

function urlKey(u: string): string {
    try {
        const x = new URL(u);
        return `${x.host}${x.pathname}${x.search}`;
    } catch {
        return u;
    }
}

export class StallDetector {
    readonly cfg: StallConfig;
    readonly startedAt: number;
    private readonly now: () => number;
    private steps = 0;
    private repeats = 0;
    private prev: { url: string; dom: string; shot: string; action: string } | null = null;
    private seen = new Set<string>();
    private lastProgressAt: number;

    constructor(cfg: Partial<StallConfig> = {}, now: () => number = Date.now) {
        this.cfg = { ...stallConfigFromEnv(), ...cfg };
        this.now = now;
        this.startedAt = now();
        this.lastProgressAt = this.startedAt;
    }

    get stepCount(): number {
        return this.steps;
    }

    get repeatCount(): number {
        return this.repeats;
    }

    get runawayDeadlineAt(): number {
        return this.startedAt + this.cfg.runawayMs;
    }

    /** External progress signal (e.g. a scripted step succeeded, OTP accepted). */
    markProgress(): void {
        this.lastProgressAt = this.now();
        this.repeats = 0;
    }

    /** Checks only the time-based rules (use between steps / while waiting). */
    checkTime(): StallVerdict {
        const t = this.now();
        if (t - this.startedAt >= this.cfg.runawayMs) {
            return { stop: true, reason: "runaway_time", detail: `safety ceiling ${Math.round(this.cfg.runawayMs / 60_000)} min reached` };
        }
        if (t - this.lastProgressAt >= this.cfg.noProgressMs) {
            return {
                stop: true,
                reason: "no_progress",
                detail: `no page change for ${Math.round((t - this.lastProgressAt) / 1000)}s`,
            };
        }
        return { stop: false };
    }

    /** Record one agent step (page state + action about to be taken) and decide whether to stop. */
    observe(obs: StallObservation): StallVerdict {
        this.steps += 1;
        const cur = {
            url: urlKey(obs.url),
            dom: obs.domHash || "",
            shot: obs.shotHash || "",
            action: obs.actionSig || "",
        };
        const stateKey = `${cur.url}|${cur.dom || cur.shot}`;
        if (!this.seen.has(stateKey)) {
            this.seen.add(stateKey);
            this.lastProgressAt = this.now();
        }
        const p = this.prev;
        const samePage =
            !!p && p.url === cur.url && ((!!cur.dom && p.dom === cur.dom) || (!!cur.shot && p.shot === cur.shot));
        if (samePage && p!.action === cur.action) this.repeats += 1;
        else this.repeats = 1;
        this.prev = cur;

        if (this.steps > this.cfg.runawaySteps) {
            return { stop: true, reason: "runaway_steps", detail: `safety ceiling ${this.cfg.runawaySteps} steps reached` };
        }
        if (this.repeats >= this.cfg.repeatLimit) {
            return {
                stop: true,
                reason: "stalled",
                detail: `same action "${cur.action.slice(0, 60)}" on an unchanged page ${this.repeats}× in a row`,
            };
        }
        return this.checkTime();
    }
}
