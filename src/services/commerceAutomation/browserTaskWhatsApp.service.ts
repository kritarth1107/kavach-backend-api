/**
 * WhatsApp turns for Saheli private browsing / browser_task.
 * Elder + caregiver can start browse/order via browser when MCP missing or user asks.
 * OTP: user pastes SMS OTP in WhatsApp. Confirm before pay. No silent pay.
 */
import WhatsappSession from "../../models/whatsappSession.model";
import { FamilyRole } from "../../types/family.types";
import { notifyCaregivers } from "../saheliCaregiverAlert.service";
import { runBrowserTask, type BrowserTaskResult } from "./browserWorker.service";
import { resolvePlaybook, partnerLabel } from "./playbooks";
import type { CommercePartnerKey } from "./types";
import { beginOtpLogin } from "./sessionStore.service";

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

const ORDER_VIA_BROWSER =
    /\b(order\s+.+\s+from\s+(apollo|pharmeasy|1\s*mg|tata|instamart|blinkit|zepto|swiggy)|order\s+vit(?:amin)?\s*c|order\s+medicines?|dawai\s+(mangao|order))\b/i;

const ApolloLike =
    /\b(apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg|instamart|blinkit)\b/i;

function partnerFromText(text: string): CommercePartnerKey | "generic" | undefined {
    const t = text.toLowerCase();
    if (/\bapollo\b/.test(t)) return "apollo";
    if (/\bpharm\s*easy|pharmeasy\b/.test(t)) return "pharmeasy";
    if (/\b1\s*mg|tata\b/.test(t)) return "tata_1mg";
    if (/\binstamart\b/.test(t)) return "instamart";
    if (/\bblinkit\b/.test(t)) return "blinkit";
    if (/\bzepto\b/.test(t)) return "zepto";
    if (/\bswiggy\b/.test(t)) return "swiggy";
    return undefined;
}

export function messageLooksLikeBrowserTask(text: string): boolean {
    const t = text.trim();
    if (ORDER_VIA_BROWSER.test(t)) return true;
    if (BROWSE_INTENT.test(t) && t.split(/\s+/).length >= 3) return true;
    // "order vit c from apollo" without "medicines"
    if (/\border\b/i.test(t) && ApolloLike.test(t)) return true;
    if (/\bvit(?:amin)?\s*c\b/i.test(t) && ApolloLike.test(t)) return true;
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
    await WhatsappSession.findOneAndUpdate({ phone }, { $set: set, $unset: draft.phase === "awaiting_otp" ? {} : { pendingCommerceOtp: 1 } }, { upsert: true });
}

function applyResultToDraft(
    draft: BrowserTaskDraft,
    result: BrowserTaskResult,
): BrowserTaskDraft {
    draft.lastMessage = result.message;
    draft.mode = result.mode;
    if (result.confirm) draft.confirm = result.confirm;
    if (result.partner && result.partner !== "generic") {
        draft.partner = result.partner as CommercePartnerKey | "generic";
    }
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

    // Mid-flow OTP paste
    if (draft && draft.phase === "awaiting_otp" && /^\d{4,8}$/.test(text)) {
        const result = await runBrowserTask({
            familyId: input.familyId,
            userId: input.actorUserId,
            goal: draft.goal,
            partner: draft.partner,
            otp: text,
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

    // Mid-flow confirm
    if (draft && draft.phase === "awaiting_confirm" && /^(confirm|place|yes|haan|ok|pay)$/i.test(text)) {
        const result = await runBrowserTask({
            familyId: input.familyId,
            userId: input.actorUserId,
            goal: draft.goal,
            partner: draft.partner,
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

    // Start new task?
    const starting = messageLooksLikeBrowserTask(text);
    if (!starting && !(draft && draft.phase !== "idle" && draft.phase !== "done")) {
        return null;
    }

    if (starting) {
        const partner = partnerFromText(text) ?? resolvePlaybook(undefined, text).partner;
        draft = {
            phase: "running",
            goal: text.slice(0, 240),
            partner: partner === "generic" ? partner : (partner as CommercePartnerKey),
        };
        if (draft.partner && draft.partner !== "generic") {
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
    // Caregiver self-orders: no elder notify required unless useful (skip).
    // Elder places: caregivers notify-only.
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
