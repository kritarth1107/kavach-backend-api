import WhatsappSession, { type WhatsappOrderPhase } from "../models/whatsappSession.model";
import OrderSession from "../models/orderSession.model";
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
    } else if (flow.phase === "browse") {
        const items = catalogItems(flow);
        if (items.length) {
            lines.push(`\n*${flow.partnerLabel} options for "${flow.query}":*`);
            items.slice(0, 8).forEach((item, i) => {
                const price =
                    item.pricePaise && item.pricePaise > 0
                        ? ` — ${formatRupee(item.pricePaise)}`
                        : "";
                const venue = item.restaurantName ? ` (${item.restaurantName})` : "";
                lines.push(`${i + 1}. ${item.name}${venue}${price}`);
            });
            lines.push('\nReply with a number to add to cart, or *confirm* when ready.');
        }
        const restaurants = flow.catalog?.restaurants ?? [];
        if (restaurants.length && !(flow.catalog?.dishes?.length || flow.catalog?.products?.length)) {
            lines.push("\n*Restaurants:*");
            restaurants.slice(0, 6).forEach((r, i) => {
                lines.push(`${i + 1}. ${r.name}`);
            });
            lines.push('\nReply with a number to see the menu.');
        }
    }

    if (flow.phase === "review_cart" && flow.cartItems?.length) {
        lines.push("\n*Your basket:*");
        let total = 0;
        flow.cartItems.forEach((item) => {
            const lineTotal = item.pricePaise * item.quantity;
            total += lineTotal;
            lines.push(`• ${item.name} ×${item.quantity} — ${formatRupee(lineTotal)}`);
        });
        lines.push(`\n*Total:* ${formatRupee(total)}`);
        lines.push('\nReply *confirm* to place the order, or pick another item number to add more.');
    }

    if (flow.phase === "submitted") {
        lines.push(`\n✅ *Order placed on ${flow.partnerLabel}*`);
        if (flow.orderId) lines.push(`Reference: ${flow.orderId}`);
        if (flow.cartItems?.length) {
            let total = 0;
            flow.cartItems.forEach((item) => {
                const lineTotal = item.pricePaise * item.quantity;
                total += lineTotal;
                lines.push(`• ${item.name} ×${item.quantity}`);
            });
            lines.push(`*Total:* ${formatRupee(total)}`);
        }
        lines.push("\nI'll update you when it's on the way. Reply *status* anytime to check.");
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
                $unset: { orderSessionId: "", orderPhase: "", pendingOrderId: "" },
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

function isConfirm(text: string): boolean {
    return /\b(yes|confirm|ok|okay|place|submit|checkout|done|haan|ha|ji)\b/i.test(text.trim());
}

function isExplicitOrderCancel(text: string): boolean {
    const t = text.trim().toLowerCase();
    return (
        /^cancel(\s+order)?$/.test(t) ||
        /\bcancel\s+(the\s+)?order\b/.test(t) ||
        /\bstop\s+order\b/.test(t)
    );
}

function isActiveSessionCancel(text: string): boolean {
    return /\b(cancel|stop|nevermind|never mind|abort)\b/i.test(text.trim());
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
    orderSessionId: string;
    saheliSessionId?: string;
}): Promise<WhatsAppOrderTurnResult> {
    const text = input.text.trim();
    if (isActiveSessionCancel(text)) {
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

    const idx = parseNumberChoice(text);
    const { getOrderFlowSession } = await import("./orderOrchestrator.service");
    let flow = await getOrderFlowSession({
        sessionId: input.orderSessionId,
        familyId: input.familyId,
        actorUserId: input.actorUserId,
    });

    if (flow.phase === "select_address" && idx != null && flow.addresses?.[idx]) {
        flow = await selectOrderFlowAddress({
            sessionId: input.orderSessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            addressId: flow.addresses[idx]!.id,
        });
        await syncWhatsappOrderSession(input.phone, flow);
        return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
    }

    if (flow.disambiguation?.candidates?.length && idx != null) {
        const { addToOrderCart } = await import("./orderKernel.service");
        const result = await addToOrderCart({
            sessionId: input.orderSessionId,
            familyId: input.familyId,
            actorUserId: input.actorUserId,
            items: [{ candidateIndex: idx, quantity: 1 }],
        });
        flow = (result.orderFlow as typeof flow) ?? flow;
        await syncWhatsappOrderSession(input.phone, flow);
        return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
    }

    if (flow.phase === "browse") {
        const restaurants = flow.catalog?.restaurants ?? [];
        if (idx != null && restaurants[idx]?.restaurantId) {
            flow = await loadOrderFlowRestaurantMenu({
                sessionId: input.orderSessionId,
                familyId: input.familyId,
                actorUserId: input.actorUserId,
                restaurantId: restaurants[idx]!.restaurantId!,
            });
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }

        const items = catalogItems(flow);
        if (idx != null && items[idx]) {
            const picked = items[idx]!;
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
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }
    }

    if (flow.phase === "review_cart") {
        if (isConfirm(text)) {
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
            return orderTurn(
                formatOrderFlowForWhatsApp(submitted) ||
                    "Order placed! You'll get updates when it's on the way.",
                submitted,
            );
        }

        const items = catalogItems(flow);
        if (idx != null && items[idx]) {
            const picked = items[idx]!;
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
            await syncWhatsappOrderSession(input.phone, flow);
            return orderTurn(formatOrderFlowForWhatsApp(flow), flow);
        }
    }

    if (isConfirm(text) && flow.cartItems?.length) {
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
        return orderTurn(formatOrderFlowForWhatsApp(submitted) || "Order placed!", submitted);
    }

    return orderTurn(
        `Still in your ${flow.partnerLabel} order. ${formatOrderFlowForWhatsApp(flow)}`,
        flow,
    );
}

export type WhatsAppOrderTurnResult = {
    text: string;
    orderFlow?: OrderFlowPayload;
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
    saheliSessionId?: string;
}): Promise<WhatsAppOrderTurnResult | null> {
    const waSession = await WhatsappSession.findOne({ phone: input.phone }).lean();
    const text = input.text.trim();
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
                orderSessionId,
                saheliSessionId: input.saheliSessionId ?? waSession?.saheliSessionId,
            });
        } catch (err) {
            console.warn("WhatsApp order turn failed:", err);
            await clearWhatsAppOrderSession(input.phone);
            return orderTurn(
                "That order session expired. Say what you'd like to order and we'll start fresh.",
            );
        }
    }

    // New orders are AI-first — Saheli agent starts flows via tools when appropriate.
    return null;
}
