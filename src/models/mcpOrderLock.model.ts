import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * One row per confirm card. Unique cardId → the place-order call runs at most once per card,
 * even across duplicate webhooks, retries or instance restarts.
 */
export interface IMcpOrderLock {
    cardId: string;
    familyId: string;
    partner: string;
    status: "placing" | "placed" | "failed" | "refused" | "unknown";
    orderId?: string;
    detail?: string;
    totalPaise?: number;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IMcpOrderLockDocument extends IMcpOrderLock, Document {}

const schema = new Schema<IMcpOrderLockDocument>(
    {
        cardId: { type: String, required: true, unique: true },
        familyId: { type: String, required: true, index: true },
        partner: { type: String, required: true },
        status: { type: String, required: true },
        orderId: { type: String },
        detail: { type: String, maxlength: 600 },
        totalPaise: { type: Number },
    },
    { timestamps: true },
);

const McpOrderLock: Model<IMcpOrderLockDocument> =
    (mongoose.models.McpOrderLock as Model<IMcpOrderLockDocument>) ||
    mongoose.model<IMcpOrderLockDocument>("McpOrderLock", schema);

export default McpOrderLock;
