import Family from "../models/family.model";
import OrderSession from "../models/orderSession.model";
import Order from "../models/order.model";
import SaheliMessage from "../models/saheliMessage.model";
import CareSchedule from "../models/careSchedule.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { OrderStatus } from "../types/careRecord.types";
import { getFamilyMembersList } from "./familyMember.service";
import { getSaheliInsights } from "./saheliInsights.service";
import { getMcpConnectionStatus } from "../partners/mcp/mcpClient.service";
import { listPartnerAddresses } from "./partnerAddress.service";
import { scheduleAppliesToday } from "./saheli.service";
import { resolveFamilyMcpUserId } from "./commerceConnection.service";

export type CommandCenterRecipient = {
    userId: string;
    name: string;
    insightCount: number;
    activeOrderPhase: string | null;
    lastElderSnippet: string | null;
    lastElderAt: string | null;
    nextScheduleTitle: string | null;
    nextScheduleTime: string | null;
    pendingApprovals: number;
    swiggyConnected: boolean;
    swiggyAddressCount: number;
};

export type CommandCenterPayload = {
    pendingApprovalsTotal: number;
    recipients: CommandCenterRecipient[];
    quickPrompts: string[];
};

function parseTimeToMinutes(time: string): number | null {
    const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return null;
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === "PM") hours += 12;
    return hours * 60 + Number(match[2]);
}

export async function getCommandCenter(
    familyId: string,
    actorUserId: string,
): Promise<CommandCenterPayload> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const membersPayload = await getFamilyMembersList(familyId, actorUserId);
    const recipients = membersPayload.members.filter(
        (m) => m.role === FamilyRole.CARE_RECIPIENT && m.status === FamilyMemberStatus.JOINED,
    );

    const pendingApprovalsTotal = await Order.countDocuments({
        familyId,
        status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
    });

    const today = new Date().getDay();
    const nowMinutes = new Date().getHours() * 60 + new Date().getMinutes();
    const rows: CommandCenterRecipient[] = [];

    for (const recipient of recipients) {
        const recipientUserId = recipient.userId;
        if (!recipientUserId) continue;
        const name = recipient.fullName?.trim() || recipient.name?.trim() || "Care recipient";

        const [
            insights,
            activeOrder,
            lastElder,
            schedules,
            pendingForRecipient,
            swiggyStatus,
        ] = await Promise.all([
            getSaheliInsights(familyId, recipientUserId, actorUserId),
            OrderSession.findOne({
                familyId,
                recipientUserId,
                phase: { $nin: ["submitted", "expired"] },
                expiresAt: { $gt: new Date() },
            })
                .sort({ updatedAt: -1 })
                .lean(),
            SaheliMessage.findOne({
                familyId,
                recipientUserId,
                thread: "elder",
                role: "elder",
            })
                .sort({ createdAt: -1 })
                .lean(),
            CareSchedule.find({ familyId, recipientUserId, active: true }).lean(),
            Order.countDocuments({
                familyId,
                subjectUserId: recipientUserId,
                status: { $in: [OrderStatus.AWAITING_APPROVAL, OrderStatus.APPROVED] },
            }),
            getMcpConnectionStatus("swiggy", familyId, actorUserId),
        ]);

        let swiggyAddressCount = 0;
        if (swiggyStatus.connected) {
            try {
                const commerceUserId = await resolveFamilyMcpUserId(familyId, "swiggy", actorUserId);
                if (commerceUserId) {
                    const addresses = await listPartnerAddresses(familyId, "swiggy", commerceUserId);
                    swiggyAddressCount = addresses.length;
                }
            } catch {
                swiggyAddressCount = 0;
            }
        }

        let nextScheduleTitle: string | null = null;
        let nextScheduleTime: string | null = null;
        let bestMinutes: number | null = null;
        for (const schedule of schedules) {
            if (!scheduleAppliesToday(schedule.daysOfWeek ?? [], today)) continue;
            const mins = parseTimeToMinutes(schedule.time);
            if (mins === null) continue;
            if (mins >= nowMinutes && (bestMinutes === null || mins < bestMinutes)) {
                bestMinutes = mins;
                nextScheduleTitle = schedule.title;
                nextScheduleTime = schedule.time;
            }
        }

        rows.push({
            userId: recipientUserId,
            name,
            insightCount: insights.length,
            activeOrderPhase: activeOrder?.phase ?? null,
            lastElderSnippet: lastElder?.content?.slice(0, 120) ?? null,
            lastElderAt: lastElder?.createdAt?.toISOString?.() ?? null,
            nextScheduleTitle,
            nextScheduleTime,
            pendingApprovals: pendingForRecipient,
            swiggyConnected: swiggyStatus.connected,
            swiggyAddressCount,
        });
    }

    const firstName = rows[0]?.name.split(/\s+/)[0] ?? "them";
    const quickPrompts = [
        `How is ${firstName} today?`,
        "Order dal rice from Swiggy",
        "Latest labs on file",
        "What's due today?",
    ];

    return {
        pendingApprovalsTotal,
        recipients: rows,
        quickPrompts,
    };
}
