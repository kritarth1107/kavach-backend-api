import WhatsappSession, { type WhatsappOrderPhase } from "../models/whatsappSession.model";
import OrderSession from "../models/orderSession.model";
import type { OrderSessionAddress } from "../models/orderSession.model";
import { AppError } from "../middleware/error.middleware";
import {
    addOrderFlowCartItem,
    loadOrderFlowRestaurantMenu,
    selectOrderFlowAddress,
    submitOrderFlowCart,
    type OrderFlowPayload,
} from "./orderOrchestrator.service";
import type { OrderSessionCatalogItem } from "../models/orderSession.model";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function formatRupee(paise: number): string {
    return `₹${(paise / 100).toFixed(0)}`;
}

function formatBillBreakdownLines(
    bill: import("./orderOrchestrator.service").OrderFlowPayload["billBreakdown"],
    itemSubtotalPaise: number,
): string[] {
    const lines: string[] = [];
    const sub =
        typeof bill?.itemSubtotalPaise === "number" && bill.itemSubtotalPaise > 0
            ? bill.itemSubtotalPaise
            : itemSubtotalPaise;
    if (sub > 0) lines.push(`Item subtotal: ${formatRupee(sub)}`);

    const feeLines: Array<[string, number | undefined]> = [
        ["Delivery fee", bill?.deliveryFeePaise],
        ["Platform fee", bill?.platformFeePaise],
        ["Small cart fee", bill?.smallOrderFeePaise],
        ["Packing fee", bill?.packingFeePaise],
        ["Tax", bill?.taxPaise],
        ["Discount", bill?.discountPaise],
        ["Tip", bill?.tipPaise],
        ["Other fees", bill?.otherFeesPaise],
    ];
    for (const [label, paise] of feeLines) {
        if (typeof paise === "number" && paise !== 0) {
            const sign = paise < 0 || label === "Discount" ? "-" : "";
            const abs = Math.abs(paise);
            lines.push(`${label}: ${sign}${formatRupee(abs)}`);
        }
    }
    if (typeof bill?.smallOrderFeePaise === "number" && bill.smallOrderFeePaise > 0) {
        lines.push("_Tip: add a bit more to the basket to avoid the small-cart fee._");
    }

    const total =
        typeof bill?.grandTotalPaise === "number" && bill.grandTotalPaise > 0
            ? bill.grandTotalPaise
            : sub;
    lines.push(`\n*Total:* ${formatRupee(total)}`);
    if (typeof bill?.etaMinutes === "number" && bill.etaMinutes > 0) {
        lines.push(`ETA: ~${bill.etaMinutes} min`);
    }
    if (bill?.trackingUrl) {
        lines.push(`Track: ${bill.trackingUrl}`);
    }
    return lines;
}


function catalogItems(flow: OrderFlowPayload): OrderSessionCatalogItem[] {
    const cat = flow.catalog;
    if (!cat) return [];
    return [...(cat.restaurants ?? []), ...(cat.dishes ?? []), ...(cat.products ?? [])];
}

export function formatOrderFlowForWhatsApp(flow: OrderFlowPayload): string {
    const lines: string[] = [];
    if (flow.message) lines.push(flow.message);

    if (flow.phase === "select_address" && flow.addresses?.length) {
        lines.push("\n*Pick a delivery address:*");
        flow.addresses.forEach((addr, i) => {
            const detail = [addr.line1, addr.city, addr.pincode].filter(Boolean).join(", ");
            lines.push(`${i + 1}. ${addr.label}${detail ? ` — ${detail}` : ""}`);
        });
        lines.push('\nReply with a number (e.g. "1") or say *cancel*.');
    }

    if (flow.disambiguation?.candidates?.length) {
        lines.push(`\n*Which "${flow.disambiguation.query}" did you mean?*`);
        flow.disambiguation.candidates.slice(0, 5).forEach((item, i) => {
            const price =
                item.pricePaise && item.pricePaise > 0
                    ? ` — ${formatRupee(item.pricePaise)}`
                    : "";
            lines.push(`${i + 1}. ${item.name}${price}`);
        });
        lines.push('\nReply with a number (e.g. "1").');
    } else if (flow.phase === "browse" && !flow.deliveryUnavailable) {
        const restaurants = flow.catalog?.restaurants ?? [];
        const restaurantOnly =
            restaurants.length > 0 &&
            !(flow.catalog?.dishes?.length || flow.catalog?.products?.length);
        if (restaurantOnly) {
            lines.push(`\n*Restaurants for "${flow.query}" on ${flow.partnerLabel}:*`);
            restaurants.slice(0, 6).forEach((r, i) => {
                lines.push(`${i + 1}. ${r.name}`);
            });
            lines.push("\nTap a number or use the list to see the menu.");
        } else {
            const items = catalogItems(flow);
            if (items.length) {
                lines.push(`\n*${flow.partnerLabel} picks for "${flow.query}":*`);
                items.slice(0, 8).forEach((item, i) => {
                    const price =
                        item.pricePaise && item.pricePaise > 0
                            ? ` — ${formatRupee(item.pricePaise)}`
                            : "";
                    const venue = item.restaurantName ? ` (${item.restaurantName})` : "";
                    lines.push(`${i + 1}. ${item.name}${venue}${price}`);
                });
                const cartCount = flow.cartItems?.length ?? 0;
                if (cartCount > 0) {
                    lines.push(
                        "\nTap a number or use the list to add more. Reply *place*/*confirm* to order, or *cancel* to stop.",
                    );
                } else {
                    lines.push("\nTap a number or use the list to add.");
                }
            }
        }
    }

    if (flow.phase === "review_cart" && flow.cartItems?.length) {
        lines.push("\n*Your basket:*");
        let itemSubtotal = 0;
        flow.cartItems.forEach((item) => {
            const lineTotal = item.pricePaise * item.quantity;
            itemSubtotal += lineTotal;
            lines.push(`• ${item.name} ×${item.quantity} — ${formatRupee(lineTotal)}`);
        });
        lines.push(...formatBillBreakdownLines(flow.billBreakdown, itemSubtotal));
        if (flow.healthSuggestions?.length) {
            lines.push("\n*Saheli tip — you decide:*");
            for (const tip of flow.healthSuggestions.slice(0, 3)) {
                lines.push(`• ${tip.text}`);
            }
        }
        lines.push(
            "\nReply *place*/*confirm* to order, or pick another number to add more. Say *cancel* to stop.",
        );
    }

    if (flow.phase === "submitted") {
        const status = String(flow.orderStatus ?? "").toLowerCase();
        const placed = status === "paid" || status === "delivered";
        // Only treat explicit awaiting_approval as approval-gated (elders place + notify).
        const awaiting = status === "awaiting_approval";
        if (placed) {
            lines.push(`\n✅ *Order placed on ${flow.partnerLabel}*`);
            lines.push("Your family has been notified.");
        } else if (awaiting) {
            lines.push(
                `\n🛒 *Basket submitted on ${flow.partnerLabel}* — waiting for family approval`,
            );
        } else if (status === "approved") {
            lines.push(
                `\n✅ *Basket approved* — placing with ${flow.partnerLabel}…`,
            );
        } else {
            lines.push(`\n🛒 *Basket submitted on ${flow.partnerLabel}*`);
        }
        if (flow.orderId) lines.push(`Reference: ${flow.orderId}`);
        if (flow.cartItems?.length) {
            let itemSubtotal = 0;
            flow.cartItems.forEach((item) => {
                const lineTotal = item.pricePaise * item.quantity;
                itemSubtotal += lineTotal;
                lines.push(`• ${item.name} ×${item.quantity}`);
            });
            lines.push(...formatBillBreakdownLines(flow.billBreakdown, itemSubtotal));
        }
        if (placed) {
            lines.push("\nI'll update you when it's on the way. Reply *status* anytime to check.");
        } else if (awaiting) {
            lines.push(
                "\nYour family can approve on WhatsApp or the dashboard. Reply *status* anytime.",
            );
        }
    }

    return lines.filter(Boolean).join("\n").trim();
}

export async function syncWhatsappOrderSession(
    phone: string,
    flow: OrderFlowPayload | null,
    pendingOrderId?: string,
): Promise<void> {
    if (!flow?.sessionId) {
        await WhatsappSession.findOneAndUpdate(
            { phone },
            {
                $unset: {
                    orderSessionId: "",
                    orderPhase: "",
                    pendingOrderId: "",
                    pendingOrderSwitchText: "",
                },
                $set: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
            },
        );
        return;
    }

    const phase = (flow.phase === "expired" ? undefined : flow.phase) as
        | WhatsappOrderPhase
        | undefined;

    await WhatsappSession.findOneAndUpdate(
        { phone },
        {
            $set: {
                orderSessionId: flow.sessionId,
                orderPhase: phase,
                pendingOrderId: pendingOrderId ?? flow.orderId,
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
        },
        { upsert: true },
    );
}

export async function clearWhatsAppOrderSession(phone: string): Promise<void> {
    await syncWhatsappOrderSession(phone, null);
}

function parseNumberChoice(text: string): number | null {
    const match = text.trim().match(/^\s*([1-9]\d?)\s*$/);
    if (!match) return null;
    return Number(match[1]) - 1;
}

/** Prefer interactive list/button ids; fall back to plain 1-based numbers. */
function parseItemChoice(text: string): number | null {
    const tagged = text.trim().match(/^item:(\d+)$/i);
    if (tagged) return Number(tagged[1]);
    return parseNumberChoice(text);
}

function parseRestaurantChoice(text: string): number | null {
    const tagged = text.trim().match(/^restaurant:(\d+)$/i);
    if (tagged) return Number(tagged[1]);
    return parseNumberChoice(text);
}

function isAddMore(text: string): boolean {
    const t = text.trim();
    return /^add_more$/i.test(t) || /^add\s+more$/i.test(t);
}

function normalizeWhatsAppOrderReplyText(text: string, interactiveId?: string): string {
    if (interactiveId?.trim()) return interactiveId.trim();
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    if (
        lines.length > 1 &&
        /pick a delivery|saved .* addresses|instamart|swiggy|zepto/i.test(lines[0] ?? "")
    ) {
        return lines.slice(1).join("\n").trim();
    }
    return text.trim();
}

function resolveAddressFromInbound(
    text: string,
    interactiveId: string | undefined,
    addresses: OrderSessionAddress[],
): OrderSessionAddress | null {
    const raw = interactiveId?.trim() || text.trim();
    const addrIdx = raw.match(/^addr:(\d+)$/i);
    if (addrIdx) {
        const picked = addresses[Number(addrIdx[1])];
        if (picked) return picked;
    }

    const numericIdx = parseNumberChoice(raw);
    if (numericIdx != null && addresses[numericIdx]) {
        return addresses[numericIdx]!;
    }

    const firstLine = raw.split("\n")[0]?.trim() ?? raw;
    const labelMatch =
        firstLine.match(/^(home|office|work|other)\b/i) ??
        raw.match(/\b(?:pick\s+)?(?:address\s+)?(home|office|work|other)\b/i) ??
        raw.match(/\b(?:to|at|for|use)\s+(home|office|work|other)\b/i);
    const label = labelMatch?.[1]?.toLowerCase();
    if (label) {
        const byLabel = addresses.find((addr) => addr.label.toLowerCase().includes(label));
        if (byLabel) return byLabel;
    }

    const haystack = raw.toLowerCase();
    for (const addr of addresses) {
        const labelNeedle = addr.label.toLowerCase();
        const lineNeedle = addr.line1.toLowerCase().slice(0, 24);
        if (labelNeedle && haystack.includes(labelNeedle)) return addr;
        if (lineNeedle.length >= 8 && haystack.includes(lineNeedle)) return addr;
    }

    return null;
}

function isConfirm(text: string): boolean {
    const t = text.trim();
    if (/^confirm_order$/i.test(t)) return true;
    return /\b(yes|confirm|ok|okay|place|submit|checkout|done|haan|ha|ji)\b/i.test(t);
}

function isDecline(text: string): boolean {
    const t = text.trim().toLowerCase();
    return (
        /^(no|nope|nah|nahi|nai|stay|keep|continue|don't|dont)([!.]?|\s+.*)?$/i.test(t) ||
        /\b(no\s+thanks|stay\s+in\s+(the\s+)?order|keep\s+(the\s+)?(basket|order)|don't\s+cancel|dont\s+cancel)\b/i.test(
            t,
        )
    );
}

const CANCEL_WORD =
    String.raw`cancel|cencel|cancle|canel|cnacel|stop|exit|exitt|quit|leave|abort|nevermind|never\s*mind`;


function shouldReleaseOrderSessionForCareTurn(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (/^\d{1,2}$/.test(t)) return false;
    if (
        /\b(pick|address|home|office|confirm|add|cart|browse|cancel|swiggy|instamart|zepto|order)\b/i.test(
            t,
        )
    ) {
        return false;
    }
    if (/^(\.{2,}|…+)$/u.test(t)) return true;
    return (
        /\b(remind|yaad|pain|dard|hurt|peeth|family|weather|mars|bill|doctor|paani|who is|tell\s+\w+|hurting|fever|bukhar|iphones?|laptops?|electronics)\b/i.test(
            t,
        ) ||
        /\bhow\s+much\b/i.test(t)
    );
}

function isExplicitOrderCancel(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (t === "cancel_order") return true;
    return (
        new RegExp(String.raw`^(?:${CANCEL_WORD})(?:\s+order)?[!?.]*$`, "i").test(t) ||
        /\b(?:cancel|cencel|cancle|canel)\s+(?:the\s+)?order\b/i.test(t) ||
        /\bstop\s+order\b/i.test(t)
    );
}

function isActiveSessionCancel(text: string): boolean {
    const t = text.trim();
    if (/^cancel_order$/i.test(t)) return true;
    if (new RegExp(String.raw`^(?:${CANCEL_WORD})(?:\s+order)?[!?.]*$`, "i").test(t)) return true;
    return new RegExp(
        String.raw`\b(?:cancel|cencel|cancle|canel|cnacel|stop(?:\s+order)?|exit|exitt|quit|leave|abort|nevermind|never\s*mind)\b`,
        "i",
    ).test(t);
}

function isChangeAddressIntent(text: string): boolean {
    const t = text.trim();
    if (/^change_address$/i.test(t) || /^quick_change_addr:/i.test(t)) return true;
    return (
        /\b(?:change|chahge|chang|chage|chnage)\s+(?:my\s+)?(?:delivery\s+)?address\b/i.test(t) ||
        /\bi\s+(?:want|wanna|need)\s+to\s+change\s+(?:my\s+)?(?:delivery\s+)?address\b/i.test(t) ||
        /\b(?:pick|other|different|new)\s+(?:delivery\s+)?address\b/i.test(t) ||
        /\b(?:delivery\s+)?address\s+change\b/i.test(t)
    );
}

async function setPendingOrderSwitchText(phone: string, text: string | null): Promise<void> {
    if (text == null || !text.trim()) {
        await WhatsappSession.findOneAndUpdate(
            { phone },
            {
                $unset: { pendingOrderSwitchText: "" },
                $set: { expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
            },
        );
        return;
    }
    await WhatsappSession.findOneAndUpdate(
        { phone },
        {
            $set: {
                pendingOrderSwitchText: text.trim(),
                expiresAt: new Date(Date.now() + SESSION_TTL_MS),
            },
        },
        { upsert: true },
    );
}

async function resetOrderFlowToAddressPick(input: {
    phone: string;
    familyId: string;
    actorUserId: string;
    orderSessionId: string;
}): Promise<WhatsAppOrderTurnResult> {
    await OrderSession.updateOne(
        { sessionId: input.orderSessionId, familyId: input.familyId },
        {
            $set: {
                phase: "select_address",
                cartItems: [],
                catalog: { restaurants: [], dishes: [], products: [] },
            },
            $unset: { selectedAddressId: "", pendingDisambiguation: "" },
        },
    );
    await setPendingOrderSwitchText(input.phone, null);
    const { getOrderFlowSession } = await import("./orderOrchestrator.service");
    const flow = await getOrderFlowSession({
        sessionId: input.orderSessionId,
        familyId: input.familyId,
        actorUserId: input.actorUserId,
    });
    await syncWhatsappOrderSession(input.phone, flow);
    const intro = flow.query
        ? `Ok — cancelled this basket. Still looking for "${flow.query}". Pick a new delivery address.`
        : "Ok — cancelled this basket. Pick a new delivery address.";
    return orderTurn(`${intro}\n\n${formatOrderFlowForWhatsApp({ ...flow, message: undefined })}`, flow);
}

async function cancelElderOrderSession(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    orderSessionId?: string;
}): Promise<{ cancelledPendingOrder: boolean }> {
    if (input.orderSessionId) {
        await OrderSession.updateOne(
            { sessionId: input.orderSessionId, familyId: input.familyId },
            { $set: { phase: "expired" } },
        );
    }
    await clearWhatsAppOrderSession(input.phone);
    const { cancelRecipientPendingOrder } = await import("./order.service");
    const cancelled = await cancelRecipientPendingOrder(
        input.familyId,
        input.recipientUserId,
        input.actorUserId,
    );
    return { cancelledPendingOrder: Boolean(cancelled) };
}

function formatOrderStatusReply(order: {
    orderId: string;
    partner: string;
    status: string;
    totalPaise: number;
    items: Array<{ name: string; quantity: number }>;
}): string {
    const items = order.items.map((i) => `${i.name} ×${i.quantity}`).join(", ");
    const total = `₹${(order.totalPaise / 100).toFixed(0)}`;
    return `Your latest ${order.partner} order (${total}): ${items}. Status: ${order.status.replace(/_/g, " ")}. Ref: ${order.orderId.slice(0, 8)}.`;
}

function orderTurn(text: string, orderFlow?: OrderFlowPayload): WhatsAppOrderTurnResult {
    return { text, orderFlow };
}

async function handleActiveOrderTurn(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    interactiveId?: string;
    orderSessionId: string;
    saheliSessionId?: string;
}): Promise<WhatsAppOrderTurnResult> {
    const text = normalizeWhatsAppOrderReplyText(input.text, input.interactiveId);
    const waMeta = await WhatsappSession.findOne({ phone: input.phone }).lean();
    const pendingSwitch = waMeta?.pendingOrderSwitchText?.trim() || "";

    if (isActiveSessionCancel(text)) {
        await setPendingOrderSwitchText(input.phone, null);
        const { cancelledPendingOrder } = await cancelElderOrderSession({
            phone: input.phone,
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            orderSessionId: input.orderSessionId,
        });
        return orderTurn(
            cancelledPendingOrder
                ? "Order cancelled — your basket was removed."
                : "Order cancelled. Tell me anytime if you'd like to order again.",
        );
    }

    if (pendingSwitch) {
        if (isConfirm(text)) {
            await setPendingOrderSwitchText(input.phone, null);
            await cancelElderOrderSession({
                phone: input.phone,
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                orderSessionId: input.orderSessionId,
            });
            return { text: "", reprocessText: pendingSwitch };
        }
        if (isDecline(text)) {
            await setPendingOrderSwitchText(input.phone, null);
            return orderTurn("Okay — staying with this order. What would you like next?");
        }
    }

    if (isChangeAddressIntent(text)) {
        return resetOrderFlowToAddressPick({
            phone: input.phone,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            orderSessionId: input.orderSessionId,
        });
    }

    const itemIdx = parseItemChoice(text);
    const restaurantIdx = parseRestaurantChoice(text);
    const plainIdx = parseNumberChoice(text);
    const { getOrderFlowSession } = await import("./orderOrchestrator.service");
    let flow = await getOrderFlowSession({
        sessionId: input.orderSessionId,
        familyId: input.familyId,
        actorUserId: input.actorUserId,
    });

    if (isAddMore(text) && (flow.phase === "review_cart" || flow.phase === "browse")) {
        await OrderSession.updateOne(
            { sessionId: input.orderSessionId, familyId: input.familyId },
            { $set: { phase: "browse" } },
        );
        flow = await getOrderFlowSession({
            sessionId: input.orderSessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
        });
        await setPendingOrderSwitchText(input.phone, null);
        await syncWhatsappOrderSession(input.phone, flow);
        return orderTurn(formatOrderFlowForWhatsApp({ ...flow, message: undefined }), flow);
    }

    if (flow.phase === "select_address" && flow.addresses?.length) {
        const matched = resolveAddressFromInbound(text, input.interactiveId, flow.addresses);
        if (matched) {
            flow = await selectOrderFlowAddress({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                addressId: matched.id,
            });
            await setPendingOrderSwitchText(input.phone, null);
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }
    }

    if (/\bretry\b/i.test(text) && flow.selectedAddressId) {
        try {
            const { searchOrderFlowCatalog } = await import("./orderOrchestrator.service");
            flow = await searchOrderFlowCatalog({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
            });
            await setPendingOrderSwitchText(input.phone, null);
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        } catch (err) {
            console.warn("WhatsApp order catalog retry failed:", err);
            return orderTurn(
                `Still having trouble searching ${flow.partnerLabel}. Reply *retry* to search again, *change address* to pick another address, or *cancel* to stop.`,
                flow,
            );
        }
    }

    if (flow.disambiguation?.candidates?.length && plainIdx != null) {
        const { addToOrderCart } = await import("./orderKernel.service");
        const result = await addToOrderCart({
            sessionId: input.orderSessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            items: [{ candidateIndex: plainIdx, quantity: 1 }],
        });
        flow = (result.orderFlow as typeof flow) ?? flow;
        await setPendingOrderSwitchText(input.phone, null);
        await syncWhatsappOrderSession(input.phone, flow);
        return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
    }

    if (flow.phase === "browse") {
        const restaurants = flow.catalog?.restaurants ?? [];
        const taggedRestaurant = /^restaurant:\d+$/i.test(text.trim());
        const taggedItem = /^item:\d+$/i.test(text.trim());
        const restaurantOnly =
            restaurants.length > 0 &&
            !(flow.catalog?.dishes?.length || flow.catalog?.products?.length);

        // restaurant:N, or plain number on a restaurant-only catalog
        const rIdx = taggedRestaurant
            ? restaurantIdx
            : restaurantOnly && !taggedItem
              ? plainIdx
              : null;
        if (rIdx != null && restaurants[rIdx]?.restaurantId) {
            flow = await loadOrderFlowRestaurantMenu({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                restaurantId: restaurants[rIdx]!.restaurantId!,
            });
            await setPendingOrderSwitchText(input.phone, null);
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }

        const items = catalogItems(flow);
        if (itemIdx != null && items[itemIdx] && !taggedRestaurant) {
            const picked = items[itemIdx]!;
            flow = await addOrderFlowCartItem({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                item: {
                    itemId: picked.itemId ?? picked.id,
                    name: picked.name,
                    quantity: 1,
                    pricePaise: picked.pricePaise,
                    restaurantId: picked.restaurantId,
                    restaurantName: picked.restaurantName,
                },
            });
            await setPendingOrderSwitchText(input.phone, null);
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }
    }

    if (flow.phase === "review_cart") {
        if (isConfirm(text)) {
            await setPendingOrderSwitchText(input.phone, null);
            const { flow: submitted, order } = await submitOrderFlowCart({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
            });
            const orderId = typeof order.orderId === "string" ? order.orderId : submitted.orderId;
            const pendingApproval = String(order.status ?? "") === "awaiting_approval";
            await syncWhatsappOrderSession(input.phone, submitted, orderId);
            if (pendingApproval) {
                return orderTurn(
                    formatOrderFlowForWhatsApp(submitted) ||
                        "Basket ready — waiting for your family to approve on WhatsApp or the dashboard.",
                    submitted,
                );
            }
            const st = String(order.status ?? submitted.orderStatus ?? "");
            const placedMsg =
                st === "paid" || st === "delivered"
                    ? "Order placed! You'll get updates when it's on the way."
                    : "Basket submitted. You'll get updates after checkout.";
            return orderTurn(formatOrderFlowForWhatsApp(submitted) || placedMsg, submitted);
        }

        const items = catalogItems(flow);
        if (itemIdx != null && items[itemIdx] && !/^restaurant:/i.test(text.trim())) {
            const picked = items[itemIdx]!;
            flow = await addOrderFlowCartItem({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                item: {
                    itemId: picked.itemId ?? picked.id,
                    name: picked.name,
                    quantity: 1,
                    pricePaise: picked.pricePaise,
                    restaurantId: picked.restaurantId,
                    restaurantName: picked.restaurantName,
                },
            });
            await setPendingOrderSwitchText(input.phone, null);
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }
    }

    if (isConfirm(text) && flow.cartItems?.length) {
        await setPendingOrderSwitchText(input.phone, null);
        const { flow: submitted, order } = await submitOrderFlowCart({
            sessionId: input.orderSessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
        });
        await syncWhatsappOrderSession(input.phone, submitted, submitted.orderId);
        if (String(order.status ?? "") === "awaiting_approval") {
            return orderTurn(
                "Basket ready — waiting for family approval before checkout.",
                submitted,
            );
        }
        const st2 = String(order.status ?? submitted.orderStatus ?? "");
        const placedMsg2 =
            st2 === "paid" || st2 === "delivered"
                ? "Order placed! You'll get updates when it's on the way."
                : "Basket submitted. You'll get updates after checkout.";
        return orderTurn(formatOrderFlowForWhatsApp(submitted) || placedMsg2, submitted);
    }

    // Non-order ask while session is open — offer cancel-and-switch instead of a hard lock.
    await setPendingOrderSwitchText(input.phone, text);
    return orderTurn(
        `You're in the middle of a ${flow.partnerLabel} order. Should I cancel this basket and do what you just asked instead? Reply *yes* or *no*.`,
        flow,
    );
}

export type WhatsAppOrderTurnResult = {
    text: string;
    orderFlow?: OrderFlowPayload;
    /** After cancel-and-switch confirm: routing should re-run this as a fresh inbound. */
    reprocessText?: string;
    quickConfirm?: {
        sessionId: string;
        partner: string;
        partnerLabel: string;
        items: Array<{ name: string; pricePaise: number; quantity: number }>;
        totalPaise: number;
        address: { id: string; label: string; line1?: string };
    };
};

export async function tryHandleOrderStatusQuery(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
}): Promise<WhatsAppOrderTurnResult | null> {
    const t = input.text.trim().toLowerCase();
    if (!/^(status|order status)$/.test(t) && !/\b(where is my order|track order|order status)\b/.test(t)) {
        return null;
    }

    const { executeSaheliTool } = await import("./saheliTools.service");
    const result = await executeSaheliTool({
        tool: "get_order_status",
        args: {},
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
    });

    if (result.error) {
        return orderTurn("I don't see a recent order yet. Say what you'd like to order anytime.");
    }

    return orderTurn(
        formatOrderStatusReply({
            orderId: String(result.orderId ?? ""),
            partner: String(result.partner ?? "order"),
            status: String(result.status ?? "unknown"),
            totalPaise: Number(result.totalPaise ?? 0),
            items: Array.isArray(result.items)
                ? (result.items as Array<{ name: string; quantity: number }>)
                : [],
        }),
    );
}

export async function tryHandleWhatsAppOrderTurn(input: {
    phone: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    text: string;
    interactiveId?: string;
    saheliSessionId?: string;
}): Promise<WhatsAppOrderTurnResult | null> {
    const waSession = await WhatsappSession.findOne({ phone: input.phone }).lean();
    const text = normalizeWhatsAppOrderReplyText(input.text, input.interactiveId);
    if (!text) return null;

    const statusReply = await tryHandleOrderStatusQuery({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        text,
    });
    if (statusReply) return statusReply;

    if (isExplicitOrderCancel(text)) {
        const { cancelledPendingOrder } = await cancelElderOrderSession({
            phone: input.phone,
            familyId: input.familyId,
            recipientUserId: input.recipientUserId,
            actorUserId: input.actorUserId,
            orderSessionId: waSession?.orderSessionId,
        });
        return orderTurn(
            cancelledPendingOrder
                ? "Order cancelled — your basket was removed."
                : "Order cancelled. Tell me anytime if you'd like to order again.",
        );
    }

    const orderSessionId = waSession?.orderSessionId;
    if (orderSessionId) {
        if (shouldReleaseOrderSessionForCareTurn(text)) {
            await clearWhatsAppOrderSession(input.phone);
            return null;
        }
        const { isActiveOrderSession } = await import("./orderSessionRecovery.service");
        if (!(await isActiveOrderSession(orderSessionId, input.familyId))) {
            await clearWhatsAppOrderSession(input.phone);
            return null;
        }
        try {
            return await handleActiveOrderTurn({
                phone: input.phone,
                familyId: input.familyId,
                recipientUserId: input.recipientUserId,
                actorUserId: input.actorUserId,
                text,
                interactiveId: input.interactiveId,
                orderSessionId,
                saheliSessionId: input.saheliSessionId ?? waSession?.saheliSessionId,
            });
        } catch (err) {
            console.warn("WhatsApp order turn failed:", err);
            if (err instanceof AppError && err.statusCode === 410) {
                await clearWhatsAppOrderSession(input.phone);
                return orderTurn(
                    "That order session expired. Say what you'd like to order and we'll start fresh.",
                );
            }
            const phase = waSession?.orderPhase;
            if (err instanceof AppError) {
                if (phase === "select_address") {
                    return orderTurn(
                        `Couldn't continue (${err.message}). Tap *Pick address* again, reply with *1*/*2*/*3*, or type *Home*, or say *cancel*.`,
                    );
                }
                return orderTurn(
                    `Couldn't add that item (${err.message}). Tap *Browse items* again or pick another, or say *cancel*.`,
                );
            }
            if (phase === "select_address") {
                return orderTurn(
                    "I hit a snag on that order step — your basket is still open. Tap *Pick address* again, reply with *1*/*2*/*3*, or type *Home*.",
                );
            }
            return orderTurn(
                "I hit a snag on that order step — your basket is still open. Tap *Browse items* again, pick another item, or say *cancel*.",
            );
        }
    }

    const {
        isHighConfidenceOrderIntent,
        isSoftOrderIntent,
        messageLooksLikeUnsupportedCommerce,
        unsupportedCommerceReply,
    } = await import("./saheliOrder.service");
    if (messageLooksLikeUnsupportedCommerce(text)) {
        return orderTurn(unsupportedCommerceReply());
    }
    let allowQuick = isHighConfidenceOrderIntent(text);
    if (!allowQuick && isSoftOrderIntent(text)) {
        // Soft ask — still enter quickOrder when a last-used partner address exists.
        try {
            const { getLastSuccessfulAddress } = await import("./elderPartnerAddress.service");
            const partners = ["instamart", "zepto", "swiggy"] as const;
            for (const p of partners) {
                const last = await getLastSuccessfulAddress(input.familyId, input.recipientUserId, p);
                if (last?.addressId) {
                    allowQuick = true;
                    break;
                }
            }
        } catch {
            /* ignore — fall through */
        }
    }
    if (!allowQuick) {
        return null;
    }

    const { quickOrder } = await import("./orderKernel.service");
    const quick = await quickOrder({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: text,
        saheliSessionId: input.saheliSessionId ?? waSession?.saheliSessionId,
    });

    if (quick.status === "confirm_ready" && quick.sessionId && quick.items?.length && quick.address) {
        if (quick.orderFlow?.sessionId) {
            await syncWhatsappOrderSession(input.phone, quick.orderFlow);
        }
        return {
            text: quick.message,
            orderFlow: quick.orderFlow,
            quickConfirm: {
                sessionId: quick.sessionId,
                partner: quick.partner,
                partnerLabel: quick.partnerLabel,
                items: quick.items,
                totalPaise: quick.totalPaise ?? 0,
                address: quick.address,
            },
        };
    }

    if (quick.status === "partner_not_connected") {
        const connectFlow = {
            sessionId: "",
            phase: "browse" as const,
            partner: quick.partner,
            partnerLabel: quick.partnerLabel,
            query: quick.query,
            connectPartner: quick.partner,
            connectUrl: quick.connectUrl ?? null,
            message: quick.message,
        };
        return orderTurn(quick.message, connectFlow);
    }

    if (quick.status === "partner_error") {
        return orderTurn(quick.message, quick.orderFlow);
    }

    // Prefer one confirm that asks address once — not the full multi-step wizard.
    if (quick.status === "needs_address") {
        if (quick.orderFlow?.sessionId) {
            await syncWhatsappOrderSession(input.phone, quick.orderFlow);
        }
        return orderTurn(quick.message, quick.orderFlow);
    }

    if (quick.status === "no_results") {
        return orderTurn(quick.message, quick.orderFlow);
    }

    const { tryStartOrderFromMessage } = await import("./orderKernel.service");
    const kernel = await tryStartOrderFromMessage({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        message: text,
        saheliSessionId: input.saheliSessionId ?? waSession?.saheliSessionId,
    });
    if (!kernel) return null;

    if (kernel.orderFlow?.sessionId) {
        await syncWhatsappOrderSession(input.phone, kernel.orderFlow);
    }
    return orderTurn(kernel.reply, kernel.orderFlow);
}
