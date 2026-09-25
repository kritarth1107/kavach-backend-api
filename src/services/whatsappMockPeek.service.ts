/**
 * Read-only view of what Saheli last sent a WhatsApp number (for the mock endpoint), so an
 * operator can read the async confirm-before-pay card (item / qty / total / COD / address)
 * before replying *confirm*. Async browser follow-ups (progress lines, confirm card, order
 * result) go straight to Meta and are not otherwise readable.
 *
 * Kept in memory only (single Cloud Run instance, max-instances=1): last 20 messages per
 * number for 60 min. Never includes OTPs, tokens, ids, or the raw browser goal.
 */
import { ChannelType } from "../types/careRecord.types";
import { normalizeChannelIdentifier } from "./identityResolver.service";

type OutboundRow = { at: string; text: string; source: string };

const MAX_PER_PHONE = 20;
const TTL_MS = 60 * 60 * 1000;
const outbound = new Map<string, OutboundRow[]>();

function key(phone: string): string {
    return normalizeChannelIdentifier(ChannelType.WHATSAPP, String(phone || ""));
}

/** Redact anything that looks like a login code before storing (defence in depth). */
function redact(text: string): string {
    return text.replace(/\b(otp|code)\b([^0-9\n]{0,20})\b\d{4,8}\b/gi, "$1$2[redacted]");
}

export function recordSaheliOutbound(phone: string, text: string, source = "browser"): void {
    const k = key(phone);
    if (!k || !text?.trim()) return;
    const now = Date.now();
    const rows = (outbound.get(k) || []).filter((r) => now - Date.parse(r.at) < TTL_MS);
    rows.push({ at: new Date(now).toISOString(), text: redact(text.trim()).slice(0, 3000), source });
    outbound.set(k, rows.slice(-MAX_PER_PHONE));
}

export function listSaheliOutbound(phone: string, limit = 10): OutboundRow[] {
    const now = Date.now();
    const rows = (outbound.get(key(phone)) || []).filter((r) => now - Date.parse(r.at) < TTL_MS);
    return rows.slice(-Math.min(Math.max(limit, 1), MAX_PER_PHONE)).reverse();
}

type AnyDraft = Record<string, unknown> | null | undefined;

function summarizeBrowserDraft(d: AnyDraft) {
    if (!d) return null;
    const confirm = (d.confirm || {}) as { items?: string[]; totalLabel?: string; addressLabel?: string; cardId?: string };
    return {
        phase: d.phase ?? null,
        partner: d.partner ?? null,
        /** Last message Saheli stored for this draft (the confirm card while awaiting_confirm). */
        lastMessage: typeof d.lastMessage === "string" ? redact(d.lastMessage).slice(0, 3000) : null,
        confirm: {
            items: Array.isArray(confirm.items) ? confirm.items.slice(0, 5) : [],
            totalLabel: confirm.totalLabel ?? null,
            addressLabel: confirm.addressLabel ?? null,
            /** True when the card is bound to a parked signed-in checkout (confirm can place it). */
            hasCardId: Boolean(confirm.cardId),
        },
    };
}

function summarizePharmacyDraft(d: AnyDraft) {
    if (!d) return null;
    const items = Array.isArray(d.items) ? (d.items as Array<Record<string, unknown>>) : [];
    const options = Array.isArray(d.catalogOptions) ? (d.catalogOptions as Array<Record<string, unknown>>) : [];
    return {
        phase: d.phase ?? null,
        partner: d.partner ?? null,
        items: items.slice(0, 5).map((i) => ({ name: i.name, quantity: i.quantity, pricePaise: i.pricePaise ?? null })),
        catalogOptions: options.slice(0, 3).map((o) => ({ name: o.name, pricePaise: o.pricePaise ?? null })),
        addressLabel: d.addressLabel ?? null,
    };
}

export async function buildWhatsAppMockPeek(from: string): Promise<Record<string, unknown>> {
    const phone = key(from);
    const out: Record<string, unknown> = {
        phone,
        recentOutbound: listSaheliOutbound(phone, 10),
        browserTaskDraft: null,
        pharmacyDraft: null,
        parkedCheckout: null,
    };
    try {
        const WhatsappSession = (await import("../models/whatsappSession.model")).default;
        const row = (await WhatsappSession.findOne({ phone }).lean()) as Record<string, unknown> | null;
        out.browserTaskDraft = summarizeBrowserDraft(row?.browserTaskDraft as AnyDraft);
        out.pharmacyDraft = summarizePharmacyDraft(row?.pharmacyDraft as AnyDraft);
        const familyId = typeof row?.familyId === "string" ? row.familyId : undefined;
        const userId = typeof row?.userId === "string" ? row.userId : undefined;
        if (familyId && userId) {
            const { peekParkedCheckout, isCheckoutInFlight } = await import(
                "./commerceAutomation/parkedOtpSession.service"
            );
            const parked = peekParkedCheckout(familyId, userId);
            const draftCard = ((row?.browserTaskDraft as AnyDraft)?.confirm as { cardId?: string } | undefined)?.cardId;
            out.parkedCheckout = {
                parked: Boolean(parked),
                matchesDraftCard: Boolean(parked && draftCard && parked.cardId === draftCard),
                expiresInSec: parked ? Math.max(0, Math.round((parked.expiresAt - Date.now()) / 1000)) : null,
                placeClicked: parked ? Boolean(parked.placeClicked) : null,
                checkoutInFlight: isCheckoutInFlight(familyId, userId),
            };
        }
    } catch (err) {
        out.error = err instanceof Error ? err.message.slice(0, 120) : "peek failed";
    }
    return out;
}
