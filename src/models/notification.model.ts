import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export interface INotification {
    notificationId: string;
    familyId: string;
    userId: string;
    kind: string;
    title: string;
    body: string;
    actionUrl?: string;
    recipientUserId?: string;
    dedupeKey?: string;
    readAt?: Date | null;
    createdAt?: Date;
}

export interface INotificationDocument extends INotification, Document {}

const notificationSchema = new Schema<INotificationDocument>(
    {
        notificationId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        kind: { type: String, required: true, index: true },
        title: { type: String, required: true, trim: true, maxlength: 200 },
        body: { type: String, default: "", maxlength: 1000 },
        actionUrl: { type: String, trim: true },
        recipientUserId: { type: String, index: true },
        dedupeKey: { type: String, index: true },
        readAt: { type: Date, default: null },
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        toJSON: {
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.__v;
                return ret;
            },
        },
    },
);

notificationSchema.index({ familyId: 1, userId: 1, createdAt: -1 });
notificationSchema.index({ familyId: 1, userId: 1, dedupeKey: 1 }, { unique: true, sparse: true });

const Notification: Model<INotificationDocument> =
    mongoose.models.Notification ??
    mongoose.model<INotificationDocument>("Notification", notificationSchema);

export default Notification;

export function newNotificationId(): string {
    return `ntf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
