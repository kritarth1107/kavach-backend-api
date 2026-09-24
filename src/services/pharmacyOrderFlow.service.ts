/**
 * Pharmacy commerce path for elder WhatsApp (Instinct parity).
 * Partners: Apollo, PharmEasy, Tata 1mg — confirm handoff to private browser worker (Gemini+Playwright/dry-run).
 * Rules: elder places (no caregiver approval); caregivers notify-only; confirm total+address before pay;
 * never diagnose; OTC can proceed; Rx-required asks for prescription photo.
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

export type PharmacyDraft = {
    phase: PharmacyPhase;
    partner?: CommercePartnerKey;
    items: Array<{ name: string; quantity: number; requiresRx?: boolean }>;
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
    /\b(vita\w*\s*c|vit\s*c|vitamin\s*d|paracetamol|crocin|dolo|ors|electral|band[\s-]?aid|antiseptic|cough\s*syrup\s*otc)\b/i;

function partnerFromText(text: string): CommercePartnerKey | undefined {
    const t = text.toLowerCase();
    if (/\bapollo\b/.test(t)) return "apollo";
    if (/\bpharm\s*easy|pharmeasy\b/.test(t)) return "pharmeasy";
    if (/\b1\s*mg|tata\b/.test(t)) return "tata_1mg";
    return undefined;
}

function parseMedicineList(text: string): Array<{ name: string; quantity: number; requiresRx?: boolean }> {
    // "Apollo and I need vit c tablets no prescription needed" / "order vitamic c capsules"
    let cleaned = text
        .replace(PHARMACY_INTENT, " ")
        .replace(PARTNER_PICK, " ")
        .replace(/\b(and|i|need|want|order|please|for|me|no|prescription|needed|required|otc)\b/gi, " ")
        .replace(/\bvita\w*\s*c\b/gi, "vitamin c")
        .replace(/\bvit\s*c\b/gi, "vitamin c")
        .replace(/\s+/g, " ")
        .trim();
    // If intent consumed the vitamin token, still seed OTC Vit C from original text
    if (!cleaned && VITAMIN_C.test(text)) {
        cleaned = "vitamin c capsules";
    }
    if (!cleaned) return [];
    const parts = cleaned.split(/,| and | \+ |\/|;/i).map((p) => p.trim()).filter(Boolean);
    let items = parts.slice(0, 8).map((name) => ({
        name: name.slice(0, 80),
        quantity: 1,
        requiresRx: !OTC_HINT.test(name) && !/\bno\s+prescription\b/i.test(text),
    }));
    // Prefer a clear OTC Vit C line when the user meant vitamin C (incl. typos like vitamic).
    if (VITAMIN_C.test(text)) {
        const hasVitC = items.some((i) => /vitamin\s*c|vita\w*\s*c|vit\s*c/i.test(i.name));
        if (!hasVitC) {
            items = [{ name: "vitamin c capsules", quantity: 1, requiresRx: false }, ...items].slice(0, 8);
        } else {
            items = items.map((i) =>
                /vitamin\s*c|vita\w*\s*c|vit\s*c|capsules?/i.test(i.name)
                    ? { ...i, name: /vitamin\s*c/i.test(i.name) ? i.name : "vitamin c capsules", requiresRx: false }
                    : i,
            );
        }
    }
    return items;
}

function partnerLabel(p: CommercePartnerKey): string {
    if (p === "tata_1mg") return "Tata 1mg";
    if (p === "pharmeasy") return "PharmEasy";
    if (p === "apollo") return "Apollo";
    return p;
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

        await WhatsappSession.findOneAndUpdate(
            { phone: input.phone },
            {
                $set: {
                    pendingCommerceOtp: { partner, challengeId: challenge },
                    browserTaskDraft: {
                        phase: "awaiting_otp",
                        goal: `Order from ${partnerLabel(partner)}: ${summary}`,
                        partner,
                        otpChallengeId: challenge,
                    },
                    pharmacyDraft: null,
                    updatedAt: new Date(),
                },
            },
            { upsert: true },
        );

        const goal = `Order from ${partnerLabel(partner)}: ${summary}`;
        // Hard-deadline browser step — WhatsApp must reply within SLA even if Chromium hangs.
        const result = await runBrowserTask({
            familyId: input.familyId,
            userId: input.actorUserId,
            goal,
            partner,
            deadlineMs: Number(process.env.BROWSER_TASK_DEADLINE_MS) || 28_000,
        });

        draft.phase = "awaiting_otp";
        await saveDraft(input.phone, null);

        return {
            text:
                result.message ||
                `${partnerLabel(partner)} may text a login code — paste the SMS OTP here.\n` +
                    `(Basket: ${summary}. No silent pay — I'll ask you to confirm item+total+address before checkout.)`,
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
