/**
 * WhatsApp turns for Saheli private browsing / any-site order.
 * Elder + caregiver can start browse/order via browser when MCP missing or user asks
 * another site / pastes a product URL / says "any site".
 * OTP: user pastes SMS OTP in WhatsApp. Confirm before pay. No silent pay.
 * Soft health tips on confirm when care context matches cart (never diagnose / never block).
 */
import WhatsappSession from "../../models/whatsappSession.model";
import { FamilyRole } from "../../types/family.types";
import { logActivity } from "../activityLog.service";
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
import { classifyOrderInterrupt, type OrderInterrupt } from "./orderInterrupt.service";
import { isAllowedOrderSite, refuseSiteCopy } from "./siteAllowlist";
import {
    KAVACH_DELIVERY_ADDRESS,
    KAVACH_DELIVERY_SHORT,
    classifyAddressMention,
    isKavachAddress,
    stripAddressPhrases,
} from "./kavachAddress";
import {
    dishListCopy,
    extractFoodQuery,
    isAddressOnlyMessage,
    noOpenRestaurantsCopy,
    replyPickCopy,
    restaurantListCopy,
    wantsRestaurantList,
} from "./foodOrderFlow";

export type BrowserTaskPhase =
    | "idle"
    | "awaiting_restaurant_pick"
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
    /** Delivery address shown at confirm / passed into browser goal (always the Kavach address). */
    addressLabel?: string;
    /** Swiggy food flow: open restaurants shown for the elder to pick. */
    restaurantOptions?: Array<{ name: string; cuisines?: string; rating?: string; eta?: string }>;
    /** Swiggy food flow: picked restaurant + dish query. */
    restaurantName?: string;
    dishQuery?: string;
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
    // Only ever the Kavach address — never a store-account address.
    const addr = `📍 ${draft.addressLabel && isKavachAddress(draft.addressLabel) ? draft.addressLabel : KAVACH_DELIVERY_ADDRESS}`;
    const where = draft.restaurantName ? `*${draft.restaurantName}* on *${label}*` : `*${label}*`;
    if (opts.length > 1) {
        const shown = opts.slice(0, 5);
        const lines = shown.map((o, i) => {
            const price = formatInr(o.pricePaise);
            return `${i + 1}. ${o.name}${price ? ` — *${price}*` : ""}`;
        });
        return [
            `Found on ${where} 🛒`,
            ...lines,
            addr,
            ``,
            `${replyPickCopy(shown.length)} (or *confirm* for #1). Cash on Delivery only.`,
        ]
            .filter((l, i, a) => l !== "" || a[i - 1] !== "")
            .join("\n");
    }
    const sku = draft.selectedSku || opts[0];
    if (sku) {
        const price = formatInr(sku.pricePaise);
        return [
            `Found on ${where} 🛒`,
            `${sku.name}${price ? ` — *${price}*` : ""}`,
            addr,
            ``,
            `Reply *confirm* to order (I'll ask for the OTP next), or *cancel*. Cash on Delivery only.`,
        ]
            .filter(Boolean)
            .join("\n");
    }
    return (
        draft.lastMessage ||
        `I couldn't see a live price on *${label}* yet. Reply *confirm* to open the site (it may ask for an OTP), or *cancel*.`
    );
}


export function messageLooksLikeBrowserTask(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    // Restaurant intent → Swiggy food flow ("show me open restaurants", "order food from swiggy").
    if (
        /\b(open|nearby|near\s*me|near\s*by|good|best)\s+restaurants?\b|\brestaurants?\s+(?:near|open|nearby|around)\b|\border(?:ing)?\s+(?:some\s+)?(?:food|khana)\b|\bkhana\s+(?:mangwa|order)/i.test(t) ||
        (/\b(swiggy|zomato)\b/i.test(t) && !/\binstamart\b/i.test(t) && (wantsRestaurantList(t) || /\border(?:ing)?\b|\bshow\b|\btry\b/i.test(t)))
    ) {
        return true;
    }
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
    let text = input.text.trim();
    let draft = await loadDraft(input.phone);

    // ── Interrupts while an order job is open ────────────────────────────────
    // Order-related → apply; unrelated → null so the companion answers and the job continues.
    // Picking stage + a clear order on ANOTHER partner ("order from swiggy food …") → start that fresh.
    if (draft && (draft.phase === "awaiting_sku_confirm" || draft.phase === "awaiting_restaurant_pick")) {
        const mentioned = partnerFromText(text);
        const foodAsk = wantsRestaurantList(text) && /\b(swiggy|zomato|restaurants?|food|khana)\b/i.test(text);
        const other =
            (mentioned !== "generic" && mentioned !== draft.partner) || (foodAsk && draft.partner !== "swiggy" && draft.partner !== "zomato");
        if (other && !isAddressOnlyMessage(text) && messageLooksLikeBrowserTask(text)) {
            await saveDraft(input.phone, null);
            draft = null;
        }
    }

    if (draft && ACTIVE_ORDER_PHASES.has(draft.phase)) {
        const label = partnerLabel(String(draft.partner || "the site"));
        // Address / delivery messages modify THIS order (never a product search or partner switch).
        const addrMention = classifyAddressMention(text);
        if (addrMention && isAddressOnlyMessage(text)) {
            void logActivity({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: "order_interrupt",
                title: `Message during ${label} order: address`,
                detail: text,
                data: { phase: draft.phase, intent: "change", change: "address", match: addrMention, source: "rules" },
            });
            return { text: await addressReply(input, draft, addrMention), draft };
        }
        const intr = await classifyOrderInterrupt({
            phone: input.phone,
            text,
            phase: draft.phase,
            partnerLabel: label,
            itemHint: draft.selectedSku?.name,
        });
        const startsOtherOrder =
            intr.intent !== "flow_reply" && intr.intent !== "cancel" && messageLooksLikeBrowserTask(text);
        void logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            kind: "order_interrupt",
            title: `Message during ${label} order: ${startsOtherOrder ? "new_order" : intr.intent}`,
            detail: text,
            data: { phase: draft.phase, intent: intr.intent, source: intr.source },
        });
        if (startsOtherOrder && draft.phase !== "awaiting_sku_confirm" && draft.phase !== "awaiting_restaurant_pick") {
            return {
                text: `Your *${label}* order is still in progress 🛒 — reply *cancel* first if you'd like to start a new one.`,
                draft,
            };
        }
        if (intr.intent === "unrelated" && !startsOtherOrder) return null;
        if (intr.intent === "status") {
            return { text: await orderStatusReply(input, draft), draft };
        }
        if (intr.intent === "cancel") {
            text = "cancel";
        }
        if (intr.intent === "change") {
            const changed = await applyOrderChange(input, draft, intr, text);
            if (changed.reply) return changed.reply;
            if (changed.searchText) {
                draft = changed.draft;
                text = changed.searchText;
            }
        }
    }

    if (/^(cancel|stop|never ?mind|cancel all(?: browsing)?)$/i.test(text)) bumpGuestWork(input.phone);
    if (/^(cancel|stop|never ?mind|cancel all(?: browsing)?)$/i.test(text) && (draft || /cancel\s+all/i.test(text))) {
        void logActivity({
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            kind: "order_cancelled",
            title: `${partnerLabel(String(draft?.partner || "order"))}: cancelled by user`,
            data: { phase: draft?.phase || null, checkoutInFlight: isCheckoutInFlight(input.familyId, input.actorUserId) },
        });
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
                    "Stopping the checkout now ✋ If the site had already accepted the order I'll tell you here — " +
                    "otherwise nothing was ordered or paid.",
            };
        }
        return { text: "Okay, cancelled ✅ Nothing was ordered or paid." };
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
            const { routeBrowserProgress } = await import("./browserProgressNotify.service");
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
                    onProgress: async (stage, detail) => {
                        if (!detail?.trim()) return;
                        if (!isBrowserGenerationCurrent(input.familyId, input.actorUserId, browserGeneration)) {
                            return;
                        }
                        await routeBrowserProgress({
                            phone: input.phone,
                            familyId: input.familyId,
                            recipientUserId: input.recipientUserId,
                            actorUserId: input.actorUserId,
                            stage,
                            partner: String(retryPartner || ""),
                            text: detail.trim(),
                        });
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
                `Retrying *${partnerLabel(String(retryPartner || "the site"))}* — I'll message you when I need the OTP. ` +
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

    // Swiggy food: elder picks a restaurant → show that restaurant's dishes.
    if (draft && draft.phase === "awaiting_restaurant_pick") {
        const opts = draft.restaurantOptions ?? [];
        const n = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
        const byName = opts.find((o) => text.length >= 3 && o.name.toLowerCase().includes(text.toLowerCase()));
        const picked = Number.isFinite(n) ? opts[n - 1] : byName;
        if (picked) return showRestaurantMenu(input, draft, picked.name);
        if (Number.isFinite(n)) {
            return { text: `Please pick a number from the list (${replyPickCopy(opts.length).replace(/^Reply /, "")}), or *cancel*.`, draft };
        }
        if (text.length >= 3 && !/^\d{4,8}$/.test(text)) {
            // A dish / cuisine name → restaurants for that.
            const q = extractFoodQuery(text);
            if (q) return startFoodFlow(input, q);
        }
        return { text: restaurantListCopy(opts.map((o) => ({ ...o, open: true })), draft.dishQuery), draft };
    }

    // Confirm SKU (guest search) before opening login for browser-first partners
    if (draft && draft.phase === "awaiting_sku_confirm") {
        const nPick = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
        if (draft.catalogOptions && draft.catalogOptions.length > 1 && Number.isFinite(nPick) && (nPick < 1 || nPick > Math.min(5, draft.catalogOptions.length))) {
            return { text: `Please pick ${replyPickCopy(Math.min(5, draft.catalogOptions.length)).replace(/^Reply /, "")}, or *cancel*.`, draft };
        }
        if (draft.catalogOptions && draft.catalogOptions.length > 1 && Number.isFinite(nPick)) {
            const pick = draft.catalogOptions[nPick - 1];
            if (pick) {
                draft.selectedSku = pick;
                draft.catalogOptions = undefined;
                draft.goal = draft.restaurantName
                    ? `Order ${pick.name} from ${draft.restaurantName} on ${partnerLabel(String(draft.partner || ""))}`
                    : `Order ${pick.name} from ${partnerLabel(String(draft.partner || ""))}`;
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
                    ? `Order exact SKU from ${partnerLabel(String(partner || ""))}: ${skuName}${price ? ` @ ${price}` : ""}${
                          draft.restaurantName ? ` | restaurant=${draft.restaurantName}` : ""
                      }`
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
                const { notifyPharmacyBrowserBackgroundResult, routeBrowserProgress } =
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
                        onProgress: async (stage, detail) => {
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
                            await routeBrowserProgress({
                                phone: input.phone,
                                familyId: input.familyId,
                                recipientUserId: input.recipientUserId,
                                actorUserId: input.actorUserId,
                                stage,
                                partner: String(draft!.partner || ""),
                                text: detail.trim(),
                            });
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

            return {
                text: workingAckCopy(String(playbook.partner)),
                draft,
            };
        }
        // Re-search on new product text
        if (text.length >= 3 && !/^\d{4,8}$/.test(text)) {
            const mentioned = partnerFromText(text);
            const partner =
                mentioned !== "generic" && messageLooksLikeBrowserTask(text) ? mentioned : draft.partner || mentioned;
            if (!isAllowedOrderSite(String(partner))) {
                return { text: refuseSiteCopy(String(partner)), draft };
            }
            if (partner === "swiggy" || partner === "zomato") {
                const q = extractFoodQuery(text);
                if (partner === "swiggy" && draft.restaurantName && q && mentioned === "generic") {
                    return showRestaurantMenu(input, draft, draft.restaurantName, q);
                }
                if (partner === "zomato") {
                    return {
                        text: "I can't browse Zomato without signing in yet. I can show restaurants open near you on *Swiggy* instead — say *show open restaurants on Swiggy*.",
                        draft,
                    };
                }
                return startFoodFlow(input, q);
            }
            const query = extractOrderQuery(stripAddressPhrases(text) || text, String(partner));
            if (String(partner) === "instamart") {
                const goalText = text;
                return deferGuestWork(
                    input,
                    `Searching *Instamart* for "${query}" near 📍 ${KAVACH_DELIVERY_SHORT} 🔎 — one moment.`,
                    (token) => grocerySearchCore(input, goalText, query, { partner: "instamart", siteKey: "instamart" }, token),
                    draft,
                );
            }
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
        // Food: Swiggy/Zomato, or restaurant intent with no grocery partner named → restaurant flow.
        if (partner === "swiggy" || partner === "zomato" || (partner === "generic" && wantsRestaurantList(text))) {
            if (partner === "zomato") {
                return {
                    text:
                        "I can't browse Zomato without signing in yet, so I can't show its restaurants for your address. " +
                        "I can show restaurants open near you on *Swiggy* — say *show open restaurants on Swiggy*.",
                };
            }
            return startFoodFlow(input, extractFoodQuery(text));
        }
        const playbook = resolvePlaybook(partner, text, resolved.startUrl);
        if (!isAllowedOrderSite(String(playbook.partner))) {
            return { text: refuseSiteCopy(String(playbook.partner === "generic" ? partner : playbook.partner)) };
        }
        const query = extractOrderQuery(stripAddressPhrases(text) || text, String(playbook.partner));
        if (String(playbook.partner) === "instamart") {
            const goalText = text;
            return deferGuestWork(
                input,
                `Searching *Instamart* for "${query}" near 📍 ${KAVACH_DELIVERY_SHORT} 🔎 — I'll send the options in a moment.`,
                (token) => grocerySearchCore(input, goalText, query, playbook, token),
            );
        }

        // SEARCH FIRST — guest catalog (never MCP). Do not open login until SKU confirm.
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
            draft.catalogOptions = catalog.hits.slice(0, 5).map((h) => ({
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


/** Instamart guest search (browser) → awaiting_sku_confirm draft + options copy. */
async function grocerySearchCore(
    input: { phone: string; familyId: string; actorUserId: string },
    goalText: string,
    query: string,
    playbook: { partner: CommercePartnerKey | "generic" | string; siteKey?: string; startUrl?: string },
    token?: number,
): Promise<{ text: string; draft?: BrowserTaskDraft }> {
    const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
    const catalog = await searchGuestCatalog({ partner: String(playbook.partner), query, familyId: input.familyId, userId: input.actorUserId });
    const draft: BrowserTaskDraft = {
        phase: "awaiting_sku_confirm",
        goal: goalText.slice(0, 240),
        partner: playbook.partner as CommercePartnerKey,
        siteKey: playbook.siteKey,
        startUrl: playbook.startUrl,
        addressLabel: KAVACH_DELIVERY_ADDRESS,
    };
    if (catalog.hits.length) {
        draft.catalogOptions = catalog.hits.slice(0, 5).map((h) => ({ id: h.id, name: h.name, pricePaise: h.pricePaise, productUrl: h.productUrl }));
        if (catalog.hits.length === 1) draft.selectedSku = draft.catalogOptions[0];
    } else {
        draft.lastMessage = catalog.unavailableReason || `Instamart shows nothing for "${query}" near you. Try another name, or *cancel*.`;
    }
    await saveIfCurrent(input.phone, draft, token);
    return { text: skuConfirmCopy(draft), draft };
}

/** Guest browsing (15–30s) runs in the background; the result is pushed to WhatsApp. */
const guestWorkToken = new Map<string, number>();
function bumpGuestWork(phone: string): number {
    const n = (guestWorkToken.get(phone) ?? 0) + 1;
    guestWorkToken.set(phone, n);
    return n;
}
function guestWorkCurrent(phone: string, token: number | undefined): boolean {
    return token == null || guestWorkToken.get(phone) === token;
}
async function saveIfCurrent(phone: string, draft: BrowserTaskDraft | null, token?: number): Promise<boolean> {
    if (!guestWorkCurrent(phone, token)) return false;
    await saveDraft(phone, draft);
    return true;
}

function deferGuestWork(
    input: { phone: string; familyId: string; recipientUserId: string },
    ack: string,
    work: (token: number) => Promise<{ text: string }>,
    currentDraft?: BrowserTaskDraft | null,
): { text: string; draft?: BrowserTaskDraft } {
    const token = bumpGuestWork(input.phone);
    void (async () => {
        let text: string;
        try {
            text = (await work(token)).text;
        } catch (err) {
            console.warn("[guest-browse] failed:", err instanceof Error ? err.message : err);
            text = "The site didn't load for me just now 🙏 Please try again in a minute.";
        }
        if (!guestWorkCurrent(input.phone, token)) return; // cancelled / superseded
        const { pushWhatsAppBrowserFollowUp } = await import("./browserProgressNotify.service");
        await pushWhatsAppBrowserFollowUp({
            phone: input.phone,
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            text,
        }).catch(() => false);
    })();
    return { text: ack, draft: currentDraft ?? undefined };
}

/** Reply to "deliver it to my home / C504 / Raipur" during an order: always the Kavach address. */
async function addressReply(
    input: { phone: string },
    draft: BrowserTaskDraft,
    match: "same" | "other",
): Promise<string> {
    draft.addressLabel = KAVACH_DELIVERY_ADDRESS;
    if (draft.confirm) draft.confirm.addressLabel = KAVACH_DELIVERY_ADDRESS;
    await saveDraft(input.phone, draft);
    const head =
        match === "same"
            ? `Yes 🙂 it will be delivered to your saved address:\n📍 ${KAVACH_DELIVERY_ADDRESS}`
            : `For now I can only deliver to your saved Kavach address 🙏\n📍 ${KAVACH_DELIVERY_ADDRESS}\nTo use a different address, please ask your family to update it in Kavach.`;
    const next =
        draft.phase === "awaiting_restaurant_pick" && draft.restaurantOptions?.length
            ? `${replyPickCopy(draft.restaurantOptions.length)} to pick a restaurant, or *cancel*.`
            : draft.phase === "awaiting_sku_confirm"
              ? draft.catalogOptions && draft.catalogOptions.length > 1
                  ? `${replyPickCopy(Math.min(5, draft.catalogOptions.length))} to pick, or *cancel*.`
                  : `Reply *confirm* to continue, or *cancel*.`
              : draft.phase === "awaiting_confirm"
                ? `Reply *confirm* to place it (Cash on Delivery), or *cancel*.`
                : `Your order continues — I'll update you here.`;
    return `${head}\n\n${next}`;
}

/** Swiggy food: list restaurants taking orders now at the Kavach address (guest browser). */
async function startFoodFlow(
    input: { phone: string; familyId: string; actorUserId: string; recipientUserId: string },
    dishQuery: string,
): Promise<{ text: string; draft?: BrowserTaskDraft }> {
    return deferGuestWork(
        input,
        `Checking which restaurants are open on *Swiggy* near 📍 ${KAVACH_DELIVERY_SHORT}${dishQuery ? ` for "${dishQuery}"` : ""} 🔎 — I'll send the list in a moment.`,
        (token) => startFoodFlowCore(input, dishQuery, token),
    );
}

async function startFoodFlowCore(
    input: { phone: string; familyId: string; actorUserId: string; recipientUserId: string },
    dishQuery: string,
    token?: number,
): Promise<{ text: string; draft?: BrowserTaskDraft }> {
    const { listSwiggyRestaurants } = await import("./swiggyGuest.service");
    let res: Awaited<ReturnType<typeof listSwiggyRestaurants>>;
    try {
        res = await listSwiggyRestaurants({ query: dishQuery || undefined });
    } catch (err) {
        console.warn("[swiggy-guest] list failed:", err instanceof Error ? err.message : err);
        return { text: "Swiggy didn't load for me just now 🙏 Please try again in a minute." };
    }
    if (!res.location.ok || !res.location.pincodeMatch) {
        return {
            text: `I couldn't set Swiggy's location to your saved address (📍 ${KAVACH_DELIVERY_SHORT}), so I won't show restaurants from another area. Please try again in a bit.`,
        };
    }
    const open = res.restaurants.filter((r) => r.open === true).slice(0, 5);
    if (!open.length) {
        await saveIfCurrent(input.phone, null, token);
        return { text: noOpenRestaurantsCopy(res.restaurants, dishQuery || undefined) };
    }
    const draft: BrowserTaskDraft = {
        phase: "awaiting_restaurant_pick",
        goal: `Swiggy food${dishQuery ? `: ${dishQuery}` : ""}`,
        partner: "swiggy",
        siteKey: "swiggy",
        addressLabel: KAVACH_DELIVERY_ADDRESS,
        dishQuery: dishQuery || undefined,
        restaurantOptions: open.map((r) => ({ name: r.name, cuisines: r.cuisines, rating: r.rating, eta: r.eta })),
    };
    await saveIfCurrent(input.phone, draft, token);
    return { text: restaurantListCopy(open, dishQuery || undefined), draft };
}

/** Swiggy food: open one restaurant's menu (guest) and list its dishes to pick. */
async function showRestaurantMenu(
    input: { phone: string; familyId: string; actorUserId: string; recipientUserId: string },
    draft: BrowserTaskDraft,
    restaurant: string,
    dishQueryOverride?: string,
): Promise<{ text: string; draft?: BrowserTaskDraft }> {
    return deferGuestWork(
        input,
        `Opening *${restaurant}*'s menu on Swiggy 🍽️ — one moment.`,
        (token) => showRestaurantMenuCore(input, draft, restaurant, dishQueryOverride, token),
        draft,
    );
}

async function showRestaurantMenuCore(
    input: { phone: string; familyId: string; actorUserId: string; recipientUserId: string },
    draft: BrowserTaskDraft,
    restaurant: string,
    dishQueryOverride?: string,
    token?: number,
): Promise<{ text: string; draft?: BrowserTaskDraft }> {
    const { swiggyRestaurantMenu } = await import("./swiggyGuest.service");
    const dishQuery = dishQueryOverride ?? draft.dishQuery;
    let menu: Awaited<ReturnType<typeof swiggyRestaurantMenu>>;
    try {
        menu = await swiggyRestaurantMenu({ restaurant, dishQuery });
    } catch (err) {
        console.warn("[swiggy-guest] menu failed:", err instanceof Error ? err.message : err);
        return { text: `Swiggy didn't load *${restaurant}*'s menu just now 🙏 Pick again or try another.`, draft };
    }
    if (menu.open === false) {
        return {
            text: `*${restaurant}* is ${menu.closedNote || "not taking orders right now"} 🙏\nPick another from the list, or *cancel*.`,
            draft,
        };
    }
    let dishes = menu.dishes;
    if (!dishes.length && dishQuery) {
        return { text: `*${restaurant}* has nothing matching "${dishQuery}". Send another dish name, or *cancel*.`, draft };
    }
    dishes = dishes.slice(0, 5);
    if (!dishes.length) {
        return { text: `I couldn't read *${restaurant}*'s menu 🙏 Pick another restaurant, or *cancel*.`, draft };
    }
    const next: BrowserTaskDraft = {
        phase: "awaiting_sku_confirm",
        goal: `Order from ${restaurant} on Swiggy`,
        partner: "swiggy",
        siteKey: "swiggy",
        startUrl: menu.url,
        addressLabel: KAVACH_DELIVERY_ADDRESS,
        restaurantName: restaurant,
        dishQuery,
        restaurantOptions: draft.restaurantOptions,
        catalogOptions: dishes.map((d, i) => ({ id: `swiggy:${restaurant}:${i}`.slice(0, 120), name: d.name, pricePaise: d.pricePaise, productUrl: menu.url })),
        selectedSku:
            dishes.length === 1
                ? { id: `swiggy:${restaurant}:0`.slice(0, 120), name: dishes[0]!.name, pricePaise: dishes[0]!.pricePaise, productUrl: menu.url }
                : undefined,
    };
    await saveIfCurrent(input.phone, next, token);
    return { text: dishListCopy(restaurant, dishes, dishQuery), draft: next };
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
        const { pushWhatsAppBrowserFollowUp, routeBrowserProgress } = await import(
            "./browserProgressNotify.service"
        );
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
                `${label}'s checkout is taking unusually long. I will *not* place the order twice — ` +
                    `if you don't get the order number here in 2 minutes, please check ${label} → My Orders.`,
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
                    // Checkout steps → activity log only (never WhatsApp).
                    await routeBrowserProgress({
                        phone: input.phone,
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                        actorUserId: input.actorUserId,
                        stage: "checkout",
                        partner: String(draft.partner || "apollo"),
                        text: d,
                    });
                },
            });
            const stillCurrent = isBrowserGenerationCurrent(input.familyId, input.actorUserId, gen);
            void logActivity({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind:
                    run.status === "placed" || run.status === "placed_unverified"
                        ? "order_placed"
                        : "order_failed",
                severity: run.status === "placed" ? "info" : "warn",
                title: `${label}: checkout ${run.status}`,
                detail: run.message,
                data: {
                    status: run.status,
                    orderIds: run.orderIds || null,
                    totalLabel: run.totalLabel || null,
                    payment: "COD",
                },
            });
            if (run.status === "placed" || run.status === "placed_unverified") {
                await saveDraft(input.phone, null).catch(() => undefined);
                // Caregiver WhatsApp: short order-placed note (item, total, COD, ETA, order id).
                if (run.status === "placed" && input.actorRole === FamilyRole.CARE_RECIPIENT) {
                    const { notifyCaregiversOrderPlaced } = await import("../saheliCaregiverAlert.service");
                    const { getFamilyMembersList } = await import("../familyMember.service");
                    const elderName = await getFamilyMembersList(input.familyId, input.actorUserId)
                        .then((p) => p.members.find((m) => m.userId === input.recipientUserId)?.name)
                        .catch(() => undefined);
                    void notifyCaregiversOrderPlaced({
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                        actorUserId: input.actorUserId,
                        elderName: elderName || undefined,
                        partnerLabel: label,
                        item: draft.selectedSku?.name || draft.confirm?.items?.[0],
                        totalLabel: run.totalLabel || draft.confirm?.totalLabel,
                        etaLabel: extractEtaLabel(`${run.message}\n${run.outcome && "detail" in run.outcome ? run.outcome.detail : ""}`),
                        orderId: run.orderIds,
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
        text: `Placing your *${label}* order (Cash on Delivery) — I'll send the order number here in a minute or two.`,
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
    const { notifyPharmacyBrowserBackgroundResult, pushWhatsAppBrowserFollowUp, routeBrowserProgress } =
        await import("./browserProgressNotify.service");
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
                // Post-OTP steps (signed in, adding to cart…) → activity log only.
                await routeBrowserProgress({
                    phone: args.phone,
                    familyId: args.familyId,
                    recipientUserId: args.recipientUserId,
                    actorUserId: args.actorUserId,
                    stage: "post_otp",
                    partner: String(partner),
                    text: detail,
                });
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
    // Dashboard activity feed only — caregiver WhatsApp is reserved for safety alerts.
    void logActivity({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        kind: "order_placed",
        title: `${label}: done (dry-run host)`,
        detail: `${draft.goal.replace(/login_phone=\S+/gi, "").slice(0, 160)} — ${result.message.slice(0, 300)}`,
    });
}

const ACTIVE_ORDER_PHASES = new Set<BrowserTaskPhase>([
    "awaiting_restaurant_pick",
    "awaiting_sku_confirm",
    "running",
    "awaiting_otp",
    "awaiting_confirm",
]);

/** The one short "working on it" ack the elder gets while the browser runs. */
export function workingAckCopy(partner: string): string {
    return `On it 🛒 Opening *${partnerLabel(partner)}* — I'll message you when I need the OTP. Reply *cancel* to stop.`;
}

/** Status question mid-order → answer from job state (+ last logged step). Pure-ish. */
export async function orderStatusReply(
    input: { familyId: string; actorUserId: string; recipientUserId: string },
    draft: BrowserTaskDraft,
): Promise<string> {
    const label = partnerLabel(String(draft.partner || "the site"));
    const item = draft.selectedSku?.name ? ` for *${draft.selectedSku.name}*` : "";
    if (isCheckoutInFlight(input.familyId, input.actorUserId)) {
        return `Placing your *${label}* order now (Cash on Delivery) ⏳ The order number will come here shortly.`;
    }
    if (draft.phase === "awaiting_confirm") {
        return `Your *${label}* order${item} is ready 📦 Reply *confirm* to place it (Cash on Delivery), or *cancel*.`;
    }
    if (draft.phase === "awaiting_otp") {
        return `Waiting for the login code from *${label}* 🔐 Paste the SMS OTP here when it arrives.`;
    }
    if (draft.phase === "awaiting_sku_confirm") {
        return skuConfirmCopy(draft);
    }
    const { latestOrderStep } = await import("../activityLog.service");
    const last = await latestOrderStep(input.recipientUserId);
    const step =
        last?.detail && last.kind === "order_step"
            ? ` Last step: ${String(last.detail).replace(/\*/g, "").slice(0, 90)}`
            : "";
    return `Still working on your *${label}* order${item} ⏳${step}`;
}

/**
 * "change" interrupt: new item / qty / address. Returns either a direct reply, or a
 * search text to fall into the SKU re-search path (draft moved to awaiting_sku_confirm).
 */
async function applyOrderChange(
    input: { phone: string; familyId: string; actorUserId: string; recipientUserId: string },
    draft: BrowserTaskDraft,
    intr: OrderInterrupt,
    text: string,
): Promise<{ reply?: { text: string; draft?: BrowserTaskDraft }; searchText?: string; draft: BrowserTaskDraft }> {
    const label = partnerLabel(String(draft.partner || "the site"));
    if (isCheckoutInFlight(input.familyId, input.actorUserId)) {
        return {
            draft,
            reply: { text: `I'm already placing this *${label}* order — reply *cancel* to stop it before it goes through.`, draft },
        };
    }
    if (intr.quantity && intr.quantity > 1 && !intr.item && !intr.address) {
        return {
            draft,
            reply: {
                text: `For safety I order one pack at a time 🙏 Reply *confirm* for 1, or *cancel*.`,
                draft,
            },
        };
    }
    if (intr.address && !intr.item) {
        // Orders only ever go to the saved Kavach address.
        const match = classifyAddressMention(intr.address) === "other" ? "other" : "same";
        return { draft, reply: { text: await addressReply(input, draft, match), draft } };
    }
    if (intr.address && !intr.item) {
        draft.addressLabel = intr.address.slice(0, 200);
        if (draft.confirm) draft.confirm.addressLabel = draft.addressLabel;
        if (draft.phase === "awaiting_sku_confirm") {
            await saveDraft(input.phone, draft);
            return { draft, reply: { text: skuConfirmCopy(draft), draft } };
        }
        // Mid-login / confirm card: the cart was built for the old address → rebuild + re-confirm.
        await abortBrowserSessionForUser(input.familyId, input.actorUserId, { phone: input.phone });
        const restarted = await restartOrderFromDraft(input, draft);
        if (restarted) {
            return {
                draft,
                reply: { text: `Updated the delivery address 📍\n\n${restarted.text}`, draft: restarted.draft },
            };
        }
        await saveDraft(input.phone, draft);
        return { draft, reply: { text: `Updated the address 📍 Reply *order again* to rebuild the order for it.`, draft } };
    }
    const itemText = (intr.item || text).trim();
    if (draft.phase !== "awaiting_sku_confirm") {
        // New item mid-order: stop the current browser run safely, then search again (re-confirm).
        await abortBrowserSessionForUser(input.familyId, input.actorUserId, { phone: input.phone });
        draft = {
            phase: "awaiting_sku_confirm",
            goal: itemText.slice(0, 240),
            partner: draft.partner,
            siteKey: draft.siteKey,
            startUrl: undefined,
            addressLabel: draft.addressLabel || draft.confirm?.addressLabel,
        };
        await saveDraft(input.phone, draft);
    }
    return { draft, searchText: itemText };
}

/** Best-effort ETA phrase from the site's success page text ("Delivery by Sat, 27 Sep"). */
export function extractEtaLabel(text: string): string | undefined {
    const m = text.match(
        /\b(?:deliver(?:y|ed)?|arriv(?:e|ing|al)|expected)\s*(?:by|in|on|within|:)\s*([^.\n|]{3,40})/i,
    );
    return m?.[1]?.replace(/\*/g, "").trim() || undefined;
}
