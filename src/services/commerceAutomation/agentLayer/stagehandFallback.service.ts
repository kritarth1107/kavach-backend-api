/**
 * Stagehand (v3) as a self-healing fallback for a single step.
 *
 * - Attaches to our already-running Chromium over local CDP (same signed-in page).
 * - Model: Gemini flash on Vertex (ADC) — `vertex/${VERTEX_BROWSER_MODEL || "gemini-3.5-flash"}`.
 * - observe() proposes candidate actions; EVERY candidate is validated in code against the
 *   guardrail denylists using the model's description AND the element's live DOM text.
 *   Only click/scroll are ever executed. Typing, payment, COD, Place order stay in code.
 * - Any init/runtime failure disables Stagehand for that browser and returns null (callers
 *   fall back to the existing Gemini computer-use step).
 */
import type { Page } from "playwright";
import { cdpUrlForPage, stagehandEnabled } from "./cdpRegistry";
import { validateAgentAction, type GuardVerdict } from "./guardrails";

type StagehandAction = { selector: string; description: string; method?: string; arguments?: string[] };
type StagehandLike = {
    init(): Promise<void>;
    observe(instruction: string, opts?: Record<string, unknown>): Promise<StagehandAction[]>;
    act(action: StagehandAction, opts?: Record<string, unknown>): Promise<{ success: boolean; message: string }>;
    extract(instruction: string, schema: unknown, opts?: Record<string, unknown>): Promise<unknown>;
    close(opts?: Record<string, unknown>): Promise<void>;
};

export const STAGEHAND_MODEL = () => `vertex/${process.env.VERTEX_BROWSER_MODEL?.trim() || "gemini-3.5-flash"}`;

const instances = new Map<string, Promise<StagehandLike | null>>();
const disabled = new Set<string>();

type Log = (event: string, extra?: Record<string, unknown>) => void;

/** Test hook: inject a fake Stagehand factory. */
let factoryOverride: ((cdpUrl: string) => Promise<StagehandLike | null>) | null = null;
export function __setStagehandFactoryForTests(f: ((cdpUrl: string) => Promise<StagehandLike | null>) | null): void {
    factoryOverride = f;
    instances.clear();
    disabled.clear();
}

async function createStagehand(cdpUrl: string, log: Log): Promise<StagehandLike | null> {
    if (factoryOverride) return factoryOverride(cdpUrl);
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("@browserbasehq/stagehand") as { V3?: new (o: unknown) => StagehandLike; Stagehand?: new (o: unknown) => StagehandLike };
        const Ctor = mod.V3 || mod.Stagehand;
        if (!Ctor) return null;
        const project = process.env.GCP_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "kavach-care";
        const location = process.env.STAGEHAND_VERTEX_LOCATION?.trim() || process.env.GCP_REGION?.trim() || "asia-south1";
        const sh = new Ctor({
            env: "LOCAL",
            localBrowserLaunchOptions: { cdpUrl, connectTimeoutMs: 8000 },
            model: { modelName: STAGEHAND_MODEL(), providerOptions: { vertex: { project, location } } },
            experimental: true,
            selfHeal: true,
            cacheDir: process.env.STAGEHAND_CACHE_DIR || "/tmp/stagehand-cache",
            disablePino: true,
            verbose: 0,
            domSettleTimeout: 1500,
            logger: () => undefined,
        });
        await sh.init();
        log("stagehand_init", { model: STAGEHAND_MODEL(), location });
        return sh;
    } catch (err) {
        log("stagehand_init_failed", { msg: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
        return null;
    }
}

async function getStagehand(page: Page, log: Log): Promise<StagehandLike | null> {
    if (!stagehandEnabled() && !factoryOverride) return null;
    const cdpUrl = await cdpUrlForPage(page);
    const key = cdpUrl || (factoryOverride ? "test" : "");
    if (!key || disabled.has(key)) return null;
    let p = instances.get(key);
    if (!p) {
        p = createStagehand(key, log);
        instances.set(key, p);
        try {
            page.context().browser()?.once("disconnected", () => {
                instances.delete(key);
                disabled.delete(key);
            });
        } catch {
            /* ignore */
        }
    }
    const sh = await p;
    if (!sh) disabled.add(key);
    return sh;
}

/** Release the Stagehand instance for a browser (does NOT close our Chromium). */
export async function releaseStagehandForPage(page: Page): Promise<void> {
    const cdpUrl = await cdpUrlForPage(page);
    if (!cdpUrl) return;
    const p = instances.get(cdpUrl);
    instances.delete(cdpUrl);
    const sh = p ? await p.catch(() => null) : null;
    // Keep our Chromium alive: close only Stagehand's CDP connection.
    await sh?.close({ force: false }).catch(() => undefined);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ms);
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            () => {
                clearTimeout(t);
                resolve(null);
            },
        );
    });
}

/** Live DOM text of the element Stagehand targeted (text, aria, title, value, href, id/class). */
export async function describeSelector(page: Page, selector: string): Promise<string | null> {
    try {
        const loc = page.locator(selector).first();
        if ((await loc.count()) === 0) return null;
        return await loc.evaluate((el: Element) => {
            const h = el as HTMLElement;
            const parts = [
                h.innerText || h.textContent || "",
                h.getAttribute("aria-label") || "",
                h.getAttribute("title") || "",
                (h as HTMLInputElement).value || "",
                h.getAttribute("href") || "",
                h.getAttribute("name") || "",
                h.id || "",
                typeof h.className === "string" ? h.className : "",
            ];
            const lab = h.closest("label");
            if (lab) parts.push(lab.textContent || "");
            return parts.join(" ").replace(/\s+/g, " ").slice(0, 400);
        }, undefined, { timeout: 2000 });
    } catch {
        return null;
    }
}

export type AgentStepResult =
    | { status: "acted"; description: string }
    | { status: "blocked"; verdicts: Array<{ description: string; verdict: GuardVerdict }> }
    | { status: "no_candidates" }
    | { status: "unavailable" };

/**
 * One self-healing step: observe(goal) → validate every candidate in code → act on the first
 * allowed one. Never types, never pays, never places the order.
 */
export async function stagehandStep(
    page: Page,
    args: { goal: string; log?: Log; timeoutMs?: number; extraAllow?: (text: string) => boolean },
): Promise<AgentStepResult> {
    const log = args.log ?? (() => undefined);
    const sh = await getStagehand(page, log);
    if (!sh) return { status: "unavailable" };
    const timeoutMs = args.timeoutMs ?? 25_000;
    const goal =
        `${args.goal}\nRules: only propose clicking or scrolling. Never propose payment options, ` +
        `Place order, Cash on delivery, memberships/plans/subscriptions, removing items, or typing.`;
    const candidates = await withTimeout(sh.observe(goal, { page, timeout: timeoutMs }), timeoutMs + 2000);
    if (!candidates) {
        log("stagehand_observe_failed", {});
        return { status: "unavailable" };
    }
    if (!candidates.length) return { status: "no_candidates" };
    const verdicts: Array<{ description: string; verdict: GuardVerdict }> = [];
    for (const c of candidates.slice(0, 4)) {
        const live = c.selector ? await describeSelector(page, c.selector) : null;
        if (live == null) {
            // Can't read the real element → fail closed.
            verdicts.push({ description: c.description, verdict: { ok: false, reason: "method", matched: "unresolvable" } });
            continue;
        }
        const verdict = validateAgentAction({ method: c.method, texts: [c.description, live] });
        if (!verdict.ok) {
            verdicts.push({ description: c.description, verdict });
            log("stagehand_blocked", { reason: verdict.reason, matched: verdict.matched, desc: c.description.slice(0, 80) });
            continue;
        }
        const res = await withTimeout(sh.act(c, { page, timeout: 12_000 }), 15_000);
        if (res && res.success) {
            log("stagehand_acted", { desc: c.description.slice(0, 80), method: c.method || "click" });
            return { status: "acted", description: c.description };
        }
        log("stagehand_act_failed", { desc: c.description.slice(0, 80), msg: res?.message?.slice(0, 120) });
    }
    return verdicts.length ? { status: "blocked", verdicts } : { status: "no_candidates" };
}

/** Structured read of the page (cart lines / payable / selected payment) — read-only. */
export async function stagehandExtract<T>(
    page: Page,
    args: { instruction: string; schema: unknown; log?: Log; timeoutMs?: number },
): Promise<T | null> {
    const log = args.log ?? (() => undefined);
    const sh = await getStagehand(page, log);
    if (!sh) return null;
    const ms = args.timeoutMs ?? 20_000;
    const out = await withTimeout(sh.extract(args.instruction, args.schema, { page, timeout: ms }), ms + 2000);
    if (out == null) log("stagehand_extract_failed", {});
    return (out as T) ?? null;
}

/** Observe-only helper used by the step engine to locate a code-owned control (COD / Place order). */
export async function stagehandLocate(
    page: Page,
    args: { goal: string; log?: Log; timeoutMs?: number },
): Promise<Array<{ selector: string; description: string; liveText: string }>> {
    const log = args.log ?? (() => undefined);
    const sh = await getStagehand(page, log);
    if (!sh) return [];
    const ms = args.timeoutMs ?? 20_000;
    const cands = (await withTimeout(sh.observe(args.goal, { page, timeout: ms }), ms + 2000)) || [];
    const out: Array<{ selector: string; description: string; liveText: string }> = [];
    for (const c of cands.slice(0, 4)) {
        if (!c.selector) continue;
        const live = await describeSelector(page, c.selector);
        if (live) out.push({ selector: c.selector, description: c.description, liveText: live });
    }
    return out;
}
