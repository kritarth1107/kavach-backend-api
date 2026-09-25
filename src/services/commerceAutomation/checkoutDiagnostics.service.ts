/**
 * Last-failure snapshot of a pharmacy checkout screen (URL, title, trimmed visible text, and a
 * masked JPEG screenshot). Logged under [pharmacy-checkout] (text only) and kept in memory per
 * family/user for 2 h so the mock peek can show it. Phone numbers and OTP-like codes are
 * redacted from the text; phone inputs / phone-number text are masked in the screenshot.
 */
import type { Page } from "playwright";
import { browserSessionKey } from "./parkedOtpSession.service";

export type CheckoutDiagnostic = {
    at: string;
    flow: "checkout" | "post_otp";
    stage: string;
    reason: string;
    url: string;
    title: string;
    /** Visible text of the top dialog (if any) else the page body, whitespace-collapsed. */
    text: string;
    screenshotJpegBase64?: string;
    screenshotBytes?: number;
};

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_SHOT_BYTES = 450_000;
const last = new Map<string, CheckoutDiagnostic>();

export function redactDiagText(s: string): string {
    return (s || "")
        .replace(/(\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]")
        .replace(/\b(otp|code|pin)\b([^0-9\n]{0,24})\b\d{4,8}\b/gi, "$1$2[redacted]")
        .replace(/\b\d{11,}\b/g, "[number]");
}

function redactUrl(u: string): string {
    try {
        const url = new URL(u);
        const keep = new URLSearchParams();
        for (const [k, v] of url.searchParams) if (/^(view|popup_state)$/i.test(k)) keep.set(k, v);
        const q = keep.toString();
        return `${url.origin}${url.pathname}${q ? `?${q}` : ""}`;
    } catch {
        return "";
    }
}

export async function captureCheckoutDiagnostic(
    page: Page | undefined | null,
    meta: { familyId?: string; userId?: string; recipientUserId?: string; flow: CheckoutDiagnostic["flow"]; stage: string; reason: string },
): Promise<CheckoutDiagnostic | null> {
    if (!page) return null;
    try {
        if (page.isClosed()) return null;
    } catch {
        return null;
    }
    let url = "";
    try {
        url = redactUrl(page.url());
    } catch {
        /* ignore */
    }
    const title = await page.title().catch(() => "");
    const text = await page
        .evaluate(() => {
            const dialogs = Array.from(
                document.querySelectorAll('[role="dialog"], [class*="modal" i], [class*="Modalbox" i], [class*="drawer" i]'),
            ).filter((e) => {
                const r = (e as HTMLElement).getBoundingClientRect();
                return r.width > 120 && r.height > 80;
            }) as HTMLElement[];
            const top = dialogs[dialogs.length - 1];
            const body = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
            const dlg = top ? (top.innerText || "").replace(/\s+/g, " ").trim() : "";
            return dlg ? `[dialog] ${dlg.slice(0, 1200)} ||| [page] ${body.slice(0, 1200)}` : body.slice(0, 2400);
        })
        .catch(() => "");
    let shot: Buffer | null = null;
    try {
        shot = await page.screenshot({
            type: "jpeg",
            quality: 55,
            fullPage: false,
            timeout: 6_000,
            animations: "disabled",
            mask: [
                page.locator('input[type="tel"], input[name*="contact" i], input[name*="phone" i], input[name*="mobile" i], input[autocomplete="one-time-code"]'),
                page.getByText(/(\+91[\s-]?)?[6-9]\d{9}/),
            ],
        });
    } catch {
        shot = null;
    }
    const diag: CheckoutDiagnostic = {
        at: new Date().toISOString(),
        flow: meta.flow,
        stage: meta.stage,
        reason: redactDiagText(meta.reason).slice(0, 300),
        url,
        title: redactDiagText(title).slice(0, 120),
        text: redactDiagText(text).slice(0, 2400),
        screenshotJpegBase64: shot && shot.length <= MAX_SHOT_BYTES ? shot.toString("base64") : undefined,
        screenshotBytes: shot?.length,
    };
    try {
        console.log(
            `[pharmacy-checkout] diag ${JSON.stringify({
                flow: diag.flow,
                stage: diag.stage,
                reason: diag.reason,
                url: diag.url,
                title: diag.title,
                text: diag.text.slice(0, 1500),
                screenshotBytes: diag.screenshotBytes ?? 0,
            })}`,
        );
    } catch {
        /* ignore */
    }
    if (meta.familyId && meta.userId) last.set(browserSessionKey(meta.familyId, meta.userId), diag);
    if (meta.familyId && meta.userId) {
        // Caregiver dashboard (activity feed) — never WhatsApp. Small screenshots only.
        void import("../activityLog.service").then(({ logActivity }) =>
            logActivity({
                familyId: meta.familyId,
                recipientUserId: meta.recipientUserId || meta.userId,
                actorUserId: meta.userId,
                kind: "diag",
                severity: "warn",
                title: `Browser diagnostic: ${diag.flow}/${diag.stage}`,
                detail: `${diag.reason}\n${diag.title}\n${diag.text.slice(0, 1500)}`,
                data: {
                    stage: diag.stage,
                    url: diag.url,
                    screenshotDataUrl:
                        diag.screenshotJpegBase64 && (diag.screenshotBytes ?? 0) <= 200_000
                            ? `data:image/jpeg;base64,${diag.screenshotJpegBase64}`
                            : undefined,
                },
            }),
        );
    }
    return diag;
}

export function getLastCheckoutDiagnostic(familyId: string, userId: string): CheckoutDiagnostic | null {
    const key = browserSessionKey(familyId, userId);
    const d = last.get(key);
    if (!d) return null;
    if (Date.now() - Date.parse(d.at) > TTL_MS) {
        last.delete(key);
        return null;
    }
    return d;
}
