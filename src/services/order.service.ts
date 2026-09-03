import Order from "../models/order.model";
import { AppError } from "../middleware/error.middleware";
import { appendCareRecordEvent } from "./careRecord.service";
import {
    CareRecordEventType,
    CareRecordSource,
    ChannelType,
    OrderPartner,
    OrderStatus,
} from "../types/careRecord.types";
import {
    getFamilyForActor,
    requireCareRecipient,
    requirePermission,
} from "./careRecordAuth.service";
import { createZeptoOrder, payZeptoOrder } from "../partners/zepto.adapter";

export async function suggestOrder(input: {
    familyId: string;
    subjectUserId: string;
    actorUserId: string;
    items: Array<{ name: string; quantity: number; unitPricePaise: number }>;
    notes?: string;
    deliveryAddress?: string;
}) {
    const family = await getFamilyForActor(input.familyId, input.actorUserId);
    requireCareRecipient(family, input.subjectUserId);

    const partnerResult = await createZeptoOrder({
        familyId: input.familyId,
        actorUserId: input.actorUserId,
        items: input.items,
        deliveryAddress: input.deliveryAddress,
    });

    const orderItems = partnerResult.pricedItems ?? input.items;
    const totalPaise = orderItems.reduce(
        (sum, item) => sum + item.quantity * item.unitPricePaise,
        0,
    );

    const order = await Order.create({
        familyId: input.familyId,
        subjectUserId: input.subjectUserId,
        suggestedBy: input.actorUserId,
        partner: OrderPartner.ZEPTO,
        status: OrderStatus.AWAITING_APPROVAL,
        items: orderItems,
        totalPaise,
        deliveryAddress: input.deliveryAddress,
        deepLink: partnerResult.deepLink,
        partnerRef: partnerResult.partnerRef,
        notes: input.notes,
    });

    const detail = input.items.map((i) => `${i.name} x${i.quantity}`).join(" · ");
    await appendCareRecordEvent({
        familyId: input.familyId,
        subjectUserId: input.subjectUserId,
        actorUserId: input.actorUserId,
        type: CareRecordEventType.ORDER_SUGGESTED,
        source: CareRecordSource.SAHELI,
        channel: ChannelType.DASHBOARD,
        title: `Zepto basket suggested — ₹${(totalPaise / 100).toFixed(0)}`,
        detail,
        payload: {
            orderId: order.orderId,
            items: orderItems,
            deepLink: partnerResult.deepLink,
            source: partnerResult.source,
        },
        status: "awaiting_approval",
    });

    return order;
}

export async function listPendingApprovals(familyId: string, actorUserId: string) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    return Order.find({
        familyId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    })
        .sort({ createdAt: -1 })
        .lean();
}

export async function approveOrder(familyId: string, orderId: string, actorUserId: string) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");

    const order = await Order.findOne({ orderId, familyId });
    if (!order) throw new AppError("Order not found", 404);
    if (order.status !== OrderStatus.AWAITING_APPROVAL) {
        throw new AppError("Order is not awaiting approval", 400);
    }

    order.status = OrderStatus.APPROVED;
    order.approvedBy = actorUserId;
    await order.save();

    await appendCareRecordEvent({
        familyId,
        subjectUserId: order.subjectUserId,
        actorUserId,
        type: CareRecordEventType.ORDER_APPROVED,
        source: CareRecordSource.DASHBOARD,
        channel: ChannelType.DASHBOARD,
        title: "Grocery order approved",
        detail: `Zepto basket ₹${(order.totalPaise / 100).toFixed(0)} approved`,
        payload: { orderId: order.orderId },
        status: "approved",
    });

    return order;
}

export async function payOrder(familyId: string, orderId: string, actorUserId: string) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");

    const order = await Order.findOne({ orderId, familyId });
    if (!order) throw new AppError("Order not found", 404);
    if (order.status !== OrderStatus.APPROVED) {
        throw new AppError("Order must be approved before payment", 400);
    }

    const payment = await payZeptoOrder({
        orderId: order.orderId,
        amountPaise: order.totalPaise,
        payerUserId: actorUserId,
        familyId,
        items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
        paymentMethod: "cod",
    });

    order.status = OrderStatus.PAID;
    order.partnerRef = payment.partnerRef ?? order.partnerRef;
    await order.save();

    await appendCareRecordEvent({
        familyId,
        subjectUserId: order.subjectUserId,
        actorUserId,
        type: CareRecordEventType.ORDER_PAID,
        source: CareRecordSource.DASHBOARD,
        channel: ChannelType.DASHBOARD,
        title: "Payment recorded",
        detail: `₹${(order.totalPaise / 100).toFixed(0)} paid via ${payment.provider}`,
        payload: {
            orderId: order.orderId,
            paymentId: payment.paymentId,
            paymentLink: payment.paymentLink,
        },
        status: "paid",
    });

    if (payment.markDelivered) {
        await markOrderDelivered(familyId, orderId, actorUserId);
    }

    return { order, payment };
}

export async function markOrderDelivered(
    familyId: string,
    orderId: string,
    actorUserId: string,
) {
    const order = await Order.findOne({ orderId, familyId });
    if (!order) throw new AppError("Order not found", 404);

    order.status = OrderStatus.DELIVERED;
    await order.save();

    await appendCareRecordEvent({
        familyId,
        subjectUserId: order.subjectUserId,
        actorUserId,
        type: CareRecordEventType.ORDER_DELIVERED,
        source: CareRecordSource.SYSTEM,
        channel: ChannelType.DASHBOARD,
        title: "Zepto order delivered",
        detail: order.items.map((i) => i.name).join(", "),
        payload: { orderId: order.orderId },
        status: "delivered",
    });

    return order;
}

export async function rejectOrder(familyId: string, orderId: string, actorUserId: string) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "approve_order");

    const order = await Order.findOne({ orderId, familyId });
    if (!order) throw new AppError("Order not found", 404);
    if (order.status !== OrderStatus.AWAITING_APPROVAL) {
        throw new AppError("Order is not awaiting approval", 400);
    }

    order.status = OrderStatus.CANCELLED;
    await order.save();

    await appendCareRecordEvent({
        familyId,
        subjectUserId: order.subjectUserId,
        actorUserId,
        type: CareRecordEventType.SYSTEM,
        source: CareRecordSource.DASHBOARD,
        channel: ChannelType.DASHBOARD,
        title: "Grocery order declined",
        detail: `Zepto basket ₹${(order.totalPaise / 100).toFixed(0)} declined`,
        payload: { orderId: order.orderId, cancelled: true },
        status: "cancelled",
    });

    return order;
}

export async function listOrderHistory(familyId: string, actorUserId: string, limit = 20) {
    const family = await getFamilyForActor(familyId, actorUserId);
    requirePermission(family, actorUserId, "read");

    return Order.find({ familyId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
}
