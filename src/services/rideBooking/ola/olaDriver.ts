/**
 * Drives book.olacabs.com. Everything goes through this interface so the lifecycle is tested with a
 * scripted fake (test numbers only) and runs the real page in production.
 * Ola renders inside shadow DOM: text is read by walking shadow roots, and Playwright's text /
 * CSS locators pierce open shadow roots for clicks.
 */
import {
    OLA_TYPES,
    classifyRidePage,
    parseConfirm,
    parseDriver,
    parseRideTypes,
    type OlaConfirmInfo,
    type OlaDriverInfo,
    type OlaPageState,
    type OlaRideType,
} from "./olaCopy";
import { recoverTo, geminiScreenClassifier, type OlaGoal, type RecoveryLogEntry, type RecoveryOutcome, type RecoveryPage, type ScreenSnapshot } from "./olaRecovery";

export type LoginStart = "otp_sent" | "failed" | "blocked";
export type OtpResult = "confirm" | "list" | "invalid" | "failed";
export type BookResult = "searching" | "assigned" | "unknown" | "failed" | "not_cash";
/** Cash is verified by reading Ola's payment picker back after selecting it. */
export type CashResult = {
    ok: boolean;
    reason?: "no_cash_option" | "select_failed" | "no_selector";
    /** What the picker shows now, and the choices it offered (digits masked). */
    selected?: string;
    options?: string[];
};

export interface OlaDriver {
    readonly kind: "real" | "fake";
    open(url: string): Promise<void>;
    rideTypes(): Promise<OlaRideType[]>;
    loggedIn(): Promise<boolean>;
    /** Click a ride type: lands on the sign-in page or the confirm-ride page. */
    choose(type: string): Promise<"login" | "confirm" | "failed">;
    startLogin(phone10: string): Promise<LoginStart>;
    submitOtp(code: string): Promise<OtpResult>;
    readConfirm(vehicle: string): Promise<OlaConfirmInfo | null>;
    ensureCash(): Promise<CashResult>;
    book(): Promise<BookResult>;
    status(): Promise<{ state: OlaPageState; driver?: OlaDriverInfo }>;
    /** Press Ola's own cancel control and verify on the page that it is cancelled. */
    cancel(): Promise<boolean>;
    /** Reopen the live ride after a restart (saved sign-in). */
    reattach(): Promise<boolean>;
    storageState(): Promise<string | null>;
    /** Failure snapshot (masked screenshot + visible text) for the family dashboard; real page only. */
    diagnose?(meta: { familyId: string; userId: string; recipientUserId: string; stage: string; reason: string }): Promise<void>;
    /** Page changed: look at the screen and step toward the goal (bounded, logged, safety-gated). */
    recover?(goal: OlaGoal, rideType: string, log: (e: RecoveryLogEntry) => void): Promise<RecoveryOutcome>;
    close(): Promise<void>;
}

const OLA_HOME = "https://book.olacabs.com/";

/** Visible text in document order, walking open shadow roots (Ola renders inside them). */
const DEEP_TEXT_JS = `(() => {
  const out = [];
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
  const visit = (n) => {
    if (n.nodeType === 3) { const t = (n.textContent || "").trim(); if (t) out.push(t); return; }
    if (n.tagName && skip.has(n.tagName)) return;
    if (n.tagName === "INPUT" && n.value) out.push(n.value);
    if (n.shadowRoot) visit(n.shadowRoot);
    n.childNodes.forEach(visit);
  };
  if (document.body) visit(document.body);
  return out;
})()`;

/**
 * Only what is on screen: Ola's single-page app keeps earlier screens in the DOM, hidden
 * (a stale "PICKUP / DROP" card sits before the real one), so parsing reads visible text.
 */
const VISIBLE_TEXT_JS = `(() => {
  const out = [];
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    }
    return true;
  };
  const visit = (n) => {
    if (n.nodeType === 3) { const t = (n.textContent || "").trim(); if (t && shown(n.parentElement)) out.push(t); return; }
    if (n.tagName && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(n.tagName)) return;
    if (n.tagName === "SELECT") { const o = n.options[n.selectedIndex]; if (o && shown(n)) out.push(o.text.trim()); return; }
    if (n.shadowRoot) visit(n.shadowRoot);
    n.childNodes.forEach(visit);
  };
  if (document.body) visit(document.body);
  return out;
})()`;

/**
 * Ola's payment picker (seen live 28 Sep 2026): a native <select id="paymentSelector" class="ola-select
 * pay-select"> inside a shadow root, options like {value:"1", text:"Cash"}. Its option texts are in
 * the DOM whether selected or not, so reading "the line after PAY BY" is not the selected method.
 */
const PAY_READ_JS = `(() => {
  let sel = null;
  const find = (r) => {
    if (sel) return;
    for (const e of r.querySelectorAll("select")) {
      if (e.id === "paymentSelector" || /pay/i.test(e.className || "") || /pay/i.test(e.id || "")) { sel = e; return; }
    }
    for (const e of r.querySelectorAll("*")) if (e.shadowRoot) find(e.shadowRoot);
  };
  find(document);
  if (!sel) return null;
  const o = sel.options[sel.selectedIndex];
  return { selected: o ? o.text.trim() : "", value: sel.value, options: [...sel.options].map((x) => ({ value: x.value, text: x.text.trim(), disabled: x.disabled })) };
})()`;

/** Fallback when Playwright's selectOption can't reach it: set the value and fire the events a user's pick fires. */
const PAY_SET_JS = (value: string) => `(() => {
  let sel = null;
  const find = (r) => {
    if (sel) return;
    for (const e of r.querySelectorAll("select")) {
      if (e.id === "paymentSelector" || /pay/i.test(e.className || "") || /pay/i.test(e.id || "")) { sel = e; return; }
    }
    for (const e of r.querySelectorAll("*")) if (e.shadowRoot) find(e.shadowRoot);
  };
  find(document);
  if (!sel) return false;
  sel.value = ${JSON.stringify(value)};
  sel.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  sel.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return true;
})()`;

/** Centre of the smallest visible element whose own text is exactly the label (Ola keeps hidden copies). */
const FIND_LABEL_JS = (label: string) => `(() => {
  const want = ${JSON.stringify(label)}.replace(/\\s+/g, " ").trim().toLowerCase();
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0" || s.pointerEvents === "none" && e === el) return false;
    }
    return true;
  };
  let best = null;
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      const own = (el.innerText !== undefined ? el.innerText : el.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const aria = (el.getAttribute && (el.getAttribute("aria-label") || "")).trim().toLowerCase();
      if (own !== want && aria !== want) continue;
      if (!shown(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (!best || area < best.area) best = { x: r.left + r.width / 2, y: r.top + r.height / 2, area };
    }
  };
  visit(document);
  return best;
})()`;

/** Visible clickable labels (buttons, links, role=button, pointer-cursor rows), short texts only. */
const BUTTONS_JS = `(() => {
  const out = new Set();
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    for (let e = el; e; e = e.parentElement || (e.getRootNode && e.getRootNode().host)) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    }
    return true;
  };
  const visit = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      const tag = el.tagName;
      const clickable = tag === "BUTTON" || tag === "A" || el.getAttribute("role") === "button" || (tag === "INPUT" && /button|submit/.test(el.type)) || getComputedStyle(el).cursor === "pointer";
      if (!clickable) continue;
      const t = ((tag === "INPUT" ? el.value : el.innerText) || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
      if (!t || t.length > 40 || t.includes("\\n")) continue;
      if (shown(el)) out.add(t);
      if (out.size > 60) return;
    }
  };
  visit(document);
  return [...out];
})()`;

const maskDigits = (s: string) => s.replace(/\d{3,}/g, "•••").slice(0, 40);
export const isCashLabel = (s?: string | null) => /^\s*cash\s*$/i.test(String(s || ""));

type PayState = { selected: string; value: string; options: Array<{ value: string; text: string; disabled: boolean }> };

export class PlaywrightOlaDriver implements OlaDriver {
    readonly kind = "real" as const;
    private browser: import("playwright").Browser | null = null;
    private ctx: import("playwright").BrowserContext | null = null;
    private page: import("playwright").Page | null = null;
    private rideUrl: string | null = null;
    constructor(private storageStateJson: string | null) {}

    private async ensure(): Promise<import("playwright").Page> {
        if (this.page && !this.page.isClosed()) return this.page;
        const pw = await import("playwright");
        this.browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], timeout: 20_000 });
        let state: unknown;
        try {
            state = this.storageStateJson ? JSON.parse(this.storageStateJson) : undefined;
        } catch {
            state = undefined;
        }
        this.ctx = await this.browser.newContext({
            viewport: { width: 1280, height: 860 },
            locale: "en-IN",
            timezoneId: "Asia/Kolkata",
            userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            ...(state ? { storageState: state as never } : {}),
        });
        this.page = await this.ctx.newPage();
        this.page.setDefaultTimeout(15_000);
        return this.page;
    }

    private async lines(): Promise<string[]> {
        const p = await this.ensure();
        // A plain string: bundlers inject helpers into compiled functions that don't exist in the page.
        const clean = (a: string[]) => a.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
        const vis = clean(await p.evaluate<string[]>(VISIBLE_TEXT_JS).catch(() => [] as string[]));
        if (vis.length >= 3) return vis;
        return clean(await p.evaluate<string[]>(DEEP_TEXT_JS).catch(() => [] as string[]));
    }

    private async payState(): Promise<PayState | null> {
        const p = await this.ensure();
        return (await p.evaluate<PayState | null>(PAY_READ_JS).catch(() => null)) || null;
    }

    /** On screen now (visible text only — Ola keeps hidden copies of earlier screens, so getByText().first() can be a hidden one). */
    private async seen(re: RegExp | string, exact = false): Promise<boolean> {
        const l = await this.lines();
        if (typeof re !== "string") return l.some((x) => re.test(x));
        const w = re.toLowerCase();
        return l.some((x) => (exact ? x.toLowerCase() === w : x.toLowerCase().includes(w)));
    }

    /** Ola's sign-in lives in an accounts.olacabs.com iframe inside book.olacabs.com (seen live 28 Sep 2026). */
    private authFrame(): import("playwright").Frame | null {
        return this.page?.frames().find((f) => /accounts\.olacabs\.com/.test(f.url())) || null;
    }

    private async authText(): Promise<string> {
        const f = this.authFrame();
        return f ? await f.locator("body").innerText({ timeout: 3000 }).catch(() => "") : "";
    }

    private async waitFor(check: () => Promise<boolean>, ms: number, step = 800): Promise<boolean> {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            if (await check()) return true;
            await (await this.ensure()).waitForTimeout(step);
        }
        return false;
    }

    async open(url: string): Promise<void> {
        const p = await this.ensure();
        this.rideUrl = url;
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        const cow = p.getByText("Continue on web").first();
        if (await cow.isVisible({ timeout: 3000 }).catch(() => false)) await cow.click().catch(() => undefined);
    }

    async rideTypes(): Promise<OlaRideType[]> {
        await this.waitFor(async () => (await this.lines()).some((l) => OLA_TYPES.some((t) => t.toLowerCase() === l.toLowerCase())), 18_000);
        return parseRideTypes(await this.lines());
    }

    async loggedIn(): Promise<boolean> {
        const l = await this.lines();
        if (l.some((x) => /please log in/i.test(x)) || l.some((x) => /^log ?in$/i.test(x))) return false;
        return parseRideTypes(l).some((t) => t.fare);
    }

    async choose(type: string): Promise<"login" | "confirm" | "failed"> {
        const p = await this.ensure();
        // By position of the visible copy: getByText().first() can be a hidden stale row (live 28 Sep).
        // The row can render a moment after its name shows up in the page text.
        if (!(await this.waitFor(async () => Boolean(await this.visibleLabel(type)), 8000, 500))) return "failed";
        if (!(await this.clickLabel(type))) return "failed";
        let kind: "login" | "confirm" | "failed" = "failed";
        // Signed out, Ola shows the ride page with a "Continue" button (fare hidden) that leads to sign-in.
        // The button shows up before it reacts (live 28 Sep: a click 40 ms after it appeared was lost),
        // so wait for the page to settle and press again if it is still there.
        let presses = 0;
        let lastPress = 0;
        await this.waitFor(async () => {
            if (await this.seen(/confirm\s*&\s*book/i)) kind = "confirm";
            else if (/enter your mobile number/i.test(await this.authText()) || (await this.seen(/enter your mobile number/i))) kind = "login";
            else if (presses < 3 && Date.now() - lastPress > 3500 && (await this.visibleLabel("Continue"))) {
                await p.waitForTimeout(presses ? 300 : 1200);
                if (await this.clickLabel("Continue")) {
                    presses++;
                    lastPress = Date.now();
                }
            }
            return kind !== "failed";
        }, 20_000);
        return kind;
    }

    async startLogin(phone10: string): Promise<LoginStart> {
        const p = await this.ensure();
        const scope = this.authFrame() || p.mainFrame();
        const input = scope.locator('input#phone-number, input[type="tel"], input[name*="phone" i], input[name*="mobile" i]').first();
        if (!(await input.isVisible({ timeout: 8000 }).catch(() => false))) return "failed";
        await input.click().catch(() => undefined);
        await input.fill(phone10).catch(() => undefined);
        await scope.getByText("Next", { exact: true }).first().click({ timeout: 5000 }).catch(() => undefined);
        let res: LoginStart = "failed";
        await this.waitFor(async () => {
            const t = (await this.authText()) || (await this.lines()).join("\n");
            // "Code sent" only when the page itself asks for the OTP.
            if (/enter (the )?(4.digit )?otp|otp sent|sent to \+?91|verify/i.test(t) && !/enter your mobile number/i.test(t)) res = "otp_sent";
            else if (p.frames().some((f) => /recaptcha\/.*bframe/.test(f.url())) && (await p.locator('iframe[src*="bframe"]').first().isVisible().catch(() => false))) res = "blocked";
            else if (/too many|try again later|invalid (mobile|phone|number)|something went wrong|blocked/i.test(t)) res = "failed";
            else return false;
            return true;
        }, 20_000);
        return res;
    }

    async submitOtp(code: string): Promise<OtpResult> {
        const p = await this.ensure();
        const scope = this.authFrame() || p.mainFrame();
        const inputs = scope.locator('input[autocomplete="one-time-code"], input[placeholder*="OTP" i], input[name*="otp" i], input[id*="otp" i], input[type="tel"], input[type="number"], input[inputmode="numeric"]');
        const n = await inputs.count().catch(() => 0);
        if (!n || !(await inputs.first().isVisible({ timeout: 5000 }).catch(() => false))) return "failed";
        await inputs.first().click().catch(() => undefined);
        // One box or one box per digit: typing moves focus across split boxes.
        if (n >= code.length) await p.keyboard.type(code, { delay: 120 }).catch(() => undefined);
        else await inputs.first().fill(code).catch(() => undefined);
        await scope.getByText(/^(verify( otp)?|log ?in|submit|continue|next)$/i).first().click({ timeout: 4000 }).catch(() => undefined);
        let res: OtpResult = "failed";
        await this.waitFor(async () => {
            const t = await this.authText();
            if (await this.seen(/confirm\s*&\s*book/i)) res = "confirm";
            else if (/invalid|incorrect|wrong|expired/i.test(t) || (await this.seen(/invalid otp|incorrect otp|wrong otp/i))) res = "invalid";
            else if (!this.authFrame() && (await this.lines()).some((l) => /^₹\s?\d/.test(l))) res = "list";
            else return false;
            return true;
        }, 25_000);
        return res;
    }

    async readConfirm(vehicle: string): Promise<OlaConfirmInfo | null> {
        if (!(await this.waitFor(() => this.seen(/confirm\s*&\s*book/i), 15_000))) return null;
        await (await this.ensure()).waitForTimeout(1500);
        const l = await this.lines();
        const c = parseConfirm(l, vehicle);
        // If the screen names exactly one ride type and it isn't hers, report that one (the booking gate re-asks).
        const shownTypes = OLA_TYPES.filter((t) => l.some((x) => x.toLowerCase() === t.toLowerCase()));
        if (shownTypes.length === 1 && shownTypes[0]!.toLowerCase() !== vehicle.toLowerCase()) c.vehicle = shownTypes[0]!;
        return c.fare ? c : null;
    }

    async ensureCash(): Promise<CashResult> {
        const p = await this.ensure();
        const opts = (st: PayState | null) => st?.options.map((o) => maskDigits(o.text));
        let st = await this.payState();
        if (!st) {
            // No picker found: only trust a visible "PAY BY  Cash".
            const c = parseConfirm(await this.lines(), "");
            return isCashLabel(c.pay) ? { ok: true, selected: "Cash" } : { ok: false, reason: "no_selector", selected: c.pay ? maskDigits(c.pay) : undefined };
        }
        if (isCashLabel(st.selected)) return { ok: true, selected: st.selected, options: opts(st) };
        const cash = st.options.find((o) => isCashLabel(o.text) && !o.disabled);
        if (!cash) return { ok: false, reason: "no_cash_option", selected: maskDigits(st.selected), options: opts(st) };
        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt < 2) {
                await p
                    .locator("select#paymentSelector, select.pay-select")
                    .first()
                    .selectOption({ value: cash.value }, { timeout: 5000 })
                    .catch(() => undefined);
            } else {
                await p.evaluate(PAY_SET_JS(cash.value)).catch(() => false);
            }
            await p.waitForTimeout(1500);
            st = await this.payState();
            if (st && isCashLabel(st.selected)) return { ok: true, selected: st.selected, options: opts(st) };
        }
        return { ok: false, reason: "select_failed", selected: st ? maskDigits(st.selected) : undefined, options: opts(st) };
    }

    async book(): Promise<BookResult> {
        const p = await this.ensure();
        // Last check right before the tap: Cash must still be the chosen payment.
        const st = await this.payState();
        const visPay = parseConfirm(await this.lines(), "").pay;
        if (st ? !isCashLabel(st.selected) : !isCashLabel(visPay)) return "not_cash";
        if (!(await this.clickLabel("Confirm & Book"))) await p.getByText(/confirm\s*&\s*book/i).first().click({ timeout: 6000 }).catch(() => undefined);
        let res: BookResult = "unknown";
        const ok = await this.waitFor(async () => {
            const s = classifyRidePage((await this.lines()).join("\n"));
            if (s === "searching" || s === "assigned") res = s;
            return s === "searching" || s === "assigned";
        }, 25_000, 1200);
        if (ok) return res;
        return (await this.seen(/confirm\s*&\s*book/i)) ? "failed" : "unknown";
    }

    async status(): Promise<{ state: OlaPageState; driver?: OlaDriverInfo }> {
        const l = await this.lines();
        const state = classifyRidePage(l.join("\n"));
        return { state, driver: state === "assigned" ? parseDriver(l) : undefined };
    }

    async cancel(): Promise<boolean> {
        const p = await this.ensure();
        for (let round = 0; round < 2; round++) {
            const btn = p.getByText(/^\s*cancel( ride| booking| search| request)?\s*$/i).first();
            if (await btn.isVisible().catch(() => false)) await btn.click({ timeout: 4000 }).catch(() => undefined);
            await p.waitForTimeout(1500);
            const reason = p.getByText(/^(other|changed my mind|booked by mistake|driver (is )?taking (too )?long|wait time too long)$/i).first();
            if (await reason.isVisible().catch(() => false)) await reason.click({ timeout: 3000 }).catch(() => undefined);
            const yes = p.getByText(/^(yes,? cancel( ride)?|cancel ride|confirm cancel(lation)?|submit|yes)$/i).first();
            if (await yes.isVisible().catch(() => false)) await yes.click({ timeout: 3000 }).catch(() => undefined);
            const done = await this.waitFor(async () => {
                const l = await this.lines();
                const s = classifyRidePage(l.join("\n"));
                if (s === "cancelled") return true;
                // Back on the booking home with no live ride = cancelled.
                // ("Track your current rides" is a standing link on the home page, so it is not a live-ride signal.)
                return s !== "searching" && s !== "assigned" && l.some((x) => /^available rides$/i.test(x));
            }, 12_000, 1000);
            if (done) return true;
        }
        return false;
    }

    async reattach(): Promise<boolean> {
        try {
            const p = await this.ensure();
            await p.goto(OLA_HOME, { waitUntil: "domcontentloaded", timeout: 25_000 });
            const track = p.getByText(/track your current ride/i).first();
            if (await track.isVisible({ timeout: 8000 }).catch(() => false)) {
                await track.click().catch(() => undefined);
                await p.waitForTimeout(4000);
                const s = classifyRidePage((await this.lines()).join("\n"));
                return s !== "unknown";
            }
            return false;
        } catch {
            return false;
        }
    }

    async diagnose(meta: { familyId: string; userId: string; recipientUserId: string; stage: string; reason: string }): Promise<void> {
        const { captureCheckoutDiagnostic } = await import("../../commerceAutomation/checkoutDiagnostics.service");
        await captureCheckoutDiagnostic(this.page, { ...meta, flow: "checkout" }).catch(() => null);
    }

    private async visibleLabel(label: string): Promise<{ x: number; y: number } | null> {
        const p = await this.ensure();
        return (await p.evaluate<{ x: number; y: number } | null>(FIND_LABEL_JS(label)).catch(() => null)) || null;
    }

    /** Click the visible copy of a label by its position on screen. */
    async clickLabel(label: string): Promise<boolean> {
        const p = await this.ensure();
        const at = await this.visibleLabel(label);
        if (!at) return false;
        await p.mouse.click(at.x, at.y).catch(() => undefined);
        return true;
    }

    private recoveryPage(): RecoveryPage {
        return {
            snapshot: async (withShot: boolean): Promise<ScreenSnapshot> => {
                const p = await this.ensure();
                const lines = await this.lines();
                const buttons = await p.evaluate<string[]>(BUTTONS_JS).catch(() => [] as string[]);
                const auth = await this.authText();
                const f = this.authFrame();
                const authPhone = Boolean(f) && (/enter your mobile number/i.test(auth) || (await f!.locator('input[type="tel"], input#phone-number').first().isVisible().catch(() => false)));
                const authOtp = Boolean(f) && /enter (the )?(4.digit )?otp|otp sent|sent to \+?91/i.test(auth);
                const captcha = await p.locator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"], iframe[title*="challenge" i]').first().isVisible().catch(() => false);
                let screenshotB64: string | undefined;
                if (withShot) {
                    const buf = await p.screenshot({ type: "jpeg", quality: 45, timeout: 8000 }).catch(() => null);
                    screenshotB64 = buf ? buf.toString("base64") : undefined;
                }
                return { url: p.url(), lines, buttons, authPhone, authOtp, captcha, screenshotB64 };
            },
            clickLabel: (label) => this.clickLabel(label),
            back: async () => {
                const p = await this.ensure();
                await p.keyboard.press("Escape").catch(() => undefined);
                await p.goBack({ timeout: 8000 }).catch(() => undefined);
            },
            reopen: async () => {
                if (this.rideUrl) await this.open(this.rideUrl);
            },
            wait: async (ms) => {
                await (await this.ensure()).waitForTimeout(ms);
            },
        };
    }

    async recover(goal: OlaGoal, rideType: string, log: (e: RecoveryLogEntry) => void): Promise<RecoveryOutcome> {
        return recoverTo(this.recoveryPage(), goal, rideType, { classifier: geminiScreenClassifier, log, maxSteps: 6, maxMs: 45_000 });
    }

    async storageState(): Promise<string | null> {
        try {
            return this.ctx ? JSON.stringify(await this.ctx.storageState()) : null;
        } catch {
            return null;
        }
    }

    async close(): Promise<void> {
        await this.ctx?.close().catch(() => undefined);
        await this.browser?.close().catch(() => undefined);
        this.page = null;
        this.ctx = null;
        this.browser = null;
    }
}

/**
 * Scripted Ola screens for recovery tests (test numbers only): a popup, a reordered list, a renamed
 * button, an unknown screen, a captcha. Clicking a label moves to the next screen.
 */
type FakeScreen = { lines: string[]; buttons: string[]; on?: Record<string, string>; authPhone?: boolean; captcha?: boolean; reopen?: string };
export class FakeOlaScreens implements RecoveryPage {
    clicks: string[] = [];
    constructor(
        public at: string,
        private signedIn: () => boolean,
        private type: () => string,
    ) {}
    private screens(): Record<string, FakeScreen> {
        const types = ["Auto", "Mini", "Bike", "Prime Sedan", "Prime SUV"];
        const after = this.signedIn() ? "confirm" : "cont";
        const pick = Object.fromEntries(types.map((t) => [t, after]));
        return {
            list: { lines: ["AVAILABLE RIDES", ...types.flatMap((t) => [t, "4 min"])], buttons: types, on: pick },
            reordered: { lines: ["Choose a ride", "Prime SUV", "₹477", "Bike", "Zip through traffic", "Mini", "Comfy hatchbacks", "Auto", "Prime Sedan"], buttons: ["Prime SUV", "Bike", "Mini", "Auto", "Prime Sedan", "Offers"], on: pick },
            cont: { lines: ["Mini", "Comfy hatchbacks", "Continue"], buttons: ["Continue"], on: { Continue: "phone" } },
            cont_renamed: { lines: ["Mini", "Comfy hatchbacks", "Proceed"], buttons: ["Proceed", "Book for someone else"], on: { Proceed: "phone" } },
            phone: { lines: ["Enter your mobile number"], buttons: ["Next"], authPhone: true },
            confirm: { lines: ["PICKUP", "Rajiv Chowk Gate No.6", "DROP", "Delhi Airport T3", "FARE", "₹312", "PAY BY", "Cash", "Confirm & Book"], buttons: ["Confirm & Book", "Cash"] },
            popup: { lines: ["Get the Ola app", "Rides are faster on the app"], buttons: ["Install app", "Not now"], on: { "Not now": "list" } },
            banner: { lines: ["Big savings this festive season", "Tap to know more"], buttons: ["Know more", "Maybe later"], on: { "Maybe later": "list" } },
            unknown: { lines: ["Welcome back", "Plan your day"], buttons: ["Home", "Offers"], reopen: "list" },
            captcha: { lines: ["Please verify you are human"], buttons: ["Verify"], captcha: true },
        };
    }
    async snapshot(): Promise<ScreenSnapshot> {
        const sc = this.screens()[this.at]!;
        return { url: "https://book.olacabs.com/", lines: sc.lines, buttons: sc.buttons, authPhone: sc.authPhone, captcha: sc.captcha };
    }
    async clickLabel(label: string): Promise<boolean> {
        this.clicks.push(label);
        const sc = this.screens()[this.at]!;
        const to = sc.on?.[label];
        if (!sc.buttons.includes(label)) return false;
        if (to) this.at = to;
        return true;
    }
    async back(): Promise<void> {
        this.at = "list";
    }
    async reopen(): Promise<void> {
        this.at = this.screens()[this.at]?.reopen || "list";
    }
    async wait(): Promise<void> {}
}

/**
 * Scripted Ola for test numbers. Page state is derived from the booking time (so it survives a
 * restart like the real ride) and `timeScale` speeds the clock up for tests.
 *  assigned | timeout | ola_none | driver_cancel | cancel_fails_once | otp_fail | logged_in | book_fail
 */
const FAKE_BROKEN_START: Record<string, string> = {
    popup_once: "popup",
    banner: "banner",
    renamed_button: "cont_renamed",
    reordered: "reordered",
    unknown_screen: "unknown",
    captcha: "captcha",
};

export class FakeOlaDriver implements OlaDriver {
    readonly kind = "fake" as const;
    private signedIn: boolean;
    private chosenType = "Mini";
    private broken = true;
    private reads = 0;
    screens: FakeOlaScreens | null = null;
    private onConfirm = false;
    private cancelled = false;
    private labels = { pickup: "Rajiv Chowk Gate No.6", drop: "Delhi Airport T3" };
    constructor(
        private scenario: string,
        private timeScale: number,
        private ride: { bookedAt?: Date; cancelAttempts?: number } = {},
    ) {
        this.signedIn = scenario === "logged_in" || /_in$/.test(scenario);
    }
    private base(): string {
        return this.scenario.replace(/_in$/, "");
    }
    bind(ride: { bookedAt?: Date; cancelAttempts?: number }): void {
        this.ride = ride;
    }
    private elapsedSec(): number {
        return this.ride.bookedAt ? ((Date.now() - new Date(this.ride.bookedAt).getTime()) / 1000) * this.timeScale : 0;
    }
    async open(url: string): Promise<void> {
        // Echo the route like Ola does (it snaps the pickup to a nearby named point; the test copy keeps the name).
        try {
            const q = new URL(url).searchParams;
            this.labels = { pickup: q.get("pickup_name") || this.labels.pickup, drop: q.get("drop_name") || this.labels.drop };
        } catch {
            /* keep defaults */
        }
    }
    async rideTypes(): Promise<OlaRideType[]> {
        const f = (n: number) => (this.signedIn ? n : undefined);
        return [
            { name: "Auto", fare: f(356) },
            { name: "Mini", etaMin: 4, fare: f(312) },
            { name: "Bike", etaMin: 2, fare: f(199) },
            { name: "Prime Sedan", etaMin: 4, fare: f(322) },
            { name: "Prime SUV", etaMin: 1, fare: f(477) },
        ];
    }
    async loggedIn(): Promise<boolean> {
        return this.signedIn;
    }
    async choose(type = "Mini"): Promise<"login" | "confirm" | "failed"> {
        this.chosenType = type;
        // Page-changed scenarios: the fixed step fails once and recovery has to find its way.
        const start = FAKE_BROKEN_START[this.base()];
        if (start && this.broken) {
            this.broken = false;
            this.screens = new FakeOlaScreens(start, () => this.signedIn, () => this.chosenType);
            return "failed";
        }
        this.onConfirm = this.signedIn;
        return this.signedIn ? "confirm" : "login";
    }
    async recover(goal: OlaGoal, rideType: string, log: (e: RecoveryLogEntry) => void): Promise<RecoveryOutcome> {
        const pg = this.screens || new FakeOlaScreens("list", () => this.signedIn, () => this.chosenType);
        const out = await recoverTo(pg, goal, rideType, { classifier: geminiScreenClassifier, log, maxSteps: 6, maxMs: 20_000 });
        if (out.ok && out.screen === "confirm") this.onConfirm = true;
        return out;
    }
    async startLogin(): Promise<LoginStart> {
        return this.scenario === "otp_fail" ? "failed" : "otp_sent";
    }
    async submitOtp(code: string): Promise<OtpResult> {
        if (code === "0000") return "invalid";
        this.signedIn = true;
        this.onConfirm = true;
        return "confirm";
    }
    async readConfirm(vehicle: string): Promise<OlaConfirmInfo | null> {
        if (!this.onConfirm) return null;
        const fares: Record<string, number> = { Auto: 356, Mini: 312, Bike: 199, "Prime Sedan": 322, "Prime SUV": 477 };
        this.reads++;
        // fare_up: Ola's fare rises between the card and the booking tap (read 2 onwards).
        const up = this.base() === "fare_up" && this.reads >= 2 ? 40 : 0;
        // pickup_moved: Ola snaps the pickup elsewhere before the tap.
        const pickup = this.base() === "pickup_moved" && this.reads >= 2 ? "Palika Bazaar Gate 2" : this.labels.pickup;
        return { vehicle, pickup, drop: this.labels.drop, fare: (fares[vehicle] ?? 312) + up, pay: "Cash" };
    }
    async ensureCash(): Promise<CashResult> {
        if (this.base() === "no_cash") return { ok: false, reason: "no_cash_option", selected: "Ola Money", options: ["Ola Money", "UPI"] };
        if (this.base() === "cash_stuck") return { ok: false, reason: "select_failed", selected: "Ola Money", options: ["Ola Money", "Cash"] };
        return { ok: true, selected: "Cash", options: ["Ola Money", "Cash"] };
    }
    async book(): Promise<BookResult> {
        this.cancelled = false;
        return this.scenario === "book_fail" ? "failed" : "searching";
    }
    async status(): Promise<{ state: OlaPageState; driver?: OlaDriverInfo }> {
        if (this.cancelled) return { state: "cancelled" };
        const t = this.elapsedSec();
        const driver: OlaDriverInfo = { name: "Ramesh Kumar", vehicle: "White Swift Dzire", plate: "DL 1C AB 1234", etaMin: 6, otp: "4821" };
        const sc = FAKE_BROKEN_START[this.base()] || ["fare_up", "pickup_moved"].includes(this.base()) ? "assigned" : this.scenario;
        switch (sc) {
            case "assigned":
            case "logged_in":
                return t >= 60 ? { state: "assigned", driver } : { state: "searching" };
            case "ola_none":
                return t >= 90 ? { state: "no_driver" } : { state: "searching" };
            case "driver_cancel":
                return t >= 120 ? { state: "driver_cancelled" } : t >= 45 ? { state: "assigned", driver } : { state: "searching" };
            default:
                return { state: "searching" };
        }
    }
    async cancel(): Promise<boolean> {
        if (this.scenario === "cancel_fails_once" && (this.ride.cancelAttempts || 0) < 1) return false;
        this.cancelled = true;
        return true;
    }
    async reattach(): Promise<boolean> {
        return true;
    }
    async storageState(): Promise<string | null> {
        return null;
    }
    async close(): Promise<void> {}
}
