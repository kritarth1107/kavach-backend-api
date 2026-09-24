/**
 * Pharmacy commerce path for elder WhatsApp (Instinct parity).
 * Partners: Apollo, PharmEasy, Tata 1mg — adapters are scaffolded until live API/automation.
 * Rules: elder places (no caregiver approval); caregivers notify-only; confirm total+address before pay;
 * never diagnose; OTC can proceed; Rx-required asks for prescription photo.
 */
import WhatsappSession from "../models/whatsappSession.model";
import { FamilyRole } from "../types/family.types";
import { getCommerceAdapter, PHARMACY_PARTNERS, type CommercePartnerKey } from "./commerceAutomation";
import { notifyCaregivers } from "./saheliCaregiverAlert.service";

export type PharmacyPhase =
    | "idle"
    | "ask_list_or_rx"
    | "pick_partner"
    | "awaiting_rx_photo"
    | "confirm_basket"
    | "awaiting_otp"
    | "placed";

export type PharmacyDraft = {
    phase: PharmacyPhase;
    partner?: CommercePartnerKey;
    items: Array<{ name: string; quantity: number; requiresRx?: boolean }>;
    addressLabel?: string;
    estimatedTotalPaise?: number;
    notes?: string;
};

const PHARMACY_INTENT =
    /\b(order\s+medicines?|order\s+medicine|medicines?\s+for\s+me|pharmacy|apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg|dawai\s+(mangao|order|bhej)|order\s+dawai)\b/i;

const PARTNER_PICK =
    /\b(apollo|pharmeasy|pharm\s*easy|1\s*mg|tata\s*1mg|tata)\b/i;

const OTC_HINT =
    /\b(vit(?:amin)?\s*c|vitamin\s*d|paracetamol|crocin|dolo|ors|electral|band[\s-]?aid|antiseptic|cough\s*syrup\s*otc)\b/i;

function partnerFromText(text: string): CommercePartnerKey | undefined {
    const t = text.toLowerCase();
    if (/\bapollo\b/.test(t)) return "apollo";
    if (/\bpharm\s*easy|pharmeasy\b/.test(t)) return "pharmeasy";
    if (/\b1\s*mg|tata\b/.test(t)) return "tata_1mg";
    return undefined;
}

function parseMedicineList(text: string): Array<{ name: string; quantity: number; requiresRx?: boolean }> {
    // "Apollo and I need vit c tablets no prescription needed"
    let cleaned = text
        .replace(PHARMACY_INTENT, " ")
        .replace(PARTNER_PICK, " ")
        .replace(/\b(and|i|need|want|order|please|for|me|no|prescription|needed|required|otc)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) return [];
    const parts = cleaned.split(/,| and | \+ |\/|;/i).map((p) => p.trim()).filter(Boolean);
    return parts.slice(0, 8).map((name) => ({
        name: name.slice(0, 80),
        quantity: 1,
        requiresRx: !OTC_HINT.test(name) && !/\bno\s+prescription\b/i.test(text),
    }));
}

function partnerLabel(p: CommercePartnerKey): string {
    if (p === "tata_1mg") return "Tata 1mg";
    if (p === "pharmeasy") return "PharmEasy";
    if (p === "apollo") return "Apollo";
    return p;
}

export function messageLooksLikePharmacyOrder(text: string): boolean {
    return PHARMACY_INTENT.test(text) || (PARTNER_PICK.test(text) && /\b(vit|tablet|medicine|dawai|strip)\b/i.test(text));
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

function confirmCopy(draft: PharmacyDraft): string {
    const partner = draft.partner ? partnerLabel(draft.partner) : "pharmacy";
    const lines = draft.items.map((i) => `• ${i.name} ×${i.quantity}${i.requiresRx ? " _(Rx)_" : " _(OTC)_"}`);
    const total =
        typeof draft.estimatedTotalPaise === "number"
            ? `₹${(draft.estimatedTotalPaise / 100).toFixed(0)}`
            : "I'll confirm the live total before pay";
    const addr = draft.addressLabel ? draft.addressLabel : "your saved delivery address";
    return [
        `*${partner} basket* — please confirm before pay:`,
        ...lines,
        ``,
        `Deliver to: ${addr}`,
        `Total: ${total}`,
        ``,
        `Reply *confirm* to place, *cancel* to stop, or send a *prescription photo* for Rx items.`,
        `_I only help order what you ask — I don't diagnose or suggest treatments._`,
    ].join("\n");
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
    const text = input.text.trim();
    let draft = await loadDraft(input.phone);

    if (/^(cancel|stop|never ?mind)$/i.test(text) && draft) {
        await saveDraft(input.phone, null);
        return { text: "Okay — cancelled the medicine order." };
    }

    // Seed from Rx photo while in pharmacy flow or explicit Rx attach
    if (input.isRxPhoto || (draft && draft.phase === "awaiting_rx_photo" && input.mediaUrl)) {
        draft = draft ?? { phase: "ask_list_or_rx", items: [] };
        draft.notes = "Rx photo received — family can confirm schedule; using names you listed for the cart.";
        draft.phase = draft.partner ? "confirm_basket" : "pick_partner";
        draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
        await saveDraft(input.phone, draft);
        if (!draft.partner) {
            return {
                text: "Got the prescription photo. Which pharmacy — *Apollo*, *PharmEasy*, or *Tata 1mg*?",
                draft,
            };
        }
        return { text: confirmCopy(draft), draft };
    }

    const starting = messageLooksLikePharmacyOrder(text) || (draft && draft.phase !== "idle");
    if (!starting) return null;

    if (!draft || draft.phase === "idle" || messageLooksLikePharmacyOrder(text)) {
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
            return {
                text:
                    "Sure — I can order medicines for you.\n\n" +
                    "Send me the *list* (e.g. Vit C tablets) or a *prescription photo*.\n" +
                    "Which pharmacy — *Apollo*, *PharmEasy*, or *Tata 1mg*?",
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
        if (draft.items.some((i) => i.requiresRx)) {
            draft.phase = "awaiting_rx_photo";
            await saveDraft(input.phone, draft);
            return {
                text:
                    `Some items may need a prescription. Please send a *photo of the Rx*, or say *OTC only* if none need it.\n\n` +
                    confirmCopy(draft),
                draft,
            };
        }
        draft.phase = "confirm_basket";
        await saveDraft(input.phone, draft);
        return { text: confirmCopy(draft), draft };
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
                text: "Which pharmacy — *Apollo*, *PharmEasy*, or *Tata 1mg*?",
                draft,
            };
        }
        if (!draft.items.length) {
            draft.phase = "ask_list_or_rx";
            await saveDraft(input.phone, draft);
            return { text: "Please send the medicine list or a prescription photo.", draft };
        }
        if (draft.items.some((i) => i.requiresRx)) {
            draft.phase = "awaiting_rx_photo";
            await saveDraft(input.phone, draft);
            return {
                text: "Please send a *prescription photo* for Rx items, or reply *OTC only*.",
                draft,
            };
        }
        draft.phase = "confirm_basket";
        await saveDraft(input.phone, draft);
        return { text: confirmCopy(draft), draft };
    }

    if (draft.phase === "awaiting_rx_photo") {
        if (/^(otc\s*only)$/i.test(text)) {
            draft.items = draft.items.map((i) => ({ ...i, requiresRx: false }));
            draft.phase = "confirm_basket";
            await saveDraft(input.phone, draft);
            return { text: confirmCopy(draft), draft };
        }
        return {
            text: "Still need a *prescription photo* for Rx items, or reply *OTC only*.",
            draft,
        };
    }

    if (draft.phase === "confirm_basket" && /^(confirm|place|yes|haan|ok)$/i.test(text)) {
        // Elder path: no caregiver approval. Scaffold place — notify caregivers with summary.
        const partner = draft.partner ?? "apollo";
        const adapter = getCommerceAdapter(partner);
        const search = await adapter.search({
            userId: input.actorUserId,
            familyId: input.familyId,
            query: draft.items.map((i) => i.name).join(", "),
        });

        const summary = draft.items.map((i) => `${i.name}×${i.quantity}`).join(", ");
        const notifyBody = `Amma placed a medicine order on ${partnerLabel(partner)} — ${summary}. Notify only — no approval needed. (Pharmacy path: scaffold until live partner place.)`;

        if (input.actorRole === FamilyRole.CARE_RECIPIENT) {
            void notifyCaregivers({
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                message: notifyBody,
                urgency: "low",
                kind: "order_placed",
            });
        }

        draft.phase = "placed";
        await saveDraft(input.phone, null);

        return {
            text:
                `Got it — ${partnerLabel(partner)} order noted for: ${summary}.\n\n` +
                `${search.message ?? "I'll confirm live total + address before final pay when the pharmacy connection is live."}\n\n` +
                `Your family has been notified. _No diagnosis — only fulfilling your request._`,
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
