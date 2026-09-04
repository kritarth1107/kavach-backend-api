/**
 * Zepto adapter — backward-compatible exports for commerce MCP.
 */
import { OrderPartner } from "../types/careRecord.types";
import { createCommerceOrder, payCommerceOrder } from "./commerce.adapter";

export type ZeptoLineItem = {
    name: string;
    quantity: number;
    unitPricePaise: number;
};

export type ZeptoOrderContext = {
    familyId?: string;
    actorUserId?: string;
    items: ZeptoLineItem[];
    deliveryAddress?: string;
};

export async function createZeptoOrder(input: ZeptoOrderContext) {
    return createCommerceOrder({
        partner: OrderPartner.ZEPTO,
        ...input,
    });
}

export async function payZeptoOrder(input: {
    orderId: string;
    amountPaise: number;
    payerUserId: string;
    familyId?: string;
    items?: Array<{ name: string; quantity: number }>;
    paymentMethod?: string;
}) {
    return payCommerceOrder({
        partner: OrderPartner.ZEPTO,
        ...input,
    });
}

export { createCommerceOrder, payCommerceOrder };
