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
import {
    runBrowserTask,
    submitParkedBrowserOtp,
    continueParkedCheckout,
    CHECKOUT_BUDGET_MS,
    type BrowserTaskResult,
} from "./browserWorker.service";
import {
    abortBrowserSessionForUser,
    beginBrowserGeneration,
    isBrowserGenerationCurrent,
    shouldSuppressDuplicateOtpAsk,
    clearOtpAskDedupe,
    hasParkedBrowserOtpSession,
    queuePendingBrowserOtp,
    claimGotCodeAck,
    currentBrowserGeneration,
    hasPharmacyOtpSendBeenClaimed,
    peekParkedCheckout,
    claimCheckoutInFlight,
    isCheckoutInFlight,
    releaseCheckoutInFlight,
} from "./parkedOtpSession.service";
import { resolvePlaybook, partnerLabel } from "./playbooks";
import type { CommercePartnerKey } from "./types";
import { beginOtpLogin } from "./sessionStore.service";
import {
    extractProductUrl,
    messageLooksLikeAnySiteBrowserOrder,
    resolveSiteFromMessage,
    siteKeyToPartnerKey,
} from "./siteResolve";
import { shouldPreferBrowserForPartner } from "./commerceBrowserFirst";

export type BrowserTaskPhase =
    | "idle"
    | "awaiting_sku_confirm"
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
    /** Delivery address shown at confirm / passed into browser goal. */
    addressLabel?: string;
    /** Guest-search SKU options shown before login. */
    catalogOptions?: Array<{
        id: string;
        name: string;
        pricePaise?: number;
        productUrl?: string;
    }>;
    selectedSku?: {
        id: string;
        name: string;
        pricePaise?: number;
        productUrl?: string;
    };
    confirm?: {
        items?: string[];
        totalLabel?: string;
        addressLabel?: string;
        /** Parked signed-in checkout page this card belongs to (confirm only this card). */
        cardId?: string;
    };
    mode?: "playwright" | "dry_run";
};

const BROWSE_INTENT =
    /\b(open|browse|find|search|go\s+to|visit|look\s+up)\b/i;

/** Site-explicit browser orders only — Vit C / medicines go to pharmacy conversational path. */
const ORDER_VIA_BROWSER_LEGACY =
    /\b(order\s+.+\s+from\s+(apollo|pharmeasy|1\s*mg|tata|blinkit|amazon|flipkart|bigbasket|big\s*basket|instamart|swiggy|zepto|zomato))\b/i;

const PharmacyLike =
    /\b(apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg)\b/i;

function partnerFromText(text: string): CommercePartnerKey | "generic" {
    const resolved = resolveSiteFromMessage(text, { forceBrowser: true });
    return siteKeyToPartnerKey(resolved.siteKey);
}


function toLoginPhoneE164(phone: string): string {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length >= 11) return `+${digits}`;
    return phone.startsWith("+") ? phone : `+${phone}`;
}

const ELECTRONICS_REFUSE =
    /\b(iphones?|ipads?|macbooks?|laptops?|airpods|playstations?|ps5|xbox(?:es)?|televisions?|tvs?|samsung\s*galaxy|oneplus|pixel\s*phones?)\b/i;

function refuseElectronicsBrowser(): string {
    return (
        "For phones or big electronics, say *order … from amazon* / *flipkart* (or paste a product link) — " +
        "Instamart/Swiggy/Zepto/Blinkit/Zomato are for groceries & food. " +
        "Or ask for milk, veggies, a meal, or medicines (Apollo/PharmEasy/1mg)."
    );
}

function formatInr(paise?: number): string {
    if (typeof paise !== "number" || !Number.isFinite(paise)) return "";
    const rupees = paise / 100;
    return Number.isInteger(rupees) ? `₹${rupees}` : `₹${rupees.toFixed(2)}`;
}

/** Extract item query from "order X from Y" style goals. */
function extractOrderQuery(text: string, partner: string): string {
    let q = text
        .replace(
            new RegExp(
                `\\b(?:from|on|via|at|using|with)\\s+${partner.replace(/_/g, "\\s*")}\\b`,
                "ig",
            ),
            " ",
        )
        .replace(
            /\b(order|buy|get|purchase|shop|browse|find|search|open|please|for|me|the|a|an)\b/gi,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
    return q.slice(0, 80) || text.slice(0, 80);
}

function skuConfirmCopy(draft: BrowserTaskDraft): string {
    const label = partnerLabel(String(draft.partner || "the site"));
    const opts = draft.catalogOptions ?? [];
    const addr = draft.addressLabel
        ? `Deliver to: ${draft.addressLabel}`
        : "";
    if (opts.length > 1) {
        const lines = opts.slice(0, 3).map((o, i) => {
            const price = formatInr(o.pricePaise);
            return `${i + 1}. ${o.name}${price ? ` — ${price}` : ""}`;
        });
        return [
            `Found on *${label}*:`,
            ...lines,
            ``,
            addr,
            `Reply *1* / *2* / *3*, or *confirm* for #1 — login/OTP only after you pick.`,
            `Prefer *COD* at checkout — I'll still ask confirm-before-pay.`,
            `Or send another name. Reply *cancel* to stop.`,
        ]
            .filter(Boolean)
            .join("\n");
    }
    const sku = draft.selectedSku || opts[0];
    if (sku) {
        const price = formatInr(sku.pricePaise);
        return [
            `Found on *${label}*:`,
            `• ${sku.name}${price ? ` — ${price}` : ""}`,
            ``,
            addr,
            `Reply *confirm* to order this (login/OTP next), or send another name / *cancel*.`,
            `Prefer *COD* at checkout — I'll still ask confirm-before-pay.`,
        ]
            .filter(Boolean)
            .join("\n");
    }
    return (
        draft.lastMessage ||
        `I couldn't get a live guest price for *${label}* yet. Reply *confirm* to open the site (login/OTP may be asked), or *cancel*. Prefer *COD* — confirm-before-pay either way.`
    );
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
    // Browser-first partners (default ON): Instamart / Swiggy / Zepto / Blinkit / Zomato
    if (
        /\b(order|buy|get|purchase|shop)\b/i.test(t) &&
        /\b(instamart|swiggy|zepto|blinkit|zomato)\b/i.test(t)
    ) {
        const partner = partnerFromText(t);
        if (partner !== "generic" && shouldPreferBrowserForPartner(partner)) return true;
        // Blinkit/Zomato always browser (no MCP); catch even if flag list trimmed
        if (partner === "blinkit" || partner === "zomato") return true;
    }
    // Explicit force-browser for MCP partners (when flag off)
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
            { $unset: { browserTaskDraft: 1, pendingCommerceOtp: 1, pharmacyDraft: 1 }, $set: { updatedAt: new Date() } },
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

    if (/^(cancel|stop|never ?mind|cancel all(?: browsing)?)$/i.test(text) && (draft || /cancel\s+all/i.test(text))) {
        await abortBrowserSessionForUser(input.familyId, input.actorUserId, { phone: input.phone });
        clearOtpAskDedupe(input.familyId, input.actorUserId);
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $unset: { browserTaskDraft: 1, pendingCommerceOtp: 1, pharmacyDraft: 1 },
                $set: { updatedAt: new Date() },
            },
        );
        if (isCheckoutInFlight(input.familyId, input.actorUserId)) {
            return {
                text:
                    "Stopping the Apollo checkout now. If Apollo had already accepted the order I'll tell you here — " +
                    "otherwise nothing was ordered or paid.",
            };
        }
        return { text: "Okay — cancelled. Nothing was ordered or paid — no more OTP asks from this attempt." };
    }

    // "order again" after an expired signed-in session → fresh guest search card for the SAME
    // SKU. Login/OTP only starts after the user confirms that card (never silently).
    if (draft && /^(order\s*again|re-?order|start\s*again)$/i.test(text)) {
        const restarted = await restartOrderFromDraft(input, draft);
        if (restarted) return restarted;
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

        const browserGeneration = beginBrowserGeneration(input.familyId, input.actorUserId);
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
                    browserGeneration,
                    onProgress: async (_stage, detail) => {
                        if (!detail?.trim()) return;
                        if (!isBrowserGenerationCurrent(input.familyId, input.actorUserId, browserGeneration)) {
                            return;
                        }
                        if (shouldSuppressDuplicateOtpAsk(input.familyId, input.actorUserId, detail)) {
                            return;
                        }
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
                    browserGeneration,
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

    // OTP paste: ONLY pure 4–8 digits while awaiting_otp AND SMS was actually requested
    // (parked page or Continu/Send claimed). Never from order text / empty park / soft failures.
    if (draft && draft.phase === "awaiting_otp" && /^\d{4,8}$/.test(text)) {
        const gen = currentBrowserGeneration(input.familyId, input.actorUserId);
        const parked = hasParkedBrowserOtpSession(input.familyId, input.actorUserId);
        const sendClaimed = hasPharmacyOtpSendBeenClaimed(input.familyId, input.actorUserId, gen);
        if (!parked && !sendClaimed) {
            return {
                text:
                    "I don't have a login-code screen open yet (or the last attempt didn't request an SMS). " +
                    "Reply *retry* to open again, or *cancel* — don't paste a code until I ask.",
                draft,
            };
        }
        const ackOnce = claimGotCodeAck(input.familyId, input.actorUserId, gen);
        const ackText = "Got the code — signing in…";

        // Fast path: inject into parked live page (never relaunch → never re-Send OTP)
        if (parked) {
            draft.lastMessage = ackText;
            draft.phase = "running";
            await saveDraft(input.phone, draft);
            // Meta webhook retries (same digits) must not drive the page twice; a NEW code
            // after "wrong/expired code" must (claimGotCodeAck is per-generation only).
            const drive = claimParkedOtpDrive(input.familyId, input.actorUserId, text);
            if (drive) {
                void runParkedOtpContinuation({
                    phone: input.phone,
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    otp: text,
                    draft: { ...draft },
                });
            }
            // Duplicate inbound (Meta retry) after first ACK: short noop
            if (!drive || !ackOnce) {
                return { text: drive ? "Trying that code…" : "Still signing in with that code…", draft };
            }
            return { text: ackText, draft };
        }

        // No live park yet — only queue if we already asked for OTP (awaiting_otp).
        // Do NOT emit "Got the code" from empty/stale park on the same turn as need_otp.
        queuePendingBrowserOtp(input.familyId, input.actorUserId, text);
        draft.lastMessage = ackText;
        await saveDraft(input.phone, draft);
        if (!ackOnce) {
            return { text: "Still signing in with that code…", draft };
        }
        return {
            text: "Got the code — signing in as soon as the login screen is ready…",
            draft,
        };
    }

    // Digits while still opening (phase running): do NOT pretend we got an OTP.
    if (draft && draft.phase === "running" && /^\d{4,8}$/.test(text)) {
        return {
            text:
                "I'm still opening the login page — hang tight. " +
                "*Paste the SMS OTP only after I ask* for it (or reply *cancel*).",
            draft,
        };
    }

    if (
        draft &&
        draft.phase === "awaiting_confirm" &&
        /^(confirm|confirm\s*order|place|place\s*order)$/i.test(text) &&
        draft.mode !== "dry_run"
    ) {
        return startParkedCheckoutFromWhatsApp(input, draft);
    }

    // Real orders need the explicit word — "ok"/"yes"/"pay" could be replies to something else.
    if (draft && draft.phase === "awaiting_confirm" && /^(yes|haan|ok|okay|pay)$/i.test(text) && draft.mode !== "dry_run") {
        return {
            text: `To place this ${partnerLabel(String(draft.partner || "Apollo"))} order with *Cash on Delivery*, reply *confirm*. Or *cancel*.`,
            draft,
        };
    }

    if (draft && draft.phase === "awaiting_confirm" && /^(confirm|place|yes|haan|ok|pay)$/i.test(text)) {
        // dry_run hosts only (no Chromium) — stubbed confirm, never a real order.
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

    // Confirm SKU (guest search) before opening login for browser-first partners
    if (draft && draft.phase === "awaiting_sku_confirm") {
        if (draft.catalogOptions && draft.catalogOptions.length > 1 && /^[123]$/.test(text)) {
            const pick = draft.catalogOptions[Number(text) - 1];
            if (pick) {
                draft.selectedSku = pick;
                draft.catalogOptions = undefined;
                draft.goal = `Order ${pick.name} from ${partnerLabel(String(draft.partner || ""))}`;
                await saveDraft(input.phone, draft);
                return { text: skuConfirmCopy(draft), draft };
            }
        }
        if (/^(confirm|place|yes|haan|ok)$/i.test(text)) {
            if (draft.catalogOptions && draft.catalogOptions.length > 1 && !draft.selectedSku) {
                draft.selectedSku = draft.catalogOptions[0];
                draft.catalogOptions = undefined;
            }
            const skuName = draft.selectedSku?.name;
            const price = formatInr(draft.selectedSku?.pricePaise);
            const partner = draft.partner;
            const playbook = resolvePlaybook(partner, draft.goal, draft.startUrl);
            const {
                appendDeliveryAddressToGoal,
                resolveDeliveryAddressLabel,
            } = await import("./smokeDeliveryAddress");
            if (!draft.addressLabel || draft.addressLabel.trim().length < 8) {
                draft.addressLabel = (
                    await resolveDeliveryAddressLabel({
                        familyId: input.familyId,
                        userId: input.actorUserId,
                        partner: String(partner || ""),
                    })
                ).label;
            }
            const exactGoal = appendDeliveryAddressToGoal(
                skuName
                    ? `Order exact SKU from ${partnerLabel(String(partner || ""))}: ${skuName}${price ? ` @ ${price}` : ""}`
                    : draft.goal,
                draft.addressLabel,
            );
            const challenge =
                draft.partner && draft.partner !== "generic" && draft.partner !== "generic_grocery"
                    ? `browser-${draft.partner}-${Date.now()}`
                    : undefined;
            if (challenge && draft.partner && draft.partner !== "generic") {
                await beginOtpLogin({
                    userId: input.actorUserId,
                    partner: draft.partner as CommercePartnerKey,
                    otpChallengeId: challenge,
                }).catch(() => undefined);
            }
            draft = {
                phase: "running",
                goal: exactGoal.slice(0, 320),
                partner: playbook.partner,
                siteKey: playbook.siteKey,
                startUrl: draft.selectedSku?.productUrl || playbook.startUrl,
                selectedSku: draft.selectedSku,
                addressLabel: draft.addressLabel,
                otpChallengeId: challenge,
                lastMessage: `Opening ${partnerLabel(String(playbook.partner))}…`,
                confirm: { addressLabel: draft.addressLabel },
            };
            await saveDraft(input.phone, draft);

            const loginPhone = toLoginPhoneE164(input.phone);
            const goalWithPhone = /login_phone=/i.test(draft.goal)
                ? draft.goal
                : `${draft.goal} | login_phone=${loginPhone}`;
            const browserGeneration = beginBrowserGeneration(input.familyId, input.actorUserId);
            const notifyPartner: CommercePartnerKey | "generic" =
                draft.partner && draft.partner !== "generic"
                    ? (draft.partner as CommercePartnerKey)
                    : "generic";
            const deadlineEnv = Number(process.env.BROWSER_TASK_DEADLINE_MS);
            const deadlineMs = Math.min(
                Math.max(Number.isFinite(deadlineEnv) && deadlineEnv > 0 ? deadlineEnv : 75_000, 60_000),
                90_000,
            );
            void (async () => {
                const { notifyPharmacyBrowserBackgroundResult, pushWhatsAppBrowserFollowUp } =
                    await import("./browserProgressNotify.service");
                try {
                    const result = await runBrowserTask({
                        familyId: input.familyId,
                        userId: input.actorUserId,
                        goal: goalWithPhone,
                        partner: draft!.partner,
                        startUrl: draft!.startUrl,
                        deadlineMs,
                        loginPhone,
                        browserGeneration,
                        productUrl: draft!.selectedSku?.productUrl,
                        deliveryAddress: draft!.addressLabel,
                        onProgress: async (_stage, detail) => {
                            if (!detail?.trim()) return;
                            if (
                                !isBrowserGenerationCurrent(
                                    input.familyId,
                                    input.actorUserId,
                                    browserGeneration,
                                )
                            ) {
                                return;
                            }
                            if (
                                shouldSuppressDuplicateOtpAsk(
                                    input.familyId,
                                    input.actorUserId,
                                    detail,
                                )
                            ) {
                                return;
                            }
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
                        goal: draft!.goal,
                        partner: notifyPartner,
                        otpChallengeId: challenge,
                        result,
                        browserGeneration,
                    });
                } catch (err) {
                    console.warn(
                        "browser sku-confirm launch failed:",
                        err instanceof Error ? err.message : err,
                    );
                }
            })();

            const priceBit = price ? ` (${price})` : "";
            return {
                text:
                    `Opening *${partnerLabel(String(playbook.partner))}* for: ${skuName || draft.goal.slice(0, 80)}` +
                    `${priceBit}\n\n` +
                    `Deliver to: ${draft.addressLabel}\n` +
                    `I'll sign in with your WhatsApp number when asked.\n` +
                    `*Paste the SMS OTP only after I ask* — I never read your device SMS.\n\n` +
                    `No silent pay — confirm item+total+address before checkout. Prefer *COD*.\n` +
                    `Reply *cancel* to stop.`,
                draft,
            };
        }
        // Re-search on new product text
        if (text.length >= 3 && !/^\d{4,8}$/.test(text)) {
            const partner = draft.partner || partnerFromText(text);
            const query = extractOrderQuery(text, String(partner));
            const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
            const { extractPincode } = await import("./apolloPostOtp");
            const result = await searchGuestCatalog({
                partner: String(partner),
                query,
                familyId: input.familyId,
                userId: input.actorUserId,
                pincode: extractPincode(draft.addressLabel),
            });
            draft.goal = text.slice(0, 240);
            draft.partner = partner;
            if (result.hits.length) {
                draft.catalogOptions = result.hits.slice(0, 3).map((h) => ({
                    id: h.id,
                    name: h.name,
                    pricePaise: h.pricePaise,
                    productUrl: h.productUrl,
                }));
                draft.selectedSku =
                    result.hits.length === 1
                        ? {
                              id: result.hits[0].id,
                              name: result.hits[0].name,
                              pricePaise: result.hits[0].pricePaise,
                              productUrl: result.hits[0].productUrl,
                          }
                        : undefined;
                draft.lastMessage = undefined;
            } else {
                draft.catalogOptions = undefined;
                draft.selectedSku = undefined;
                draft.lastMessage =
                    result.unavailableReason ||
                    `No live guest match for "${query}". Reply *confirm* to open the site, or try another name.`;
            }
            await saveDraft(input.phone, draft);
            return { text: skuConfirmCopy(draft), draft };
        }
        return { text: skuConfirmCopy(draft), draft };
    }

    if (starting) {
        if (ELECTRONICS_REFUSE.test(text) && !/\b(amazon|flipkart)\b/i.test(text)) {
            return { text: refuseElectronicsBrowser(), draft: draft ?? { phase: "idle", goal: "" } };
        }
        const resolved = resolveSiteFromMessage(text, { forceBrowser: true });
        const partner = partnerFromText(text);
        const playbook = resolvePlaybook(partner, text, resolved.startUrl);
        const query = extractOrderQuery(text, String(playbook.partner));

        // SEARCH FIRST — guest/MCP catalog. Do not open login until SKU confirm.
        // Resolve the delivery address first so stock is checked at that pincode.
        const { resolveDeliveryAddressLabel } = await import("./smokeDeliveryAddress");
        const addr = await resolveDeliveryAddressLabel({
            familyId: input.familyId,
            userId: input.actorUserId,
            partner: String(playbook.partner),
        });
        const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
        const { extractPincode } = await import("./apolloPostOtp");
        const catalog = await searchGuestCatalog({
            partner: String(playbook.partner),
            query,
            familyId: input.familyId,
            userId: input.actorUserId,
            pincode: extractPincode(addr.label),
        });

        draft = {
            phase: "awaiting_sku_confirm",
            goal: text.slice(0, 240),
            partner: playbook.partner,
            siteKey: playbook.siteKey,
            startUrl: playbook.startUrl,
            addressLabel: addr.label,
        };

        if (catalog.hits.length) {
            draft.catalogOptions = catalog.hits.slice(0, 3).map((h) => ({
                id: h.id,
                name: h.name,
                pricePaise: h.pricePaise,
                productUrl: h.productUrl,
            }));
            if (catalog.hits.length === 1) {
                draft.selectedSku = {
                    id: catalog.hits[0].id,
                    name: catalog.hits[0].name,
                    pricePaise: catalog.hits[0].pricePaise,
                    productUrl: catalog.hits[0].productUrl,
                };
            }
        } else {
            draft.lastMessage =
                catalog.unavailableReason ||
                `No live guest price for *${partnerLabel(String(playbook.partner))}* yet. Reply *confirm* to open the site (login/OTP may be asked), or send another name / *cancel*.`;
        }

        await saveDraft(input.phone, draft);
        return { text: skuConfirmCopy(draft), draft };
    }

    return null;
}


const SESSION_EXPIRED_COPY =
    "The Apollo login session expired, so I couldn't place the order — nothing was ordered or paid.\n" +
    "Reply *order again* to restart — it will need a new OTP.";

/**
 * "confirm" on the confirm-before-pay card → continue checkout on the parked signed-in
 * page (cart already built). Never starts a fresh login / SMS. Replies instantly; the
 * order number (or an honest failure) follows on WhatsApp within CHECKOUT_BUDGET_MS (~2.5 min).
 */
async function startParkedCheckoutFromWhatsApp(
    input: {
        phone: string;
        familyId: string;
        actorUserId: string;
        recipientUserId: string;
        actorRole: FamilyRole | null;
    },
    draft: BrowserTaskDraft,
): Promise<{ text: string; draft?: BrowserTaskDraft }> {
    const label = partnerLabel(String(draft.partner || "apollo"));
    if (isCheckoutInFlight(input.familyId, input.actorUserId)) {
        return { text: `Already placing your order on *${label}* — hang on, I'll message the result here.`, draft };
    }
    const cardId = draft.confirm?.cardId;
    const parked = peekParkedCheckout(input.familyId, input.actorUserId);
    if (!parked || !cardId || parked.cardId !== cardId) {
        console.warn("[pharmacy-checkout] confirm without usable parked session", {
            hasParked: Boolean(parked),
            draftCard: cardId ?? null,
            parkedCard: parked?.cardId ?? null,
        });
        draft.lastMessage = SESSION_EXPIRED_COPY;
        await saveDraft(input.phone, draft);
        return { text: SESSION_EXPIRED_COPY, draft };
    }
    if (!claimCheckoutInFlight(input.familyId, input.actorUserId)) {
        return { text: `Already placing your order on *${label}* — hang on, I'll message the result here.`, draft };
    }
    const gen = currentBrowserGeneration(input.familyId, input.actorUserId);
    draft.lastMessage = `Placing your order on *${label}* (Cash on Delivery)…`;
    await saveDraft(input.phone, draft);

    void (async () => {
        const { pushWhatsAppBrowserFollowUp } = await import("./browserProgressNotify.service");
        const push = (text: string) =>
            pushWhatsAppBrowserFollowUp({
                phone: input.phone,
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                text,
            }).catch(() => false);
        let delivered = false;
        const watchdog = setTimeout(() => {
            if (delivered) return;
            delivered = true;
            console.warn("[pharmacy-checkout] WA watchdog fired");
            void push(
                `Apollo's checkout is taking unusually long. I will *not* place the order twice — ` +
                    `if you don't get the order number here in 2 minutes, please check Apollo → My Orders.`,
            );
        }, CHECKOUT_BUDGET_MS + 20_000);
        watchdog.unref?.();
        try {
            const run = await continueParkedCheckout({
                familyId: input.familyId,
                userId: input.actorUserId,
                cardId,
                recipientUserId: input.recipientUserId,
                onProgress: async (d) => {
                    if (delivered) return;
                    await push(d);
                },
            });
            const stillCurrent = isBrowserGenerationCurrent(input.familyId, input.actorUserId, gen);
            if (run.status === "placed" || run.status === "placed_unverified") {
                await saveDraft(input.phone, null).catch(() => undefined);
                if (run.status === "placed" && input.actorRole === FamilyRole.CARE_RECIPIENT) {
                    void notifyCaregivers({
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                        actorUserId: input.actorUserId,
                        message:
                            `Amma placed an Apollo order via Saheli (Cash on Delivery)` +
                            `${run.orderIds ? ` — order ${run.orderIds}` : ""}${run.totalLabel ? `, ${run.totalLabel}` : ""}. Notify only.`,
                        urgency: "low",
                        kind: "order_placed",
                    });
                }
            } else if (stillCurrent) {
                const next = (await loadDraft(input.phone)) || draft;
                if (run.reparked) {
                    next.phase = "awaiting_confirm";
                    next.confirm = { ...(next.confirm || {}), cardId: run.cardId || cardId };
                    next.lastMessage = run.message;
                    await saveDraft(input.phone, next).catch(() => undefined);
                } else if (run.noSession || run.status === "no_session") {
                    next.phase = "awaiting_confirm";
                    next.confirm = { ...(next.confirm || {}), cardId: undefined };
                    next.lastMessage = SESSION_EXPIRED_COPY;
                    await saveDraft(input.phone, next).catch(() => undefined);
                } else {
                    await saveDraft(input.phone, null).catch(() => undefined);
                }
            }
            if (!delivered || run.status === "placed" || run.status === "placed_unverified") {
                delivered = true;
                await push(run.message);
            }
        } catch (err) {
            console.warn("[pharmacy-checkout] failed:", err instanceof Error ? err.message : err);
            if (!delivered) {
                delivered = true;
                await push(
                    `Something broke during Apollo checkout (${err instanceof Error ? err.message.slice(0, 100) : "error"}). ` +
                        `Please check Apollo → My Orders before ordering again.`,
                );
            }
        } finally {
            clearTimeout(watchdog);
            releaseCheckoutInFlight(input.familyId, input.actorUserId);
        }
    })();

    return {
        text:
            `Placing your order on *${label}* — *Cash on Delivery* only, on the same signed-in cart (no new code).\n` +
            `I'll send the Apollo order number here in 1–2 minutes (setting the delivery address can take a bit).`,
        draft,
    };
}

/** Rebuild an exact-SKU card from the draft (guest search, no login) after an expired session. */
async function restartOrderFromDraft(
    input: { phone: string; familyId: string; actorUserId: string },
    draft: BrowserTaskDraft,
): Promise<{ text: string; draft?: BrowserTaskDraft } | null> {
    const { parseExactSkuFromGoal, extractPincode } = await import("./apolloPostOtp");
    const partner = (draft.partner && draft.partner !== "generic" ? draft.partner : "apollo") as CommercePartnerKey;
    const skuName = draft.selectedSku?.name || parseExactSkuFromGoal(draft.goal)?.name;
    const addressLabel =
        draft.addressLabel ||
        draft.confirm?.addressLabel ||
        draft.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim();
    if (!skuName) return null;
    const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
    const query = skuName.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
    const result = await searchGuestCatalog({
        partner,
        query,
        familyId: input.familyId,
        userId: input.actorUserId,
        pincode: extractPincode(addressLabel),
    });
    const hit =
        result.hits.find((h) => h.name.toLowerCase() === skuName.toLowerCase()) ||
        result.hits.find((h) => h.name.toLowerCase().startsWith(query.toLowerCase())) ||
        result.hits[0];
    await abortBrowserSessionForUser(input.familyId, input.actorUserId);
    const next: BrowserTaskDraft = {
        phase: "awaiting_sku_confirm",
        goal: `Order ${hit?.name || skuName} from ${partnerLabel(partner)}`.slice(0, 240),
        partner,
        siteKey: partner,
        startUrl: draft.startUrl,
        addressLabel,
        selectedSku: hit
            ? { id: hit.id, name: hit.name, pricePaise: hit.pricePaise, productUrl: hit.productUrl }
            : undefined,
        lastMessage: hit ? undefined : result.unavailableReason,
    };
    await saveDraft(input.phone, next);
    return {
        text: hit
            ? skuConfirmCopy(next) + `\n_Confirming will sign in to ${partnerLabel(partner)} again — a new OTP SMS will come._`
            : result.unavailableReason || `Couldn't find *${skuName}* again — send the medicine name to search.`,
        draft: next,
    };
}

/** Per-user last OTP we drove into a parked page (dedupe Meta webhook retries only). */
const lastDrivenOtp = new Map<string, { otp: string; at: number }>();
function claimParkedOtpDrive(familyId: string, userId: string, otp: string): boolean {
    const key = `${familyId}:${userId}`;
    const prev = lastDrivenOtp.get(key);
    const now = Date.now();
    if (prev && prev.otp === otp && now - prev.at < 180_000) return false;
    lastDrivenOtp.set(key, { otp, at: now });
    return true;
}

/**
 * Background: OTP → parked page → verify → add exact SKU → confirm card.
 * Guarantees ONE honest WhatsApp follow-up (confirm card / error / re-ask) within ~90s.
 */
async function runParkedOtpContinuation(args: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    otp: string;
    draft: BrowserTaskDraft;
}): Promise<void> {
    const { notifyPharmacyBrowserBackgroundResult, pushWhatsAppBrowserFollowUp } = await import(
        "./browserProgressNotify.service"
    );
    const partner = (args.draft.partner as CommercePartnerKey) || "apollo";
    const label = partnerLabel(String(partner));
    const gen = currentBrowserGeneration(args.familyId, args.actorUserId);
    let delivered = false;
    const push = async (text: string) => {
        const ok = await pushWhatsAppBrowserFollowUp({
            phone: args.phone,
            familyId: args.familyId,
            recipientUserId: args.recipientUserId,
            text,
        }).catch(() => false);
        if (!ok) console.warn("[pharmacy-login] WA follow-up send failed", { len: text.length });
        return ok;
    };
    // Safety net: even if something below hangs (Meta send, Mongo, Chromium), say so by ~100s.
    const watchdog = setTimeout(() => {
        if (delivered) return;
        if (!isBrowserGenerationCurrent(args.familyId, args.actorUserId, gen)) return;
        delivered = true;
        console.warn("[pharmacy-login] post-OTP watchdog fired — sending honest timeout");
        void push(
            `I entered your code on *${label}*, but I couldn't finish adding the item in time. ` +
                `Nothing was ordered or paid. Reply *retry* or *cancel*.`,
        );
    }, 100_000);
    watchdog.unref?.();

    const notify = async (result: BrowserTaskResult) => {
        if (delivered) return;
        delivered = true;
        // Result of the user's own OTP paste — never swallow it as a "duplicate OTP ask".
        clearOtpAskDedupe(args.familyId, args.actorUserId);
        if (result.failureReason === "out_of_stock") {
            await notifyOutOfStockWithAlternatives(args, result);
            return;
        }
        await notifyPharmacyBrowserBackgroundResult({
            phone: args.phone,
            familyId: args.familyId,
            recipientUserId: args.recipientUserId,
            actorUserId: args.actorUserId,
            goal: args.draft.goal,
            partner,
            otpChallengeId: args.draft.otpChallengeId,
            result,
        });
    };

    try {
        const result = await submitParkedBrowserOtp({
            familyId: args.familyId,
            userId: args.actorUserId,
            otp: args.otp,
            onProgress: async (detail) => {
                if (!isBrowserGenerationCurrent(args.familyId, args.actorUserId, gen)) return;
                await push(detail);
            },
        });
        if (!isBrowserGenerationCurrent(args.familyId, args.actorUserId, gen) && result?.status !== "need_user_confirm") {
            // User cancelled / started over meanwhile — stay quiet (cancel already replied).
            delivered = true;
            return;
        }
        await notify(
            result ?? {
                status: "error",
                mode: "playwright",
                partner: String(partner),
                steps: 0,
                failureReason: "chromium_crash",
                message:
                    "The login page closed before I could enter your code. Reply *retry* to open again — don't paste until I ask.",
            },
        );
    } catch (err) {
        console.warn("[pharmacy-login] parked OTP submit failed:", err instanceof Error ? err.message : err);
        await notify({
            status: "error",
            mode: "playwright",
            partner: String(partner),
            steps: 0,
            failureReason: "unknown",
            message: `Something broke after I entered your code (${
                err instanceof Error ? err.message.slice(0, 100) : "error"
            }). Nothing was ordered or paid.`,
        }).catch(() => undefined);
    } finally {
        clearTimeout(watchdog);
    }
}

/** Exact SKU unavailable at the pincode → offer in-stock alternatives (guest search, no OTP). */
async function notifyOutOfStockWithAlternatives(
    args: { phone: string; familyId: string; recipientUserId: string; actorUserId: string; draft: BrowserTaskDraft },
    result: BrowserTaskResult,
): Promise<void> {
    const { pushWhatsAppBrowserFollowUp } = await import("./browserProgressNotify.service");
    const partner = (args.draft.partner as CommercePartnerKey) || "apollo";
    const label = partnerLabel(String(partner));
    const { extractPincode, parseExactSkuFromGoal } = await import("./apolloPostOtp");
    const skuName = args.draft.selectedSku?.name || parseExactSkuFromGoal(args.draft.goal)?.name || "";
    const addressLabel =
        args.draft.addressLabel ||
        args.draft.confirm?.addressLabel ||
        args.draft.goal.match(/delivery_address=([^|]+)/i)?.[1]?.trim();
    const pincode = extractPincode(addressLabel);
    let options: NonNullable<BrowserTaskDraft["catalogOptions"]> = [];
    try {
        const { searchGuestCatalog, alternativeQueryForSku } = await import("./guestCatalogSearch.service");
        const alt = await searchGuestCatalog({
            partner: String(partner),
            query: alternativeQueryForSku(skuName || args.draft.goal),
            familyId: args.familyId,
            userId: args.actorUserId,
            pincode,
        });
        const skipId = args.draft.selectedSku?.id;
        options = alt.hits
            .filter((h) => h.id !== skipId && h.name !== skuName && !h.requiresRx)
            .slice(0, 3)
            .map((h) => ({ id: h.id, name: h.name, pricePaise: h.pricePaise, productUrl: h.productUrl }));
    } catch {
        options = [];
    }
    const lines = [result.message];
    if (options.length) {
        lines.push("", `In stock on *${label}*${pincode ? ` for ${pincode}` : ""}:`);
        options.forEach((o, i) => lines.push(`${i + 1}. ${o.name} — ${formatInr(o.pricePaise)}`));
        lines.push("", `Reply *1* / *2* / *3* to pick one (you're already signed in), or *cancel*.`);
    } else {
        lines.push("", `Send another medicine name to search again, or *cancel*.`);
    }
    const text = lines.join("\n");
    const next: BrowserTaskDraft = {
        ...args.draft,
        addressLabel,
        phase: "awaiting_sku_confirm",
        catalogOptions: options.length ? options : undefined,
        selectedSku: undefined,
        lastMessage: text,
        otpChallengeId: undefined,
    };
    await saveDraft(args.phone, next);
    await WhatsappSession.findOneAndUpdate(
        { phone: args.phone },
        { $unset: { pendingCommerceOtp: 1 }, $set: { updatedAt: new Date() } },
    ).catch(() => undefined);
    await pushWhatsAppBrowserFollowUp({
        phone: args.phone,
        familyId: args.familyId,
        recipientUserId: args.recipientUserId,
        text,
    });
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
