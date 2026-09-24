/**
 * WhatsApp turns for Saheli private browsing / any-site order.
 * Elder + caregiver can start browse/order via browser when MCP missing or user asks
 * another site / pastes a product URL / says "any site".
 * OTP: user pastes SMS OTP in WhatsApp. Confirm before pay. No silent pay.
 * Soft health tips on confirm when care context matches cart (never diagnose / never block).
 */
import WhatsappSession from "../../models/whatsappSession.model";
import { FamilyRole } from "../../types/family.types";
import { notifyCaregivers } from "../saheliCaregiverAlert.service";
import { runBrowserTask, type BrowserTaskResult } from "./browserWorker.service";
import { resolvePlaybook, partnerLabel } from "./playbooks";
import type { CommercePartnerKey } from "./types";
import { beginOtpLogin } from "./sessionStore.service";
import {
    extractProductUrl,
    messageLooksLikeAnySiteBrowserOrder,
    resolveSiteFromMessage,
    siteKeyToPartnerKey,
} from "./siteResolve";

export type BrowserTaskPhase =
    | "idle"
    | "running"
    | "awaiting_otp"
    | "awaiting_confirm"
    | "done";

export type BrowserTaskDraft = {
    phase: BrowserTaskPhase;
    goal: string;
    partner?: CommercePartnerKey | "generic";
    siteKey?: string;
    startUrl?: string;
    otpChallengeId?: string;
    lastMessage?: string;
    confirm?: {
        items?: string[];
        totalLabel?: string;
        addressLabel?: string;
    };
    mode?: "playwright" | "dry_run";
};

const BROWSE_INTENT =
    /\b(open|browse|find|search|go\s+to|visit|look\s+up)\b/i;

/** Site-explicit browser orders only — Vit C / medicines go to pharmacy conversational path. */
const ORDER_VIA_BROWSER_LEGACY =
    /\b(order\s+.+\s+from\s+(apollo|pharmeasy|1\s*mg|tata|blinkit|amazon|flipkart|bigbasket|big\s*basket))\b/i;

const PharmacyLike =
    /\b(apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg)\b/i;

function partnerFromText(text: string): CommercePartnerKey | "generic" {
    const resolved = resolveSiteFromMessage(text, { forceBrowser: true });
    return siteKeyToPartnerKey(resolved.siteKey);
}

export function messageLooksLikeBrowserTask(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (messageLooksLikeAnySiteBrowserOrder(t)) return true;
    if (ORDER_VIA_BROWSER_LEGACY.test(t)) return true;
    if (extractProductUrl(t)) return true;
    if (BROWSE_INTENT.test(t) && t.split(/\s+/).length >= 3) return true;
    // Medicine / Vit C without an explicit "from <site>" URL → pharmacy path, not Playwright.
    if (/\border\b/i.test(t) && PharmacyLike.test(t) && /\bfrom\b/i.test(t)) return true;
    // Explicit force-browser for MCP partners
    if (
        /\b(via\s+browser|any\s*site|browse)\b/i.test(t) &&
        /\b(instamart|swiggy|zepto)\b/i.test(t)
    ) {
        return true;
    }
    return false;
}

async function loadDraft(phone: string): Promise<BrowserTaskDraft | null> {
    const row = await WhatsappSession.findOne({ phone }).lean();
    const raw = (row as { browserTaskDraft?: BrowserTaskDraft } | null)?.browserTaskDraft;
    return raw ?? null;
}

async function saveDraft(phone: string, draft: BrowserTaskDraft | null): Promise<void> {
    if (!draft) {
        await WhatsappSession.findOneAndUpdate(
            { phone },
            { $unset: { browserTaskDraft: 1, pendingCommerceOtp: 1 }, $set: { updatedAt: new Date() } },
        );
        return;
    }
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
        { phone },
        { $set: set, $unset: draft.phase === "awaiting_otp" ? {} : { pendingCommerceOtp: 1 } },
        { upsert: true },
    );
}

function applyResultToDraft(
    draft: BrowserTaskDraft,
    result: BrowserTaskResult,
): BrowserTaskDraft {
    draft.lastMessage = result.message;
    draft.mode = result.mode;
    if (result.confirm) draft.confirm = result.confirm;
    if (result.partner) {
        draft.partner = result.partner as CommercePartnerKey | "generic";
        draft.siteKey = result.partner;
    }
    if (result.url) draft.startUrl = result.url;
    if (result.status === "need_otp") draft.phase = "awaiting_otp";
    else if (result.status === "need_user_confirm") draft.phase = "awaiting_confirm";
    else if (result.status === "done") draft.phase = "done";
    else if (result.status === "error" || result.status === "cancelled") draft.phase = "idle";
    else draft.phase = "running";
    return draft;
}

/**
 * Handle private-browser WhatsApp turns for elder OR caregiver.
 * Returns reply text or null if not a browser-task turn.
 */
export async function handleBrowserTaskWhatsAppTurn(input: {
    phone: string;
    text: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
}): Promise<{ text: string; draft?: BrowserTaskDraft } | null> {
    const text = input.text.trim();
    let draft = await loadDraft(input.phone);

    if (/^(cancel|stop|never ?mind)$/i.test(text) && draft) {
        await saveDraft(input.phone, null);
        return { text: "Okay — cancelled the browsing task." };
    }

    // Re-kick browser after pharmacy/commerce soft failure (CAPTCHA / timeout / no OTP page)
    if (draft && (draft.phase === "awaiting_otp" || draft.phase === "awaiting_confirm") && /^(retry|try\s*again|again)$/i.test(text)) {
        const { notifyPharmacyBrowserBackgroundResult } = await import("./browserProgressNotify.service");
        const retryGoal = draft.goal;
        const retryPartner = draft.partner;
        const retryStartUrl = draft.startUrl;
        const retryChallenge = draft.otpChallengeId;
        const notifyPartner: import("./types").CommercePartnerKey | "generic" =
            retryPartner && retryPartner !== "generic"
                ? (retryPartner as import("./types").CommercePartnerKey)
                : "apollo";
        draft.phase = "running";
        draft.lastMessage = `Retrying *${partnerLabel(String(retryPartner || "the site"))}*…`;
        await saveDraft(input.phone, draft);

        const retryPhoneDigits = input.phone.replace(/\D/g, "");
        const retryLoginPhone =
            retryPhoneDigits.length === 10
                ? `+91${retryPhoneDigits}`
                : retryPhoneDigits.length >= 11
                  ? `+${retryPhoneDigits}`
                  : input.phone.startsWith("+")
                    ? input.phone
                    : `+${input.phone}`;
        const envN = Number(process.env.BROWSER_TASK_DEADLINE_MS);
        const retryDeadline = Math.min(
            Math.max(Number.isFinite(envN) && envN > 0 ? envN : 75_000, 60_000),
            90_000,
        );

        void (async () => {
            const { pushWhatsAppBrowserFollowUp } = await import("./browserProgressNotify.service");
            try {
                const result = await runBrowserTask({
                    familyId: input.familyId,
                    userId: input.actorUserId,
                    goal: /login_phone=/i.test(retryGoal)
                        ? retryGoal
                        : `${retryGoal} | login_phone=${retryLoginPhone}`,
                    partner: retryPartner,
                    startUrl: retryStartUrl,
                    deadlineMs: retryDeadline,
                    loginPhone: retryLoginPhone,
                    onProgress: async (_stage, detail) => {
                        if (!detail?.trim()) return;
                        await pushWhatsAppBrowserFollowUp({
                            phone: input.phone,
                            familyId: input.familyId,
                            recipientUserId: input.recipientUserId,
                            text: detail.trim(),
                        }).catch(() => undefined);
                    },
                });
                await notifyPharmacyBrowserBackgroundResult({
                    phone: input.phone,
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    goal: retryGoal,
                    partner: notifyPartner,
                    otpChallengeId: retryChallenge,
                    result,
                });
            } catch (err) {
                console.warn(
                    "browser retry background failed:",
                    err instanceof Error ? err.message : err,
                );
            }
        })();

        return {
            text:
                `Retrying *${partnerLabel(String(retryPartner || "the site"))}*…\n` +
                `Watch for stage updates (still opening… / on login page…), then paste the OTP if asked.\n` +
                `Reply *cancel* to stop.`,
            draft,
        };
    }

    if (draft && draft.phase === "awaiting_otp" && /^\d{4,8}$/.test(text)) {
        const otpPhoneDigits = input.phone.replace(/\D/g, "");
        const otpLoginPhone =
            otpPhoneDigits.length === 10
                ? `+91${otpPhoneDigits}`
                : otpPhoneDigits.length >= 11
                  ? `+${otpPhoneDigits}`
                  : input.phone.startsWith("+")
                    ? input.phone
                    : `+${input.phone}`;
        const result = await runBrowserTask({
            familyId: input.familyId,
            userId: input.actorUserId,
            goal: draft.goal,
            partner: draft.partner,
            startUrl: draft.startUrl,
            otp: text,
            loginPhone: otpLoginPhone,
            deadlineMs: Math.min(
                Math.max(Number(process.env.BROWSER_TASK_DEADLINE_MS) || 75_000, 45_000),
                90_000,
            ),
        });
        draft = applyResultToDraft(draft, result);
        if (draft.phase === "done") {
            await saveDraft(input.phone, null);
            await maybeNotifyCaregivers(input, draft, result);
            return { text: result.message, draft };
        }
        await saveDraft(input.phone, draft);
        return { text: result.message, draft };
    }

    if (draft && draft.phase === "awaiting_confirm" && /^(confirm|place|yes|haan|ok|pay)$/i.test(text)) {
        const result = await runBrowserTask({
            familyId: input.familyId,
            userId: input.actorUserId,
            goal: draft.goal,
            partner: draft.partner,
            startUrl: draft.startUrl,
            userConfirmed: true,
        });
        draft = applyResultToDraft(draft, result);
        await maybeNotifyCaregivers(input, draft, result);
        if (draft.phase === "done" || result.status === "done") {
            await saveDraft(input.phone, null);
        } else {
            await saveDraft(input.phone, draft);
        }
        return { text: result.message, draft };
    }

    if (draft && draft.phase === "awaiting_confirm") {
        return {
            text:
                draft.lastMessage ||
                "Reply *confirm* to continue checkout (item + total + address), or *cancel*.",
            draft,
        };
    }

    if (draft && draft.phase === "awaiting_otp") {
        return {
            text:
                draft.lastMessage ||
                `${partnerLabel(String(draft.partner || "the site"))} texted a code — paste the SMS OTP here.`,
            draft,
        };
    }

    const starting = messageLooksLikeBrowserTask(text);
    if (!starting && !(draft && draft.phase !== "idle" && draft.phase !== "done")) {
        return null;
    }

    if (starting) {
        const resolved = resolveSiteFromMessage(text, { forceBrowser: true });
        const partner = partnerFromText(text);
        const playbook = resolvePlaybook(partner, text, resolved.startUrl);
        draft = {
            phase: "running",
            goal: text.slice(0, 240),
            partner: playbook.partner,
            siteKey: playbook.siteKey,
            startUrl: playbook.startUrl,
        };
        if (draft.partner && draft.partner !== "generic" && draft.partner !== "generic_grocery") {
            const challenge = `browser-${draft.partner}-${Date.now()}`;
            draft.otpChallengeId = challenge;
            await beginOtpLogin({
                userId: input.actorUserId,
                partner: draft.partner as CommercePartnerKey,
                otpChallengeId: challenge,
            }).catch(() => undefined);
        }

        const result = await runBrowserTask({
            familyId: input.familyId,
            userId: input.actorUserId,
            goal: draft.goal,
            partner: draft.partner,
            startUrl: draft.startUrl,
        });
        draft = applyResultToDraft(draft, result);
        await saveDraft(input.phone, draft.phase === "done" ? null : draft);
        if (result.status === "done") {
            await maybeNotifyCaregivers(input, draft, result);
        }
        return { text: result.message, draft };
    }

    return null;
}

async function maybeNotifyCaregivers(
    input: {
        familyId: string;
        actorUserId: string;
        recipientUserId: string;
        actorRole: FamilyRole | null;
    },
    draft: BrowserTaskDraft,
    result: BrowserTaskResult,
): Promise<void> {
    if (input.actorRole !== FamilyRole.CARE_RECIPIENT) return;
    if (result.status !== "done" && draft.phase !== "done") return;
    const label = partnerLabel(String(draft.partner || result.partner || "web"));
    void notifyCaregivers({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: `Amma used Saheli browse on ${label} — ${draft.goal.slice(0, 100)}. Notify only — no approval needed.`,
        urgency: "low",
        kind: "order_placed",
    });
}
