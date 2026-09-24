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
                `\\b(?:from|on|via|at|using|with)\\s+${partner.replace(/_/g, "\\s*")}\b`,
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
    if (opts.length > 1) {
        const lines = opts.slice(0, 3).map((o, i) => {
            const price = formatInr(o.pricePaise);
            return `${i + 1}. ${o.name}${price ? ` — ${price}` : ""}`;
        });
        return [
            `Found on *${label}*:`,
            ...lines,
            ``,
            `Reply *1* / *2* / *3*, or *confirm* for #1 — login/OTP only after you pick.`,
            `Or send another name. Reply *cancel* to stop.`,
        ].join("\n");
    }
    const sku = draft.selectedSku || opts[0];
    if (sku) {
        const price = formatInr(sku.pricePaise);
        return [
            `Found on *${label}*:`,
            `• ${sku.name}${price ? ` — ${price}` : ""}`,
            ``,
            `Reply *confirm* to order this (login/OTP next), or send another name / *cancel*.`,
        ].join("\n");
    }
    return (
        draft.lastMessage ||
        `I couldn't get a live guest price for *${label}* yet. Reply *confirm* to open the site (login/OTP may be asked), or *cancel*.`
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
        return { text: "Okay — cancelled. Nothing was ordered or paid — no more OTP asks from this attempt." };
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
            void (async () => {
                const {
                    notifyPharmacyBrowserBackgroundResult,
                } = await import("./browserProgressNotify.service");
                try {
                    const result = await submitParkedBrowserOtp({
                        familyId: input.familyId,
                        userId: input.actorUserId,
                        otp: text,
                    });
                    if (!result) {
                        await notifyPharmacyBrowserBackgroundResult({
                            phone: input.phone,
                            familyId: input.familyId,
                            recipientUserId: input.recipientUserId,
                            actorUserId: input.actorUserId,
                            goal: draft!.goal,
                            partner: (draft!.partner as import("./types").CommercePartnerKey) || "apollo",
                            otpChallengeId: draft!.otpChallengeId,
                            result: {
                                status: "error",
                                mode: "playwright",
                                partner: String(draft!.partner || "apollo"),
                                steps: 0,
                                failureReason: "chromium_crash",
                                message:
                                    "The login page closed before I could enter your code. Reply *retry* to open again — don't paste until I ask.",
                            },
                        });
                        return;
                    }
                    await notifyPharmacyBrowserBackgroundResult({
                        phone: input.phone,
                        familyId: input.familyId,
                        recipientUserId: input.recipientUserId,
                        actorUserId: input.actorUserId,
                        goal: draft!.goal,
                        partner: (draft!.partner as import("./types").CommercePartnerKey) || "apollo",
                        otpChallengeId: draft!.otpChallengeId,
                        result,
                    });
                } catch (err) {
                    console.warn(
                        "parked OTP submit failed:",
                        err instanceof Error ? err.message : err,
                    );
                }
            })();
            // Duplicate inbound (Meta retry) after first ACK: silent / short noop
            if (!ackOnce) {
                return { text: "Still signing in with that code…", draft };
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
            // Fall through to browser launch below by rewriting as starting with exact goal
            const skuName = draft.selectedSku?.name;
            const price = formatInr(draft.selectedSku?.pricePaise);
            const partner = draft.partner;
            const playbook = resolvePlaybook(partner, draft.goal, draft.startUrl);
            const exactGoal = skuName
                ? `Order exact SKU from ${partnerLabel(String(partner || ""))}: ${skuName}${price ? ` @ ${price}` : ""}`
                : draft.goal;
            draft = {
                phase: "running",
                goal: exactGoal.slice(0, 240),
                partner: playbook.partner,
                siteKey: playbook.siteKey,
                startUrl: draft.selectedSku?.productUrl || playbook.startUrl,
                selectedSku: draft.selectedSku,
                otpChallengeId: undefined,
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
            await saveDraft(input.phone, draft);
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
        // Re-search on new product text
        if (text.length >= 3 && !/^\d{4,8}$/.test(text)) {
            const partner = draft.partner || partnerFromText(text);
            const query = extractOrderQuery(text, String(partner));
            const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
            const result = await searchGuestCatalog({
                partner: String(partner),
                query,
                familyId: input.familyId,
                userId: input.actorUserId,
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
        const resolved = resolveSiteFromMessage(text, { forceBrowser: true });
        const partner = partnerFromText(text);
        const playbook = resolvePlaybook(partner, text, resolved.startUrl);
        const query = extractOrderQuery(text, String(playbook.partner));

        // SEARCH FIRST — guest/MCP catalog. Do not open login until SKU confirm.
        const { searchGuestCatalog } = await import("./guestCatalogSearch.service");
        const catalog = await searchGuestCatalog({
            partner: String(playbook.partner),
            query,
            familyId: input.familyId,
            userId: input.actorUserId,
        });

        draft = {
            phase: "awaiting_sku_confirm",
            goal: text.slice(0, 240),
            partner: playbook.partner,
            siteKey: playbook.siteKey,
            startUrl: playbook.startUrl,
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
