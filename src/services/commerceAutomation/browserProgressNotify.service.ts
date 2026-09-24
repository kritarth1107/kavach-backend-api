/**
 * Push private-browser progress to WhatsApp after an async kick.
 * Pharmacy confirm used to fire-and-forget runBrowserTask — result never reached WA
 * (silence after "Opening Apollo…"). This helper always delivers a follow-up within the
 * browser deadline (~30–60s SLA): OTP tip, confirm card, CAPTCHA/block, or soft failure.
 */
import { isMetaWhatsAppEnabled, sendViaMetaWhatsApp } from "../../clients/metaWhatsApp.client";
import WhatsappSession from "../../models/whatsappSession.model";
import { deliverOutboundMessage } from "../channelOutbound.service";
import type { BrowserTaskResult } from "./browserWorker.service";
import { partnerLabel } from "./playbooks";
import type { CommercePartnerKey } from "./types";
import {
    isBrowserGenerationCurrent,
    shouldSuppressDuplicateOtpAsk,
} from "./parkedOtpSession.service";

export type BrowserTaskDraftPatch = {
    phase: "idle" | "running" | "awaiting_otp" | "awaiting_confirm" | "done";
    goal: string;
    partner?: CommercePartnerKey | "generic";
    otpChallengeId?: string;
    lastMessage?: string;
    confirm?: BrowserTaskResult["confirm"];
    mode?: "playwright" | "dry_run";
    startUrl?: string;
};

/** Pure — build the WA follow-up after background browser work (also used by smoke). */
export function formatPharmacyBrowserFollowUp(
    result: BrowserTaskResult,
    opts?: { partner?: string; goal?: string },
): { text: string; clearSession: boolean; phase: BrowserTaskDraftPatch["phase"] } {
    const label = partnerLabel(String(result.partner || opts?.partner || "pharmacy"));
    const goalHint = (opts?.goal || "").slice(0, 80);

    if (result.status === "need_user_confirm") {
        return {
            text: result.message,
            clearSession: false,
            phase: "awaiting_confirm",
        };
    }

    if (result.status === "done") {
        return {
            text: result.message,
            clearSession: true,
            phase: "done",
        };
    }

    if (result.status === "cancelled") {
        return {
            text: result.message || "Okay — cancelled the medicine order.",
            clearSession: true,
            phase: "idle",
        };
    }

    if (result.status === "error") {
        const base = result.message?.trim() || `${label} browser hit a problem.`;
        const reason = result.failureReason;
        const blocked =
            reason === "captcha" || /captcha|bot check|blocked|access denied/i.test(base);
        const tip =
            reason === "captcha" || blocked
                ? `${label} looks blocked (CAPTCHA / bot wall).`
                : reason === "disabled"
                  ? `${label} login is temporarily paused (OTP send disabled).`
                  : reason === "no_login_button"
                    ? `${label} loaded but Login / phone field wasn't found.`
                    : reason === "chromium_crash"
                      ? `${label} browser crashed (Chromium).`
                      : reason === "busy"
                        ? `${label} timed out while the browser was busy.`
                        : reason === "site_slow"
                          ? `${label} was too slow to show the login-code screen.`
                          : `${label} didn't finish opening the order.`;
        // site_slow / no_login / captcha / crash: SMS was NOT reliably requested — don't ask for OTP
        const smsNeverExpected =
            reason === "disabled" ||
            reason === "site_slow" ||
            reason === "no_login_button" ||
            reason === "captcha" ||
            reason === "chromium_crash" ||
            reason === "busy" ||
            /didn't send a login code|couldn't tap Continue|No SMS is expected|login paused/i.test(
                base,
            );
        return {
            text: [
                tip,
                base.slice(0, 220),
                ``,
                `Nothing was ordered or paid.`,
                `Reply *retry* to try again, or *cancel* to stop.`,
            ].join("\n"),
            // Keep draft (except kill-switch) so *retry* still works; phase awaiting_otp
            // is gated in WA handler — digits ignored unless OTP was actually requested/parked.
            clearSession: reason === "disabled",
            phase: reason === "disabled" ? "idle" : "awaiting_otp",
        };
    }

    // need_otp / running
    if (result.mode === "dry_run") {
        return {
            text: [
                `*${label}* login stub (dry-run on this host) — paste any *4–6 digit* code to continue to confirm-before-pay.`,
                goalHint ? `(Basket: ${goalHint})` : "",
                ``,
                `Reply *cancel* to stop.`,
            ]
                .filter(Boolean)
                .join("\n"),
            clearSession: false,
            phase: "awaiting_otp",
        };
    }

    // Deadline / never reached OTP page (steps === 0) vs real OTP wait
    if (!result.steps || result.steps <= 0) {
        const reason = result.failureReason;
        const head =
            reason === "captcha"
                ? `*${label}* hit a CAPTCHA / bot wall before login.`
                : reason === "no_login_button"
                  ? `*${label}* loaded but Login / phone field wasn't found.`
                  : reason === "chromium_crash"
                    ? `*${label}* browser crashed before the login-code step.`
                    : reason === "busy"
                      ? `*${label}* timed out — browser was busy with another task.`
                      : reason === "site_slow"
                        ? `*${label}* was too slow to show the login-code screen.`
                        : `*${label}* didn't reach the login-code step in time (site slow or login UI not reached).`;
        return {
            text: [
                head,
                `No SMS from ${label} is expected until login actually starts.`,
                result.message && !/didn't (reach|finish)/i.test(result.message)
                    ? result.message.slice(0, 180)
                    : "",
                ``,
                `Reply *retry* to try again, or *cancel* to stop.`,
            ]
                .filter(Boolean)
                .join("\n"),
            clearSession: false,
            phase: "awaiting_otp",
        };
    }

    return {
        text: [
            result.message?.includes("paste")
                ? result.message
                : [
                      `*${label}* is waiting for your login code — *paste the SMS OTP here*.`,
                      `(I never read your device SMS — only what you send me on WhatsApp.)`,
                  ].join("\n"),
            ``,
            `No code yet? Check the SMS thread from ${label}, then reply *retry* or *cancel*.`,
            `No silent pay — I'll ask you to confirm item+total+address before checkout.`,
        ].join("\n"),
        clearSession: false,
        phase: "awaiting_otp",
    };
}

export async function pushWhatsAppBrowserFollowUp(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    text: string;
}): Promise<boolean> {
    const text = input.text.trim();
    if (!text) return false;
    try {
        if (isMetaWhatsAppEnabled()) {
            await sendViaMetaWhatsApp(input.phone, text);
            return true;
        }
        const delivery = await deliverOutboundMessage({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            content: text,
            channel: "whatsapp",
            channelIdentifier: input.phone,
            whatsappPayloads: [{ type: "text", text: { body: text } }],
        });
        return delivery.delivered;
    } catch (err) {
        console.warn(
            "browser WA follow-up failed:",
            err instanceof Error ? err.message : err,
        );
        return false;
    }
}

/**
 * After pharmacy confirm's background runBrowserTask resolves: update session draft + WA push.
 * Never throws — caller may void this.
 */
export async function notifyPharmacyBrowserBackgroundResult(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    goal: string;
    partner: CommercePartnerKey | "generic";
    otpChallengeId?: string;
    result: BrowserTaskResult;
    browserGeneration?: number;
}): Promise<void> {
    const follow = formatPharmacyBrowserFollowUp(input.result, {
        partner: input.partner,
        goal: input.goal,
    });

    if (follow.clearSession) {
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $unset: { browserTaskDraft: 1, pendingCommerceOtp: 1, pharmacyDraft: 1 },
                $set: { updatedAt: new Date() },
            },
        ).catch(() => undefined);
    } else {
        const draft: BrowserTaskDraftPatch = {
            phase: follow.phase,
            goal: input.goal,
            partner: (input.result.partner as CommercePartnerKey | "generic") || input.partner,
            otpChallengeId: input.otpChallengeId,
            lastMessage: follow.text,
            confirm: input.result.confirm,
            mode: input.result.mode,
            startUrl: input.result.url,
        };
        const set: Record<string, unknown> = {
            browserTaskDraft: draft,
            updatedAt: new Date(),
        };
        if (draft.phase === "awaiting_otp" && draft.partner && draft.partner !== "generic") {
            set.pendingCommerceOtp = {
                partner: draft.partner,
                challengeId: draft.otpChallengeId,
            };
        }
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $set: set,
                ...(draft.phase === "awaiting_otp" ? {} : { $unset: { pendingCommerceOtp: 1 } }),
            },
            { upsert: true },
        ).catch(() => undefined);
    }

    // Suppress late OTP asks after cancel / duplicate floods
    if (
        input.browserGeneration != null &&
        !isBrowserGenerationCurrent(input.familyId, input.actorUserId, input.browserGeneration)
    ) {
        console.warn("suppress browser follow-up — generation stale (cancelled)");
        return;
    }
    if (shouldSuppressDuplicateOtpAsk(input.familyId, input.actorUserId, follow.text)) {
        console.warn("suppress duplicate OTP ask follow-up");
        return;
    }
    // Disabled login: clear drafts so cancel/OTP loop cannot continue
    if (input.result.failureReason === "disabled") {
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $unset: { browserTaskDraft: 1, pendingCommerceOtp: 1, pharmacyDraft: 1 },
                $set: { updatedAt: new Date() },
            },
        ).catch(() => undefined);
    }
    await pushWhatsAppBrowserFollowUp({
        phone: input.phone,
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        text: follow.text,
    });
}
