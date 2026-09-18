import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import type { McpPartnerKey } from "../partners/mcp/types";

export type OrderPreviewLineItem = {
    name: string;
    quantity: number;
    unitPricePaise: number;
    itemId?: string;
    spinId?: string;
    restaurantId?: string;
    restaurantName?: string;
};

export interface IOrderPreview {
    previewId: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    partner: McpPartnerKey;
    partnerAddressId: string;
    addressLabel?: string;
    deliveryAddress: string;
    items: OrderPreviewLineItem[];
    totalPaise: number;
    placed: boolean;
    orderId?: string;
    expiresAt: Date;
}

export interface IOrderPreviewDocument extends IOrderPreview, Document {}

const lineSchema = new Schema<OrderPreviewLineItem>(
    {
        name: { type: String, required: true, maxlength: 120 },
        quantity: { type: Number, required: true, min: 1 },
        unitPricePaise: { type: Number, required: true, min: 1 },
        itemId: { type: String },
        spinId: { type: String },
        restaurantId: { type: String },
        restaurantName: { type: String },
    },
    { _id: false },
);

const orderPreviewSchema = new Schema<IOrderPreviewDocument>(
    {
        previewId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true },
        actorUserId: { type: String, required: true },
        partner: { type: String, required: true, enum: ["swiggy", "instamart", "zepto"] },
        partnerAddressId: { type: String, required: true },
        addressLabel: { type: String },
        deliveryAddress: { type: String, required: true, maxlength: 300 },
        items: { type: [lineSchema], default: [] },
        totalPaise: { type: Number, required: true, min: 1 },
        placed: { type: Boolean, default: false },
        orderId: { type: String },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
);

orderPreviewSchema.pre("save", function (next) {
    if (!this.previewId) this.previewId = randomUUID();
    next();
});

const OrderPreview: Model<IOrderPreviewDocument> =
    (mongoose.models.OrderPreview as Model<IOrderPreviewDocument>) ||
    mongoose.model<IOrderPreviewDocument>("OrderPreview", orderPreviewSchema);

export default OrderPreview;
