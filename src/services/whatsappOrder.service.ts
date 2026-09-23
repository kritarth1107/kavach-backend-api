import Order from "../models/order.model";
import { OrderStatus } from "../types/careRecord.types";
import { FamilyRole } from "../types/family.types";
import { approveOrder, payOrder, rejectOrder } from "./order.service";

const APPROVE_RE =
    /\b(approve|yes|ok|okay|confirm|theek|thik|haan|han|ji|go ahead|place it|pay)\b/i;
const REJECT_RE = /\b(reject|no|cancel|decline|mat|nahi|nah|stop)\b/i;
const ORDER_CONTEXT_RE = /\b(order|basket|swiggy|zepto|instamart|grocery|delivery)\b/i;

function isCaregiver(role: FamilyRole): boolean {
    return role === FamilyRole.PRIMARY_CAREGIVER || role === FamilyRole.CO_CAREGIVER;
}

export async function tryHandleCaregiverWhatsAppOrderCommand(input: {
    familyId: string;
    actorUserId: string;
    role: FamilyRole;
    text: string;
}): Promise<string | null> {
    if (!isCaregiver(input.role)) return null;

    const pending = await Order.find({
        familyId: input.familyId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    })
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();

    if (!pending.length) return null;

    const isApprovalStatusQuestion =
        /\b(approved\?|is\s+it\s+approved|was\s+it\s+approved|approval\s+status)\b/i.test(
            input.text,
        ) ||
        (/\bapproved\b/i.test(input.text) && /\?/.test(input.text)) ||
        (/^(approved|approval)\??$/i.test(input.text.trim()));

    const wantsApproveReject =
        !isApprovalStatusQuestion &&
        (APPROVE_RE.test(input.text) || REJECT_RE.test(input.text));
    const wantsPendingStatus =
        isApprovalStatusQuestion ||
        (/\b(pending|status|basket|approve|reject|approved)\b/i.test(input.text) &&
            (ORDER_CONTEXT_RE.test(input.text) || isApprovalStatusQuestion));

    if (!wantsApproveReject && !wantsPendingStatus) {
        return null;
    }

    const order = pending[0];
    const itemList = order.items.map((i) => `${i.name} ×${i.quantity}`).join(", ");
    const amount = `₹${(order.totalPaise / 100).toFixed(0)}`;

    if (REJECT_RE.test(input.text) && !APPROVE_RE.test(input.text)) {
        await rejectOrder(input.familyId, order.orderId, input.actorUserId);
        return `Done — I cancelled the ${order.partner} basket (${itemList}, ${amount}).`;
    }

    if (APPROVE_RE.test(input.text)) {
        if (order.status === OrderStatus.AWAITING_APPROVAL) {
            await approveOrder(input.familyId, order.orderId, input.actorUserId);
        }
        const paid = await payOrder(input.familyId, order.orderId, input.actorUserId, {
            partnerAddressId: order.partnerAddressId,
        });
        if (paid.payment.paymentLink) {
            return `Approved ${amount} ${order.partner} order (${itemList}). Complete payment here: ${paid.payment.paymentLink}`;
        }
        return `Approved and placed the ${order.partner} order (${itemList}, ${amount}). I'll let the family know when it's on the way.`;
    }

    return `There is a pending ${order.partner} basket (${itemList}, ${amount}). Reply *approve* to place it or *reject* to cancel.`;
}
