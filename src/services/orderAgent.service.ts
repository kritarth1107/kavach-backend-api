import { AppError } from "../middleware/error.middleware";
import OrderPreview from "../models/orderPreview.model";
import type { McpCatalogHit } from "../partners/mcp/mcpClient.service";
import { resolveCatalogFromHits } from "./catalogResolver.service";
import type { McpPartnerKey } from "../partners/mcp/types";
import { searchMcpProduct } from "../partners/mcp/mcpClient.service";
import { OrderPartner, OrderStatus } from "../types/careRecord.types";
import { getFamilyForActor, requireCareRecipient, requirePermission } from "./careRecordAuth.service";
import { resolveFamilyMcpUserId, listFamilyConnectedPartners } from "./commerceConnection.service";
import { ensurePartnerAddressesSynced, listPartnerAddresses } from "./partnerAddress.service";
import {
    partnerLabel,
    pickOrderPartner,
    parseExplicitPartner,
} from "./saheliOrder.service";
import { payCommerceOrder } from "../partners/commerce.adapter";
import Order from "../models/order.model";
import { appendCareRecordEvent } from "./careRecord.service";
import { CareRecordEventType, CareRecordSource, ChannelType } from "../types/careRecord.types";

const PREVIEW_TTL_MS = 30 * 60 * 1000;

function mcpToOrderPartner(partner: McpPartnerKey): OrderPartner {
    if (partner === "swiggy") return OrderPartner.SWIGGY;
    if (partner === "instamart") return OrderPartner.INSTAMART;
    return OrderPartner.ZEPTO;
}

function orderPartnerToMcp(partner: OrderPartner): McpPartnerKey | null {
    if (partner === OrderPartner.SWIGGY) return "swiggy";
    if (partner === OrderPartner.INSTAMART) return "instamart";
    if (partner === OrderPartner.ZEPTO) return "zepto";
    return null;
}

function pickPricedHit(hits: McpCatalogHit[], partner: McpPartnerKey): McpCatalogHit | undefined {
    if (partner === "swiggy") {
        return (
            hits.find((h) => h.kind === "dish" && h.pricePaise) ??
            hits.find((h) => h.kind === "dish") ??
            undefined
        );
    }
    return (
        hits.find((h) => h.kind === "product" && h.pricePaise) ??
        hits.find((h) => h.kind === "product") ??
        hits.find((h) => h.pricePaise) ??
        undefined
    );
}

export async function resolveOrderPartnerForMessage(input: {
    message: string;
    familyId: string;
    actorUserId: string;
}) {
    const partner = await pickOrderPartner(input.message, input.familyId, input.actorUserId);
    const mcpPartner = orderPartnerToMcp(partner);
    const connected = await listFamilyConnectedPartners(input.familyId, input.actorUserId);
    const explicit = parseExplicitPartner(input.message);
    const isConnected =
        (partner === OrderPartner.SWIGGY && connected.swiggy) ||
        (partner === OrderPartner.INSTAMART && connected.instamart) ||
        (partner === OrderPartner.ZEPTO && connected.zepto);

    const { getOrderPartnerAvailability } = await import("./orderPartnerAvailability.service");
    const availability = await getOrderPartnerAvailability(input.familyId, input.actorUserId);
    const connectedPartners = availability
        .filter((r) => r.connected && r.serviceable)
        .map((r) => r.label);
    const unavailableReason = availability.find(
        (r) => r.partner === mcpPartner && r.connected && !r.serviceable,
    )?.reason;

    return {
        partner,
        mcpPartner,
        partnerLabel: partnerLabel(partner),
        connected: isConnected,
        serviceable: availability.find((r) => r.partner === mcpPartner)?.serviceable ?? isConnected,
        unavailableReason,
        connectedPartners,
        explicit,
        intent: partner === OrderPartner.SWIGGY ? "food" : "grocery",
        message: !isConnected
            ? `${partnerLabel(partner)} is not connected. Connected now: ${connectedPartners.join(", ") || "none"}.`
            : unavailableReason === "closed_or_unavailable" && mcpPartner === "swiggy"
              ? "Swiggy is connected but not taking orders at your address right now (closed for the day)."
              : undefined,
    };
}

export async function previewOrder(input: {
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    partner: McpPartnerKey;
    addressId: string;
    items: Array<{ name: string; quantity: number }>;
    notes?: string;
}) {
    const family = await getFamilyForActor(input.familyId, input.actorUserId);
    requireCareRecipient(family, input.recipientUserId);

    const commerceUserId =
        (await resolveFamilyMcpUserId(input.familyId, input.partner, input.actorUserId)) ??
        input.actorUserId;

    await ensurePartnerAddressesSynced(input.partner, input.familyId, commerceUserId);
    const addresses = await listPartnerAddresses(input.familyId, input.partner, commerceUserId);
    const { filterStoreAddressesToBook } = await import("./familyAddressBook.service");
    const bookAddresses = await filterStoreAddressesToBook(input.familyId, addresses);
    const address = bookAddresses.find((a) => a.partner_address_id === input.addressId);
    if (!address) {
        throw new AppError(
            `That ${input.partner} address isn't in your family's address book. Use an address that matches a saved place (pincode + street).`,
            400,
        );
    }

    const pricedItems = [];
    for (const item of input.items) {
        const search = await searchMcpProduct(
            input.partner,
            input.familyId,
            commerceUserId,
            item.name,
            { addressId: input.addressId },
        );
        if (search.error === "no_address") {
            throw new AppError("Select a delivery address before searching.", 400);
        }
        const resolved = resolveCatalogFromHits(item.name, search.items, input.partner);
        if (resolved.status === "disambiguation_required") {
            const options = resolved.candidates
                .slice(0, 3)
                .map((c) => `${c.name}${c.pricePaise ? ` ₹${(c.pricePaise / 100).toFixed(0)}` : ""}`)
                .join("; ");
            throw new AppError(
                `Multiple matches for "${item.name}": ${options}. Ask for the exact product.`,
                400,
            );
        }
        if (resolved.status === "not_found") {
            throw new AppError(resolved.message, 400);
        }
        const hit = resolved.hit;
        if (!hit?.pricePaise) {
            throw new AppError(
                `No live price found for "${item.name}" on ${partnerLabel(mcpToOrderPartner(input.partner))}. Try a more specific name from search results.`,
                400,
            );
        }
        pricedItems.push({
            name: hit.matchedName ?? hit.name,
            quantity: Math.min(item.quantity, 20),
            unitPricePaise: hit.pricePaise,
            itemId: hit.itemId,
            spinId: hit.spinId,
            restaurantId: hit.restaurantId,
            restaurantName: hit.restaurantName,
        });
    }

    const totalPaise = pricedItems.reduce((sum, row) => sum + row.quantity * row.unitPricePaise, 0);
    const deliveryAddress = [address.label, address.line1, address.city, address.pincode]
        .filter(Boolean)
        .join(" · ");

    const preview = await OrderPreview.create({
        familyId: input.familyId,
        recipientUserId: input.recipientUserId,
        actorUserId: input.actorUserId,
        partner: input.partner,
        partnerAddressId: input.addressId,
        addressLabel: address.label || undefined,
        deliveryAddress,
        items: pricedItems,
        totalPaise,
        placed: false,
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
    });

    return {
        kind: "order_preview" as const,
        previewId: preview.previewId,
        partner: input.partner,
        partnerLabel: partnerLabel(mcpToOrderPartner(input.partner)),
        addressLabel: address.label,
        deliveryAddress,
        items: pricedItems,
        totalPaise,
        notes: input.notes,
    };
}

export async function placeCodOrderFromPreview(input: {
    familyId: string;
    previewId: string;
    actorUserId: string;
}) {
    const family = await getFamilyForActor(input.familyId, input.actorUserId);
    requirePermission(family, input.actorUserId, "approve_order");

    const preview = await OrderPreview.findOne({
        previewId: input.previewId,
        familyId: input.familyId,
        actorUserId: input.actorUserId,
        placed: false,
        expiresAt: { $gt: new Date() },
    });
    if (!preview) throw new AppError("Order preview expired or not found. Ask Saheli to rebuild the basket.", 404);

    const orderPartner = mcpToOrderPartner(preview.partner);
    const commerceUserId =
        (await resolveFamilyMcpUserId(input.familyId, preview.partner, input.actorUserId)) ??
        input.actorUserId;

    const order = await Order.create({
        familyId: preview.familyId,
        subjectUserId: preview.recipientUserId,
        suggestedBy: input.actorUserId,
        approvedBy: input.actorUserId,
        partner: orderPartner,
        status: OrderStatus.APPROVED,
        items: preview.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            unitPricePaise: i.unitPricePaise,
        })),
        totalPaise: preview.totalPaise,
        deliveryAddress: preview.deliveryAddress,
        partnerAddressId: preview.partnerAddressId,
    });

    const payment = await payCommerceOrder({
        partner: orderPartner,
        orderId: order.orderId,
        amountPaise: order.totalPaise,
        payerUserId: commerceUserId,
        familyId: input.familyId,
        items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
        paymentMethod: "COD",
        addressId: preview.partnerAddressId,
    });

    order.status = OrderStatus.PAID;
    order.partnerRef = payment.partnerRef ?? order.partnerRef;
    await order.save();

    preview.placed = true;
    preview.orderId = order.orderId;
    await preview.save();

    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: preview.recipientUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.ORDER_PAID,
        source: CareRecordSource.SAHELI,
        channel: ChannelType.DASHBOARD,
        title: `${partnerLabel(orderPartner)} COD order placed`,
        detail: `₹${(order.totalPaise / 100).toFixed(0)} · ${order.items.map((i) => `${i.name} x${i.quantity}`).join(", ")}`,
        payload: { orderId: order.orderId, partnerRef: order.partnerRef },
        status: "paid",
    });

    return {
        kind: "order_placed" as const,
        orderId: order.orderId,
        partner: orderPartner,
        partnerLabel: partnerLabel(orderPartner),
        totalPaise: order.totalPaise,
        partnerRef: order.partnerRef,
        status: order.status,
        items: order.items,
        deliveryAddress: order.deliveryAddress,
    };
}
