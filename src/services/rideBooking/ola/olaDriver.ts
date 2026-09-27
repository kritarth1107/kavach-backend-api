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

export type LoginStart = "otp_sent" | "failed" | "blocked";
export type OtpResult = "confirm" | "list" | "invalid" | "failed";
export type BookResult = "searching" | "assigned" | "unknown" | "failed";

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
    ensureCash(): Promise<boolean>;
    book(): Promise<BookResult>;
    status(): Promise<{ state: OlaPageState; driver?: OlaDriverInfo }>;
    /** Press Ola's own cancel control and verify on the page that it is cancelled. */
    cancel(): Promise<boolean>;
    /** Reopen the live ride after a restart (saved sign-in). */
    reattach(): Promise<boolean>;
    storageState(): Promise<string | null>;
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

export class PlaywrightOlaDriver implements OlaDriver {
    readonly kind = "real" as const;
    private browser: import("playwright").Browser | null = null;
    private ctx: import("playwright").BrowserContext | null = null;
    private page: import("playwright").Page | null = null;
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
        const raw = await p
            .evaluate<string[]>(DEEP_TEXT_JS)
            .catch(() => [] as string[]);
        return raw.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
    }

    private async seen(re: RegExp | string, exact = false): Promise<boolean> {
        const p = await this.ensure();
        return p.getByText(re, typeof re === "string" ? { exact } : undefined).first().isVisible().catch(() => false);
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
        const el = p.getByText(type, { exact: true }).first();
        if (!(await el.isVisible().catch(() => false))) return "failed";
        await el.click().catch(() => undefined);
        let kind: "login" | "confirm" | "failed" = "failed";
        // Signed out, Ola shows the ride page with a "Continue" button (fare hidden) that leads to sign-in.
        for (let step = 0; step < 2 && kind === "failed"; step++) {
            let cont = false;
            await this.waitFor(async () => {
                if (await this.seen(/confirm\s*&\s*book/i)) kind = "confirm";
                else if (/enter your mobile number/i.test(await this.authText()) || (await this.seen(/enter your mobile number/i))) kind = "login";
                else if (step === 0 && (await this.seen("Continue", true))) cont = true;
                return kind !== "failed" || cont;
            }, 15_000);
            if (kind !== "failed" || !cont) break;
            await p.getByText("Continue", { exact: true }).first().click({ timeout: 5000 }).catch(() => undefined);
        }
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
        const c = parseConfirm(await this.lines(), vehicle);
        return c.fare ? c : null;
    }

    async ensureCash(): Promise<boolean> {
        const c = parseConfirm(await this.lines(), "");
        if (/cash/i.test(c.pay || "")) return true;
        const p = await this.ensure();
        if (c.pay) await p.getByText(c.pay, { exact: true }).first().click({ timeout: 4000 }).catch(() => undefined);
        await p.getByText("Cash", { exact: true }).first().click({ timeout: 4000 }).catch(() => undefined);
        await p.waitForTimeout(1500);
        return /cash/i.test(parseConfirm(await this.lines(), "").pay || "");
    }

    async book(): Promise<BookResult> {
        const p = await this.ensure();
        await p.getByText(/confirm\s*&\s*book/i).first().click({ timeout: 6000 }).catch(() => undefined);
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
 * Scripted Ola for test numbers. Page state is derived from the booking time (so it survives a
 * restart like the real ride) and `timeScale` speeds the clock up for tests.
 *  assigned | timeout | ola_none | driver_cancel | cancel_fails_once | otp_fail | logged_in | book_fail
 */
export class FakeOlaDriver implements OlaDriver {
    readonly kind = "fake" as const;
    private signedIn: boolean;
    private onConfirm = false;
    private cancelled = false;
    constructor(
        private scenario: string,
        private timeScale: number,
        private ride: { bookedAt?: Date; cancelAttempts?: number } = {},
    ) {
        this.signedIn = scenario === "logged_in";
    }
    bind(ride: { bookedAt?: Date; cancelAttempts?: number }): void {
        this.ride = ride;
    }
    private elapsedSec(): number {
        return this.ride.bookedAt ? ((Date.now() - new Date(this.ride.bookedAt).getTime()) / 1000) * this.timeScale : 0;
    }
    async open(): Promise<void> {}
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
    async choose(): Promise<"login" | "confirm" | "failed"> {
        this.onConfirm = this.signedIn;
        return this.signedIn ? "confirm" : "login";
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
        return { vehicle, pickup: "Rajiv Chowk Gate No.6", drop: "Delhi Airport T3", fare: fares[vehicle] ?? 312, pay: "Cash" };
    }
    async ensureCash(): Promise<boolean> {
        return true;
    }
    async book(): Promise<BookResult> {
        return this.scenario === "book_fail" ? "failed" : "searching";
    }
    async status(): Promise<{ state: OlaPageState; driver?: OlaDriverInfo }> {
        if (this.cancelled) return { state: "cancelled" };
        const t = this.elapsedSec();
        const driver: OlaDriverInfo = { name: "Ramesh Kumar", vehicle: "White Swift Dzire", plate: "DL 1C AB 1234", etaMin: 6, otp: "4821" };
        switch (this.scenario) {
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
