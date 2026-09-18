import Family from "../models/family.model";
import LabDocument from "../models/labDocument.model";
import Order from "../models/order.model";
import SaheliChatSession from "../models/saheliChatSession.model";
import { AppError } from "../middleware/error.middleware";
import { FamilyMemberStatus, FamilyRole } from "../types/family.types";
import { getFamilyMembersList } from "./familyMember.service";

export type SearchResult = {
    type: "recipient" | "lab" | "chat" | "order" | "member" | "page";
    id: string;
    title: string;
    subtitle: string;
    url: string;
};

const STATIC_PAGES: SearchResult[] = [
    { type: "page", id: "home", title: "Home", subtitle: "Dashboard overview", url: "/dashboard" },
    { type: "page", id: "chat", title: "Ask Saheli", subtitle: "Chat with Saheli", url: "/dashboard/chat" },
    { type: "page", id: "approvals", title: "Approvals", subtitle: "Pending orders", url: "/dashboard/approvals" },
    { type: "page", id: "reports", title: "Reports", subtitle: "Care brief & timeline", url: "/dashboard/reports" },
    { type: "page", id: "integrations", title: "Integrations", subtitle: "Swiggy, Instamart, WhatsApp", url: "/dashboard/integrations" },
    { type: "page", id: "help", title: "Help", subtitle: "How to use Kavach", url: "/dashboard/help" },
    { type: "page", id: "notifications", title: "Notifications", subtitle: "Alerts & updates", url: "/dashboard/notifications" },
];

export async function searchFamily(
    familyId: string,
    actorUserId: string,
    query: string,
    limit = 20,
): Promise<SearchResult[]> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const q = query.trim().toLowerCase();
    if (!q) return STATIC_PAGES.slice(0, limit);

    const results: SearchResult[] = [];
    const membersPayload = await getFamilyMembersList(familyId, actorUserId);

    for (const page of STATIC_PAGES) {
        if (page.title.toLowerCase().includes(q) || page.subtitle.toLowerCase().includes(q)) {
            results.push(page);
        }
    }

    for (const member of membersPayload.members) {
        if (member.status !== FamilyMemberStatus.JOINED) continue;
        const name = member.fullName?.trim() || member.name?.trim() || "";
        if (!name.toLowerCase().includes(q)) continue;
        const isRecipient = member.role === FamilyRole.CARE_RECIPIENT;
        results.push({
            type: isRecipient ? "recipient" : "member",
            id: member.userId ?? member.inviteId,
            title: name,
            subtitle: isRecipient ? "Care recipient" : member.role,
            url: isRecipient && member.userId
                ? `/dashboard/family/${member.userId}`
                : "/dashboard/family",
        });
    }

    const labs = await LabDocument.find({ familyId }).sort({ createdAt: -1 }).limit(30).lean();
    for (const lab of labs) {
        if (!lab.title.toLowerCase().includes(q) && !lab.rawText.toLowerCase().includes(q)) continue;
        results.push({
            type: "lab",
            id: lab.documentId,
            title: lab.title,
            subtitle: lab.recordDate ?? "Lab report",
            url: `/dashboard/reports?lab=${encodeURIComponent(lab.documentId)}`,
        });
    }

    const sessions = await SaheliChatSession.find({ familyId }).sort({ updatedAt: -1 }).limit(30).lean();
    for (const session of sessions) {
        const hay = `${session.title} ${session.thread}`.toLowerCase();
        if (!hay.includes(q)) continue;
        results.push({
            type: "chat",
            id: session.sessionId,
            title: session.title || "Saheli chat",
            subtitle: session.thread === "caregiver" ? "Caregiver chat" : "Elder chat",
            url: `/dashboard/chat?recipient=${encodeURIComponent(session.recipientUserId)}&session=${encodeURIComponent(session.sessionId)}`,
        });
    }

    const orders = await Order.find({ familyId }).sort({ createdAt: -1 }).limit(20).lean();
    for (const order of orders) {
        const hay = `${order.partner} ${order.status}`.toLowerCase();
        if (!hay.includes(q)) continue;
        results.push({
            type: "order",
            id: order.orderId,
            title: `${order.partner} order`,
            subtitle: `${order.status} · ₹${(order.totalPaise / 100).toFixed(0)}`,
            url: "/dashboard/approvals",
        });
    }

    return results.slice(0, limit);
}
