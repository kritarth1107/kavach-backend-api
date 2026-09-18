import Order from "../models/order.model";
import LabDocument from "../models/labDocument.model";
import SaheliMessage from "../models/saheliMessage.model";
import OrderSession from "../models/orderSession.model";
import { OrderStatus } from "../types/careRecord.types";
import { getFamilyForActor } from "./careRecordAuth.service";
import { getFamilyMembersList } from "./familyMember.service";
import { getMcpConnectionStatus } from "../partners/mcp/mcpClient.service";
import { listPartnerAddresses } from "./partnerAddress.service";
import { resolveFamilyMcpUserId } from "./commerceConnection.service";
import CareSchedule from "../models/careSchedule.model";
import { scheduleAppliesToday } from "./saheli.service";

export type SaheliInsightItem = {
    kind: string;
    title: string;
    detail: string;
    actionUrl?: string;
    recipientUserId?: string;
};

function parseTimeToMinutes(time: string): number | null {
    const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hours += 12;
    return hours * 60 + Number(match[2]);
}

export async function getSaheliInsights(
    familyId: string,
    recipientUserId: string,
    actorUserId: string,
): Promise<SaheliInsightItem[]> {
    await getFamilyForActor(familyId, actorUserId);
    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const displayName =
        membersPayload.members.find((m) => m.userId === recipientUserId)?.fullName?.trim() ||
        membersPayload.members.find((m) => m.userId === recipientUserId)?.name?.trim() ||
        "Care recipient";

    const insights: SaheliInsightItem[] = [];
    const chatUrl = `/dashboard/chat?recipient=${encodeURIComponent(recipientUserId)}`;

    const pendingOrders = await Order.find({
        familyId,
        subjectUserId: recipientUserId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    })
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();
    for (const order of pendingOrders) {
        insights.push({
            kind: "order_pending",
            title: "Order awaiting approval",
            detail: `${order.partner} basket ₹${(order.totalPaise / 100).toFixed(0)} needs family approval.`,
            actionUrl: "/dashboard/approvals",
            recipientUserId,
        });
    }

    const activeFlow = await OrderSession.findOne({
        familyId,
        recipientUserId,
        phase: { $nin: ["submitted", "expired"] },
        expiresAt: { $gt: new Date() },
    })
        .sort({ updatedAt: -1 })
        .lean();
    if (activeFlow) {
        insights.push({
            kind: "order_flow_active",
            title: "Order in progress",
            detail: `Continue ${activeFlow.partner} order (${activeFlow.phase.replace(/_/g, " ")}).`,
            actionUrl: chatUrl,
            recipientUserId,
        });
    }

    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const recentLabs = await LabDocument.find({
        familyId,
        recipientUserId,
        createdAt: { $gte: cutoff },
    })
        .sort({ createdAt: -1 })
        .limit(3)
        .lean();
    for (const lab of recentLabs) {
        insights.push({
            kind: "lab_new",
            title: "New report uploaded",
            detail: `${lab.title}${lab.recordDate ? ` (${lab.recordDate})` : ""} — review in Saheli or Reports.`,
            actionUrl: "/dashboard/reports",
            recipientUserId,
        });
    }

    const lastElder = await SaheliMessage.findOne({
        familyId,
        recipientUserId,
        thread: "elder",
        role: "elder",
    })
        .sort({ createdAt: -1 })
        .lean();
    if (lastElder?.createdAt && lastElder.createdAt < new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)) {
        insights.push({
            kind: "checkin_stale",
            title: "No recent check-in",
            detail: `${displayName} has not messaged Saheli in a few days.`,
            actionUrl: `${chatUrl}&q=${encodeURIComponent(`Check in on ${displayName}`)}`,
            recipientUserId,
        });
    }

    const today = new Date().getDay();
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const schedules = await CareSchedule.find({ familyId, recipientUserId, active: true }).lean();
    for (const schedule of schedules) {
        if (!scheduleAppliesToday(schedule.daysOfWeek ?? [], today)) continue;
        const mins = parseTimeToMinutes(schedule.time);
        if (mins === null) continue;
        const diff = mins - nowMinutes;
        if (diff >= 0 && diff <= 120) {
            insights.push({
                kind: "schedule_due",
                title: "Schedule due soon",
                detail: `${schedule.title} at ${schedule.time}.`,
                actionUrl: `/dashboard/family/${recipientUserId}`,
                recipientUserId,
            });
            break;
        }
    }

    const swiggyStatus = await getMcpConnectionStatus("swiggy", familyId, actorUserId);
    if (swiggyStatus.connected) {
        try {
            const commerceUserId = await resolveFamilyMcpUserId(familyId, "swiggy", actorUserId);
            const addresses = commerceUserId
                ? await listPartnerAddresses(familyId, "swiggy", commerceUserId)
                : [];
            if (addresses.length === 0) {
                insights.push({
                    kind: "swiggy_no_address",
                    title: "Sync Swiggy addresses",
                    detail: "Swiggy is connected but no delivery addresses found.",
                    actionUrl: "/dashboard/integrations",
                    recipientUserId,
                });
            }
        } catch {
            // ignore address sync errors in insights
        }
    }

    return insights.slice(0, 8);
}
