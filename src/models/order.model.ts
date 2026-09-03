import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import { OrderPartner, OrderStatus } from "../types/careRecord.types";

export interface IOrderLineItem {
    name: string;
    quantity: number;
    unitPricePaise: number;
}

export interface IOrder {
    orderId: string;
    familyId: string;
    subjectUserId: string;
    suggestedBy: string;
    approvedBy?: string;
    partner: OrderPartner;
    status: OrderStatus;
    items: IOrderLineItem[];
    totalPaise: number;
    currency: string;
    deliveryAddress?: string;
    partnerRef?: string;
    deepLink?: string;
    notes?: string;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IOrderDocument extends IOrder, Document {}

const lineItemSchema = new Schema<IOrderLineItem>(
    {
        name: { type: String, required: true, trim: true, maxlength: 120 },
        quantity: { type: Number, required: true, min: 1 },
        unitPricePaise: { type: Number, required: true, min: 0 },
    },
    { _id: false },
);

const orderSchema = new Schema<IOrderDocument>(
    {
        orderId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        subjectUserId: { type: String, required: true, index: true },
        suggestedBy: { type: String, required: true },
        approvedBy: { type: String },
        partner: { type: String, enum: Object.values(OrderPartner), required: true },
        status: { type: String, enum: Object.values(OrderStatus), required: true },
        items: { type: [lineItemSchema], default: [] },
        totalPaise: { type: Number, required: true, min: 0 },
        currency: { type: String, default: "INR" },
        deliveryAddress: { type: String, trim: true, maxlength: 300 },
        partnerRef: { type: String, trim: true },
        deepLink: { type: String, trim: true },
        notes: { type: String, trim: true, maxlength: 500 },
    },
    { timestamps: true },
);

orderSchema.pre("save", function (next) {
    if (!this.orderId) {
        this.orderId = randomUUID();
    }
    next();
});

orderSchema.index({ familyId: 1, status: 1, createdAt: -1 });

const Order: Model<IOrderDocument> =
    (mongoose.models.Order as Model<IOrderDocument>) ||
    mongoose.model<IOrderDocument>("Order", orderSchema);

export default Order;
