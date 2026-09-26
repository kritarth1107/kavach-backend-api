/**
 * Pharmacy commerce path for elder WhatsApp (Instinct parity).
 * Partners: Apollo, PharmEasy, Tata 1mg — confirm handoff to private browser worker (Gemini+Playwright/dry-run).
 * Rules: elder places (no caregiver approval); caregivers notify-only;
 * SEARCH guest catalog FIRST (exact name+price) → WhatsApp confirm → THEN login/OTP/place;
 * never diagnose; OTC can proceed; Rx-required asks for prescription photo;
 * never invent prices; never open Apollo login until SKU confirmed.
 */
import WhatsappSession from "../models/whatsappSession.model";
import { FamilyRole } from "../types/family.types";
import { PHARMACY_PARTNERS, type CommercePartnerKey } from "./commerceAutomation";

export type PharmacyPhase =
    | "idle"
    | "ask_list_or_rx"
    | "pick_partner"
    | "awaiting_rx_photo"
    | "confirm_basket"
    | "awaiting_otp"
    | "placed";

export type PharmacyBasketItem = {
    name: string;
    quantity: number;
    requiresRx?: boolean;
    /** Live catalog SKU id when guest search resolved a match. */
    skuId?: string;
    pricePaise?: number;
    packLabel?: string;
    productUrl?: string;
};

export type PharmacyCatalogOption = {
    id: string;
    name: string;
    pricePaise?: number;
    requiresRx?: boolean;
    packLabel?: string;
    productUrl?: string;
};

export type PharmacyDraft = {
    phase: PharmacyPhase;
    partner?: CommercePartnerKey;
    items: PharmacyBasketItem[];
    /** Guest-search alternatives; reply 1/2/3 picks one into items[0]. */
    catalogOptions?: PharmacyCatalogOption[];
    /** Original user query used for guest search. */
    searchQuery?: string;
    addressLabel?: string;
    estimatedTotalPaise?: number;
    notes?: string;
};

/** Typo-tolerant Vit C / medicine order intents (vitamic, vitaminc, vit c, …). */
const VITAMIN_C =
    /\b(?:order\s+)?vita\w*\s*c(?:\s+(?:capsules?|tablets?|tabs?|pills?))?\b|\bvit\s*c\b/i;

const PHARMACY_INTENT =
    /\b(order\s+medicines?|order\s+medicine|medicines?\s+for\s+me|pharmacy|apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg|dawai\s+(mangao|order|bhej)|order\s+dawai|order\s+vita\w*\s*c|vita\w*\s*c\s+from\s+apollo)\b/i;

const PARTNER_PICK =
    /\b(apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg|tata)\b/i;

const OTC_HINT =
    /\b(vita\w*\s*c|vit\s*c|vitamin\s*d|paracetamol|crocin|dolo|limcee|celin|shelcal|becosules|zincovit|revital|ors|electral|band[\s-]?aid|antiseptic|cough\s*syrup\s*otc|wet\s*wipes|baby\s*wipes|wipes)\b/i;

function partnerFromText(text: string): CommercePartnerKey | undefined {
    const t = text.toLowerCase();
    if (/\bapollo\b/.test(t)) return "apollo";
    if (/\bpharm\s*easy|pharmeasy\b/.test(t)) return "pharmeasy";
    if (/\b1\s*mg|tata\b/.test(t)) return "tata_1mg";
    return undefined;
}

/** Exported for smoke / unit checks — partner names must never become basket SKUs. */
export function parseMedicineList(text: string): Array<{ name: string; quantity: number; requiresRx?: boolean }> {
    // "Order vitamin c from apollo" → vitamin c only (not "from")
    // "Apollo and I need vit c tablets no prescription needed" / "order vitamic c capsules"
    let cleaned = text
        // Don't invent a dosage form: "capsules" made catalog search favour cod-liver-oil capsules.
        .replace(/\bvita\w*\s*c(?:\s+(?:capsules?|tablets?|tabs?|pills?))?/gi, " vitamin c ")
        .replace(/\bvit\s*c(?:\s+(?:capsules?|tablets?|tabs?|pills?))?/gi, " vitamin c ")
        // Strip "from/on/via/at <partner>" before bare partner wipe so "from" is not left as a token
        .replace(
            /\b(?:from|on|via|at|using|with)\s+(?:apollo|pharm\s*easy|pharmeasy|tata\s*1\s*mg|1\s*mg|tata)\b/gi,
            " ",
        )
        .replace(PARTNER_PICK, " ")
        .replace(PHARMACY_INTENT, " ")
        .replace(
            /\b(and|i|need|want|order|please|for|me|no|prescription|needed|required|otc|capsules?|tablets?|tabs?|pills?|from|on|via|at|using|with|the|a|an|se|pe|par|mein|me|ko|ki|ka|ke|manga|mangao|mangwa|do|dena|de|chahiye|chahie|mujhe|mere|liye|krdo|kardo|kar\s*do|pls)\b/gi,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned && VITAMIN_C.test(text)) {
        cleaned = "vitamin c";
    }
    if (!cleaned) {
        return VITAMIN_C.test(text)
            ? [{ name: "vitamin c", quantity: 1, requiresRx: false }]
            : [];
    }
    const junkToken =
        /^(capsules?|tablets?|tabs?|pills?|from|on|via|at|using|with|the|a|an|apollo|pharmeasy|pharm|easy|tata|1mg|mg)$/i;
    const parts = cleaned
        .split(/,| and | \+ |\/|;/i)
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => !junkToken.test(p))
        .filter((p) => p.length >= 2);
    let items = parts.slice(0, 8).map((name) => ({
        name: name.slice(0, 80),
        quantity: 1,
        requiresRx: !OTC_HINT.test(name) && !/\bno\s+prescription\b/i.test(text),
    }));
    if (VITAMIN_C.test(text)) {
        const hasVitC = items.some((i) => /vitamin\s*c/i.test(i.name));
        if (!hasVitC) {
            items = [{ name: "vitamin c", quantity: 1, requiresRx: false }, ...items].slice(0, 8);
        } else {
            items = items.map((i) =>
                /vitamin\s*c/i.test(i.name) ? { ...i, requiresRx: false } : i,
            );
        }
        // Dedupe identical Vit C lines
        const seen = new Set<string>();
        items = items.filter((i) => {
            const key = i.name.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    return items;
}


function toLoginPhoneE164(phone: string): string {
    const digits = phone.replace(/\D/g, "");
    if (digits.length === 10) return `+91${digits}`;
    if (digits.length >= 11) return `+${digits}`;
    return phone.startsWith("+") ? phone : `+${phone}`;
}

function pharmacyBrowserDeadlineMs(): number | undefined {
    // No short deadline any more — the worker stops on stall detection (runaway ceiling only).
    return undefined;
}

function partnerLabel(p: CommercePartnerKey): string {
    if (p === "tata_1mg") return "Tata 1mg";
    if (p === "pharmeasy") return "PharmEasy";
    if (p === "apollo") return "Apollo";
    return p;
}

const ELECTRONICS_ON_PHARMACY =
    /\b(iphones?|ipads?|macbooks?|laptops?|airpods|playstations?|ps5|xbox(?:es)?|televisions?|tvs?|samsung\s*galaxy|oneplus|pixel\s*phones?)\b/i;

function refuseElectronicsOnPharmacy(): string {
    return (
        "Apollo / PharmEasy / 1mg are for *medicines*, not phones or electronics. " +
        "Say *order … from amazon* / *flipkart* (or paste a link) for those — or name a medicine to search."
    );
}

export function messageLooksLikePharmacyOrder(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (VITAMIN_C.test(t)) return true;
    if (PHARMACY_INTENT.test(t)) return true;
    if (PARTNER_PICK.test(t) && /\b(vit|tablet|medicine|dawai|strip|capsule)\b/i.test(t)) return true;
    return false;
}

async function loadDraft(phone: string): Promise<PharmacyDraft | null> {
    const row = await WhatsappSession.findOne({ phone }).lean();
    const raw = (row as { pharmacyDraft?: PharmacyDraft } | null)?.pharmacyDraft;
    return raw ?? null;
}

async function saveDraft(phone: string, draft: PharmacyDraft | null): Promise<void> {
    await WhatsappSession.findOneAndUpdate(
        { phone },
        { $set: { pharmacyDraft: draft, updatedAt: new Date() } },
        { upsert: true },
    );
}

function formatInr(paise?: number): string {
    if (typeof paise !== "number" || !Number.isFinite(paise)) return "";
    const rupees = paise / 100;
    return Number.isInteger(rupees) ? `₹${rupees}` : `₹${rupees.toFixed(2)}`;
}

function confirmCopy(draft: PharmacyDraft): string {
    const partner = draft.partner ? partnerLabel(draft.partner) : "pharmacy";
    const options = draft.catalogOptions?.filter((o) => o.name) ?? [];
    if (options.length > 1) {
        const lines = options.slice(0, 3).map((o, i) => {
            const price = formatInr(o.pricePaise);
            return `${i + 1}. ${o.name}${price ? ` — ${price}` : ""}`;
        });
        return [
            `Found on *${partner}* 💊`,
            ...lines,
            ``,
            `${options.length >= 3 ? "Reply *1*, *2* or *3*" : "Reply *1* or *2*"} (or *confirm* for #1). Cash on Delivery only.`,
        ].join("\n");
    }
    const lines = draft.items.map((i) => {
        const price = formatInr(i.pricePaise);
        const tag = i.requiresRx ? " _(Rx)_" : " _(OTC)_";
        return price
            ? `• ${i.name} — ${price} ×${i.quantity}${tag}`
            : `• ${i.name} ×${i.quantity}${tag}`;
    });
    const totalPaise =
        typeof draft.estimatedTotalPaise === "number"
            ? draft.estimatedTotalPaise
            : draft.items.reduce(
                  (sum, i) => sum + (typeof i.pricePaise === "number" ? i.pricePaise * i.quantity : 0),
                  0,
              );
    const total =
        totalPaise > 0
            ? formatInr(totalPaise)
            : "live total after login (guest price unavailable)";
    const addr = draft.addressLabel ? draft.addressLabel : "your saved delivery address";
    const hasLive = draft.items.some((i) => typeof i.pricePaise === "number");
    return [
        hasLive ? `Found on *${partner}* 💊` : `*${partner}* — no live price yet 💊`,
        ...lines,
        `Total: ${total}`,
        `📍 ${addr}`,
        ``,
        `Reply *confirm* to order (I'll ask for the OTP next), or *cancel*. Cash on Delivery only.`,
    ].join("\n");
}


/** Attach THIS recipient's own saved delivery address (none → asked at confirm). */
async function ensurePharmacyDeliveryAddress(
    draft: PharmacyDraft,
    ctx: { familyId?: string; userId?: string; recipientUserId?: string },
): Promise<PharmacyDraft> {
    if (draft.addressLabel && draft.addressLabel.trim().length >= 8) return draft;
    const { resolveDeliveryAddressLabel } = await import(
        "./commerceAutomation/smokeDeliveryAddress"
    );
    const resolved = await resolveDeliveryAddressLabel({
        familyId: ctx.familyId,
        recipientUserId: ctx.recipientUserId,
        partner: draft.partner,
    });
    // No saved address for THIS recipient → leave empty; confirm asks them (never a default).
    if (resolved) draft.addressLabel = resolved.label;
    return draft;
}

/** Guest-search catalog and attach exact SKU + price onto draft (no login). */
async function attachGuestCatalog(
    draft: PharmacyDraft,
    ctx: { familyId?: string; userId?: string; recipientUserId?: string },
): Promise<PharmacyDraft> {
    if (!draft.partner || !draft.items.length) {
        return ensurePharmacyDeliveryAddress(draft, ctx);
    }
    const query = (draft.searchQuery || draft.items.map((i) => i.name).join(" ")).trim();
    draft.searchQuery = query;
    const { searchGuestCatalog } = await import("./commerceAutomation/guestCatalogSearch.service");
    // Resolve delivery address first so Apollo stock is checked at that pincode.
    draft = await ensurePharmacyDeliveryAddress(draft, ctx);
    const { extractPincode } = await import("./commerceAutomation/apolloPostOtp");
    const result = await searchGuestCatalog({
        partner: draft.partner!,
        query,
        familyId: ctx.familyId,
        userId: ctx.userId,
        pincode: extractPincode(draft.addressLabel),
    });
    if (!result.hits.length) {
        draft.catalogOptions = undefined;
        draft.notes = result.unavailableReason || draft.notes;
        // Keep soft query name — confirmCopy will say guest price unavailable honestly.
        return ensurePharmacyDeliveryAddress(draft, ctx);
    }
    const options: PharmacyCatalogOption[] = result.hits.slice(0, 3).map((h) => ({
        id: h.id,
        name: h.name,
        pricePaise: h.pricePaise,
        requiresRx: h.requiresRx,
        packLabel: h.packLabel,
        productUrl: h.productUrl,
    }));
    draft.catalogOptions = options.length > 1 ? options : undefined;
    const top = options[0];
    const qty = draft.items[0]?.quantity || 1;
    draft.items = [
        {
            name: top.name,
            quantity: qty,
            requiresRx: top.requiresRx ?? false,
            skuId: top.id,
            pricePaise: top.pricePaise,
            packLabel: top.packLabel,
            productUrl: top.productUrl,
        },
    ];
    if (typeof top.pricePaise === "number") {
        draft.estimatedTotalPaise = top.pricePaise * qty;
    }
    draft.notes = undefined;
    return ensurePharmacyDeliveryAddress(draft, ctx);
}

function applyCatalogPick(draft: PharmacyDraft, index: number): boolean {
    const options = draft.catalogOptions;
    if (!options?.length || index < 0 || index >= options.length) return false;
    const pick = options[index];
    const qty = draft.items[0]?.quantity || 1;
    draft.items = [
        {
            name: pick.name,
            quantity: qty,
            requiresRx: pick.requiresRx ?? false,
            skuId: pick.id,
            pricePaise: pick.pricePaise,
            packLabel: pick.packLabel,
            productUrl: pick.productUrl,
        },
    ];
    draft.catalogOptions = undefined;
    if (typeof pick.pricePaise === "number") {
        draft.estimatedTotalPaise = pick.pricePaise * qty;
    }
    return true;
}

/**
 * Handle pharmacy turns. Returns reply text or null if not a pharmacy turn.
 */
export async function handlePharmacyWhatsAppTurn(input: {
    phone: string;
    text: string;
    familyId: string;
    actorUserId: string;
    recipientUserId: string;
    actorRole: FamilyRole | null;
    mediaUrl?: string;
    isRxPhoto?: boolean;
}): Promise<{ text: string; draft?: PharmacyDraft } | null> {
    let text = input.text.trim();
    let draft = await loadDraft(input.phone);
    // Care guardrail: tobacco / gutka / vapes / alcohol are never ordered (Apollo path too).
    if (!input.isRxPhoto && !input.mediaUrl) {
        const { detectBlockedItem, blockedReply, logBlockedRequest } = await import("./commerceAutomation/blockedItems");
        const hit = detectBlockedItem(text);
        if (hit) {
            await logBlockedRequest({ ...input, cat: hit.cat, text, stage: "pharmacy", source: "keywords" });
            return { text: blockedReply(hit.cat, text) };
        }
    }

    // Interrupts while a medicine order is open: unrelated chat → companion (order stays open).
    if (draft && draft.phase !== "idle" && draft.phase !== "placed" && !input.isRxPhoto && !input.mediaUrl) {
        const { classifyOrderInterrupt } = await import("./commerceAutomation/orderInterrupt.service");
        const pickPhase = draft.phase === "ask_list_or_rx" || draft.phase === "pick_partner" || draft.phase === "confirm_basket";
        const looksPartnerPick = PARTNER_PICK.test(text);
        const intr = looksPartnerPick
            ? { intent: "flow_reply" as const, source: "rules" as const }
            : await classifyOrderInterrupt({
                  phone: input.phone,
                  text,
                  phase: pickPhase ? "awaiting_sku_confirm" : draft.phase,
                  partnerLabel: draft.partner ? partnerLabel(draft.partner) : "pharmacy",
                  itemHint: draft.items.map((i) => i.name).join(", ").slice(0, 80),
              });
        void import("./activityLog.service").then(({ logActivity }) =>
            logActivity({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                kind: "order_interrupt",
                title: `Message during medicine order: ${intr.intent}`,
                detail: text,
                data: { phase: draft!.phase, intent: intr.intent, source: intr.source },
            }),
        );
        if (intr.intent === "unrelated") return null;
        if (intr.intent === "cancel") text = "cancel";
    }

    if (/^(cancel|stop|never ?mind|cancel all(?: browsing)?)$/i.test(text) && draft) {
        const { abortBrowserSessionForUser } = await import(
            "./commerceAutomation/parkedOtpSession.service"
        );
        await abortBrowserSessionForUser(input.familyId, input.actorUserId, {
            phone: input.phone,
        });
        await saveDraft(input.phone, null);
        // Also clear browser task draft so late OTP asks die
        const WhatsappSession = (await import("../models/whatsappSession.model")).default;
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $unset: { browserTaskDraft: 1, pendingCommerceOtp: 1, pharmacyDraft: 1 },
                $set: { updatedAt: new Date() },
            },
        ).catch(() => undefined);
        return {
            text: "Okay, cancelled ✅ Nothing was ordered or paid.",
        };
    }

    // Phones/electronics on a pharmacy partner → refuse (do not soft-basket "iphone").
    if (ELECTRONICS_ON_PHARMACY.test(text) && (messageLooksLikePharmacyOrder(text) || partnerFromText(text) || (draft && draft.phase !== "idle"))) {
        return { text: refuseElectronicsOnPharmacy() };
    }

    // Seed from Rx photo while in pharmacy flow or explicit Rx attach
    if (input.isRxPhoto || (draft && draft.phase === "awaiting_rx_photo" && input.mediaUrl)) {
        draft = draft ?? { phase: "ask_list_or_rx", items: [] };
        draft.notes = "Rx photo received — family can confirm schedule; using names you listed for the cart.";
        draft.phase = draft.partner ? "confirm_basket" : "pick_partner";
        draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
        if (draft.partner && draft.items.length) {
            draft = await attachGuestCatalog(draft, {
                familyId: input.familyId,
                userId: input.actorUserId,
                recipientUserId: input.recipientUserId,
            });
            draft.phase = "confirm_basket";
        }
        await saveDraft(input.phone, draft);
        if (!draft.partner) {
            return {
                text: "Got the prescription photo. Which pharmacy — *Apollo* or *PharmEasy*?",
                draft,
            };
        }
        const rxExtra = draft.notes && !draft.items[0]?.pricePaise ? `\n\n_${draft.notes}_` : "";
        return { text: confirmCopy(draft) + rxExtra, draft };
    }

    const starting = messageLooksLikePharmacyOrder(text) || (draft && draft.phase !== "idle");
    if (!starting) return null;

    // Bare partner names ("Apollo") must not wipe an in-progress draft.
    const barePartnerOnly =
        PARTNER_PICK.test(text.trim()) &&
        text.replace(PARTNER_PICK, "").replace(/\W+/g, " ").trim().length === 0;
    const freshOrderIntent =
        VITAMIN_C.test(text) ||
        /\b(order\s+medicines?|order\s+medicine|medicines?\s+for\s+me|order\s+dawai|dawai\s+(mangao|order|bhej))\b/i.test(
            text,
        );
    if (!draft || draft.phase === "idle" || (freshOrderIntent && !barePartnerOnly)) {
        const partner = partnerFromText(text);
        const items = parseMedicineList(text);
        draft = {
            phase: partner ? (items.length ? "confirm_basket" : "ask_list_or_rx") : items.length ? "pick_partner" : "ask_list_or_rx",
            partner,
            items,
        };
        // OTC override when user says no prescription needed
        if (/\bno\s+prescription\b/i.test(text) || OTC_HINT.test(text)) {
            draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
        }
        await saveDraft(input.phone, draft);

        if (!draft.partner) {
            if (draft.items.length) {
                const lines = draft.items
                    .map((i) => `• ${i.name} ×${i.quantity}${i.requiresRx ? " _(Rx)_" : " _(OTC)_"}`)
                    .join("\n");
                return {
                    text:
                        `Got it:\n${lines}\n\n` +
                        "Which pharmacy — *Apollo* or *PharmEasy*?",
                    draft,
                };
            }
            return {
                text:
                    "Sure — I can order medicines for you.\n\n" +
                    "Send me the *list* (e.g. Vit C tablets) or a *prescription photo*.\n" +
                    "Which pharmacy — *Apollo* or *PharmEasy*?",
                draft,
            };
        }
        if (!draft.items.length) {
            draft.phase = "ask_list_or_rx";
            await saveDraft(input.phone, draft);
            return {
                text: `Okay, ${partnerLabel(draft.partner)}. Send the medicine *list* or a *prescription photo*. OTC (like Vit C) needs no Rx.`,
                draft,
            };
        }
        // SEARCH FIRST (guest catalog) — never open login / never Rx-gate before live results.
        draft = await attachGuestCatalog(draft, {
            familyId: input.familyId,
            userId: input.actorUserId,
            recipientUserId: input.recipientUserId,
        });
        const hasLiveFresh = draft.items.some((i) => typeof i.pricePaise === "number");
        const noMatchFresh =
            !hasLiveFresh &&
            typeof draft.notes === "string" &&
            /no .+ matches|no apollo matches|no pharmeasy matches/i.test(draft.notes);
        if (noMatchFresh) {
            draft.phase = "confirm_basket";
            await saveDraft(input.phone, draft);
            return {
                text:
                    `${draft.notes}\n\n` +
                    `I won't invent a product or price. Send another name, or *cancel*.`,
                draft,
            };
        }
        draft.phase = "confirm_basket";
        await saveDraft(input.phone, draft);
        const freshNote =
            draft.notes && !hasLiveFresh ? `\n\n_${draft.notes}_` : "";
        return { text: confirmCopy(draft) + freshNote, draft };
    }

    // Mid-flow: pick partner
    if (draft.phase === "pick_partner" || draft.phase === "ask_list_or_rx") {
        const partner = partnerFromText(text);
        if (partner) draft.partner = partner;
        const more = parseMedicineList(text);
        if (more.length) {
            draft.items = [...draft.items, ...more].slice(0, 10);
            if (/\bno\s+prescription\b/i.test(text) || /^(otc\s*only)$/i.test(text)) {
                draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
            }
        }
        if (/^(otc\s*only)$/i.test(text)) {
            draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
        }
        if (!draft.partner) {
            await saveDraft(input.phone, draft);
            return {
                text: "Which pharmacy — *Apollo* or *PharmEasy*?",
                draft,
            };
        }
        if (!draft.items.length) {
            draft.phase = "ask_list_or_rx";
            await saveDraft(input.phone, draft);
            return { text: "Please send the medicine list or a prescription photo.", draft };
        }
        draft = await attachGuestCatalog(draft, {
            familyId: input.familyId,
            userId: input.actorUserId,
            recipientUserId: input.recipientUserId,
        });
        const hasLiveMid = draft.items.some((i) => typeof i.pricePaise === "number");
        const noMatchMid =
            !hasLiveMid &&
            typeof draft.notes === "string" &&
            /no .+ matches|no apollo matches|no pharmeasy matches/i.test(draft.notes);
        if (noMatchMid) {
            draft.phase = "confirm_basket";
            await saveDraft(input.phone, draft);
            return {
                text:
                    `${draft.notes}\n\n` +
                    `I won't invent a product or price. Send another name, or *cancel*.`,
                draft,
            };
        }
        draft.phase = "confirm_basket";
        await saveDraft(input.phone, draft);
        const midNote = draft.notes && !hasLiveMid ? `\n\n_${draft.notes}_` : "";
        return { text: confirmCopy(draft) + midNote, draft };
    }

    if (draft.phase === "awaiting_rx_photo") {
        if (/^(otc\s*only)$/i.test(text)) {
            draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
            draft = await attachGuestCatalog(draft, {
                familyId: input.familyId,
                userId: input.actorUserId,
                recipientUserId: input.recipientUserId,
            });
            draft.phase = "confirm_basket";
            await saveDraft(input.phone, draft);
            return { text: confirmCopy(draft), draft };
        }
        return {
            text: "Still need a *prescription photo* for Rx items, or reply *OTC only*.",
            draft,
        };
    }

    // Status during SKU confirm — stay on Apollo basket; never claim Instamart.
    if (draft.phase === "confirm_basket" && /^(status|order\s*status)$/i.test(text)) {
        const partner = draft.partner ? partnerLabel(draft.partner) : "pharmacy";
        return {
            text:
                `You're still choosing a *${partner}* item (not Instamart).\n\n` +
                confirmCopy(draft),
            draft,
        };
    }

    // Bare ok / vague ack while multiple SKUs listed — do NOT open login/OTP.
    if (
        draft.phase === "confirm_basket" &&
        draft.catalogOptions &&
        draft.catalogOptions.length > 1 &&
        /^(ok|okay|okk|k)$/i.test(text)
    ) {
        return {
            text:
                `Please reply *1* / *2* / *3* or *confirm* for #1 — I won't open login on *ok* alone.\n\n` +
                confirmCopy(draft),
            draft,
        };
    }

    // Pick numbered guest-search option before login
    if (
        draft.phase === "confirm_basket" &&
        draft.catalogOptions &&
        draft.catalogOptions.length > 1 &&
        /^[123]$/.test(text)
    ) {
        const idx = Number(text) - 1;
        if (!applyCatalogPick(draft, idx)) {
            return { text: confirmCopy(draft), draft };
        }
        await saveDraft(input.phone, draft);
        return { text: confirmCopy(draft), draft };
    }

    // Invalid list pick (e.g. 9) — re-ask, no login.
    if (
        draft.phase === "confirm_basket" &&
        draft.catalogOptions &&
        draft.catalogOptions.length > 1 &&
        /^\d+$/.test(text) &&
        !/^[123]$/.test(text)
    ) {
        return {
            text:
                `That number isn't on the list. Reply *1* / *2* / *3* (or *confirm* for #1).\n\n` +
                confirmCopy(draft),
            draft,
        };
    }

    // New product name while confirming — re-search without login
    if (
        draft.phase === "confirm_basket" &&
        !/^(confirm|place|yes|haan|ok|okay|cancel|stop|status|order\s*status)$/i.test(text) &&
        !/^[123]$/.test(text) &&
        text.length >= 3 &&
        !/^\d{4,8}$/.test(text)
    ) {
        const more = parseMedicineList(text);
        if (more.length || !PARTNER_PICK.test(text)) {
            const items = more.length ? more : [{ name: text.slice(0, 80), quantity: 1, requiresRx: false }];
            draft.items = items.map((i) => ({ ...i, requiresRx: false }));
            draft.searchQuery = items.map((i) => i.name).join(" ");
            draft.catalogOptions = undefined;
            draft = await attachGuestCatalog(draft, {
                familyId: input.familyId,
                userId: input.actorUserId,
                recipientUserId: input.recipientUserId,
            });
            draft.phase = "confirm_basket";
            await saveDraft(input.phone, draft);
            const reNote =
                draft.notes && !draft.items.some((i) => typeof i.pricePaise === "number")
                    ? `\n\n_${draft.notes}_`
                    : "";
            return { text: confirmCopy(draft) + reNote, draft };
        }
    }

    if (
        draft.phase === "confirm_basket" &&
        (/^(confirm|place|yes|haan)$/i.test(text) ||
            (/^(ok|okay)$/i.test(text) && !(draft.catalogOptions && draft.catalogOptions.length > 1)))
    ) {
        // If multiple options still listed, default to #1 (explicit confirm/yes only)
        if (draft.catalogOptions && draft.catalogOptions.length > 1) {
            applyCatalogPick(draft, 0);
        }
        // Hand off to private browser worker (Gemini + Playwright / dry-run) — OTP + confirm UX.
        const partner = draft.partner ?? "apollo";
        const summary = draft.items.map((i) => `${i.name}×${i.quantity}`).join(", ");
        const { runBrowserTask } = await import("./commerceAutomation/browserWorker.service");
        const { beginOtpLogin } = await import("./commerceAutomation/sessionStore.service");

        const challenge = `pharmacy-${partner}-${Date.now()}`;
        await beginOtpLogin({
            userId: input.actorUserId,
            partner,
            otpChallengeId: challenge,
        }).catch(() => undefined);

        const { appendDeliveryAddressToGoal, resolveDeliveryAddressLabel } = await import(
            "./commerceAutomation/smokeDeliveryAddress"
        );
        if (!draft.addressLabel || draft.addressLabel.trim().length < 8) {
            const resolved = await resolveDeliveryAddressLabel({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                partner,
            });
            if (!resolved) {
                await saveDraft(input.phone, draft);
                const { askForAddress } = await import("./commerceAutomation/browserTaskWhatsApp.service");
                const asked = await askForAddress({ phone: input.phone }, "confirm", undefined, "Reply *confirm* to continue your order.");
                return { text: asked.text, draft };
            }
            draft.addressLabel = resolved.label;
        }
        // Single guest-searched SKU → "exact SKU" goal so the post-login step adds THAT product
        // (product page → Add → cart) instead of a free-form Gemini search.
        const only = draft.items.length === 1 ? draft.items[0] : undefined;
        const exactName = only?.name?.replace(/[|@]/g, " ").trim();
        const goal = appendDeliveryAddressToGoal(
            only && exactName && only.productUrl
                ? `Order exact SKU from ${partnerLabel(partner)}: ${exactName}${
                      typeof only.pricePaise === "number" ? ` @ ${formatInr(only.pricePaise)}` : ""
                  }`
                : `Order from ${partnerLabel(partner)}: ${summary}`,
            draft.addressLabel,
        );
        const productUrl = only?.productUrl;

        // phase "running" until bootstrap actually requests SMS + OTP UI.
        // Premature awaiting_otp lets digit-ish noise / stale pending queue fire false "Got the code".
        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $set: {
                    browserTaskDraft: {
                        phase: "running",
                        goal,
                        partner,
                        otpChallengeId: challenge,
                        lastMessage: `Opening ${partnerLabel(partner)}…`,
                        confirm: {
                            addressLabel: draft.addressLabel,
                        },
                    },
                    pharmacyDraft: null,
                    updatedAt: new Date(),
                },
                $unset: { pendingCommerceOtp: 1 },
            },
            { upsert: true },
        );

        await saveDraft(input.phone, null);

        // Do not block WhatsApp on Chromium — kick off browser async; always push a
        // follow-up (OTP tip / confirm / block / soft failure) so WA never goes silent.
        const deadlineMs = pharmacyBrowserDeadlineMs();
        const loginPhone = toLoginPhoneE164(input.phone);
        const { beginBrowserGeneration } = await import(
            "./commerceAutomation/parkedOtpSession.service"
        );
        const { isBrowserGenerationCurrent } = await import(
            "./commerceAutomation/parkedOtpSession.service"
        );
        const browserGeneration = beginBrowserGeneration(input.familyId, input.actorUserId);
        void (async () => {
            const {
                notifyPharmacyBrowserBackgroundResult,
                routeBrowserProgress,
            } = await import("./commerceAutomation/browserProgressNotify.service");
            // Steps → activity log; only the OTP ask reaches the elder's WhatsApp.
            const progressPush = async (detail: string, stage?: string) => {
                if (!isBrowserGenerationCurrent(input.familyId, input.actorUserId, browserGeneration)) {
                    return;
                }
                await routeBrowserProgress({
                    phone: input.phone,
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    stage,
                    partner: String(partner),
                    text: detail,
                });
            };
            try {
                const result = await runBrowserTask({
                    familyId: input.familyId,
                    userId: input.actorUserId,
                    goal: `${goal} | login_phone=${loginPhone}`,
                    partner,
                    deadlineMs,
                    loginPhone,
                    browserGeneration,
                    productUrl,
                    deliveryAddress: draft.addressLabel,
                    onProgress: async (stage, detail) => {
                        if (detail && detail.trim()) await progressPush(detail.trim(), stage);
                    },
                });
                await notifyPharmacyBrowserBackgroundResult({
                    phone: input.phone,
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    goal,
                    partner,
                    otpChallengeId: challenge,
                    result,
                    browserGeneration,
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn("pharmacy confirm browser background failed:", msg);
                await notifyPharmacyBrowserBackgroundResult({
                    phone: input.phone,
                    familyId: input.familyId,
                    recipientUserId: input.recipientUserId,
                    actorUserId: input.actorUserId,
                    goal,
                    partner,
                    otpChallengeId: challenge,
                    browserGeneration,
                    result: {
                        status: "error",
                        mode: "playwright",
                        partner,
                        steps: 0,
                        failureReason: /chromium|launch|Target closed/i.test(msg)
                            ? "chromium_crash"
                            : "unknown",
                        message: `Browser failed: ${msg.slice(0, 160)}`,
                    },
                }).catch(() => undefined);
            }
        })();

        const { workingAckCopy } = await import("./commerceAutomation/browserTaskWhatsApp.service");
        return {
            text: workingAckCopy(partner),
            draft,
        };
    }

    if (draft.phase === "confirm_basket") {
        return { text: confirmCopy(draft), draft };
    }

    return null;
}

export function listPharmacyPartners(): string[] {
    return PHARMACY_PARTNERS.map(partnerLabel);
}
