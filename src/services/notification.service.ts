import Notification, { newNotificationId } from "../models/notification.model";
import Family from "../models/family.model";
import { AppError } from "../middleware/error.middleware";

export type NotificationPayload = {
    kind: string;
    title: string;
    body: string;
    actionUrl?: string;
    recipientUserId?: string;
    dedupeKey?: string;
};

export async function createFamilyNotification(
    familyId: string,
    payload: NotificationPayload,
    targetUserIds?: string[],
): Promise<void> {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family) return;

    const userIds =
        targetUserIds ??
        family.members.filter((m) => m.status === "JOINED" && m.userId).map((m) => m.userId!);

    for (const userId of userIds) {
        const dedupeKey = payload.dedupeKey ? `${userId}:${payload.dedupeKey}` : undefined;
        if (dedupeKey) {
            const existing = await Notification.findOne({ familyId, userId, dedupeKey }).lean();
            if (existing) continue;
        }
        await Notification.create({
            notificationId: newNotificationId(),
            familyId,
            userId,
            kind: payload.kind,
            title: payload.title,
            body: payload.body,
            actionUrl: payload.actionUrl,
            recipientUserId: payload.recipientUserId,
            dedupeKey,
        });
    }
}

export async function listNotifications(
    familyId: string,
    actorUserId: string,
    limit = 40,
) {
    const family = await Family.findOne({ familyId, status: "ACTIVE" });
    if (!family || !family.hasJoinedMember(actorUserId)) {
        throw new AppError("Family not found or access denied", 403);
    }

    const rows = await Notification.find({ familyId, userId: actorUserId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    const unreadCount = await Notification.countDocuments({
        familyId,
        userId: actorUserId,
        readAt: null,
    });

    return {
        notifications: rows.map((row) => ({
            notificationId: row.notificationId,
            kind: row.kind,
            title: row.title,
            body: row.body,
            actionUrl: row.actionUrl,
            recipientUserId: row.recipientUserId,
            readAt: row.readAt?.toISOString?.() ?? null,
            createdAt: row.createdAt?.toISOString?.() ?? null,
        })),
        unreadCount,
    };
}

export async function markNotificationRead(
    familyId: string,
    actorUserId: string,
    notificationId: string,
) {
    await Notification.updateOne(
        { familyId, userId: actorUserId, notificationId },
        { $set: { readAt: new Date() } },
    );
}

export async function markAllNotificationsRead(familyId: string, actorUserId: string) {
    await Notification.updateMany(
        { familyId, userId: actorUserId, readAt: null },
        { $set: { readAt: new Date() } },
    );
}
