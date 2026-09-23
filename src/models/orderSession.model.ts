import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import type { McpPartnerKey } from "../partners/mcp/types";

export type OrderSessionPhase =
    | "select_address"
    | "browse"
    | "review_cart"
    | "submitted"
    | "expired";

export type OrderSessionAddress = {
    id: string;
    label: string;
    line1: string;
    city?: string;
    pincode?: string;
    isDefault?: boolean;
};

export type OrderSessionCatalogItem = {
    id?: string;
    itemId?: string;
    name: string;
    pricePaise?: number;
    kind?: "restaurant" | "dish" | "product";
    restaurantId?: string;
    restaurantName?: string;
};

export type OrderSessionCartItem = {
    itemId?: string;
    name: string;
    quantity: number;
    pricePaise: number;
    restaurantId?: string;
    restaurantName?: string;
};

export interface IOrderSession {
    sessionId: string;
    familyId: string;
    recipientUserId: string;
    actorUserId: string;
    partner: McpPartnerKey;
    phase: OrderSessionPhase;
    query: string;
    selectedAddressId?: string;
    addresses: OrderSessionAddress[];
    catalog: {
        restaurants: OrderSessionCatalogItem[];
        dishes: OrderSessionCatalogItem[];
        products: OrderSessionCatalogItem[];
    };
    cartItems: OrderSessionCartItem[];
    /** Partner cart fee lines (Instamart get_cart etc.) — present keys only. */
    billBreakdown?: {
        itemSubtotalPaise?: number;
        deliveryFeePaise?: number;
        platformFeePaise?: number;
        packingFeePaise?: number;
        taxPaise?: number;
        discountPaise?: number;
        tipPaise?: number;
        otherFeesPaise?: number;
        grandTotalPaise?: number;
    };
    orderId?: string;
    /** Last known order status after submit (awaiting_approval / approved / paid…). */
    orderStatus?: string;
    saheliSessionId?: string;
    lastCatalogQuery?: string;
    lastCatalogHits?: unknown[];
    pendingDisambiguation?: {
        query: string;
        candidates: Array<{
            candidateId?: string;
            name: string;
            pricePaise?: number;
            kind?: "restaurant" | "dish" | "product";
            restaurantId?: string;
            restaurantName?: string;
            itemId?: string;
            confidence?: number;
        }>;
    };
    expiresAt: Date;
}

export interface IOrderSessionDocument extends IOrderSession, Document {}

const addressSchema = new Schema(
    {
        id: { type: String, required: true },
        label: { type: String, required: true },
        line1: { type: String, required: true },
        city: { type: String },
        pincode: { type: String },
        isDefault: { type: Boolean, default: false },
    },
    { _id: false },
);

const catalogItemSchema = new Schema(
    {
        id: { type: String },
        itemId: { type: String },
        name: { type: String, required: true },
        pricePaise: { type: Number },
        kind: { type: String, enum: ["restaurant", "dish", "product"] },
        restaurantId: { type: String },
        restaurantName: { type: String },
    },
    { _id: false },
);

const cartItemSchema = new Schema(
    {
        itemId: { type: String },
        name: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        pricePaise: { type: Number, required: true, min: 0 },
        restaurantId: { type: String },
        restaurantName: { type: String },
    },
    { _id: false },
);

const orderSessionSchema = new Schema<IOrderSessionDocument>(
    {
        sessionId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        actorUserId: { type: String, required: true },
        partner: { type: String, required: true, enum: ["swiggy", "instamart", "zepto"] },
        phase: {
            type: String,
            required: true,
            enum: ["select_address", "browse", "review_cart", "submitted", "expired"],
        },
        query: { type: String, required: true, maxlength: 200 },
        selectedAddressId: { type: String },
        addresses: { type: [addressSchema], default: [] },
        catalog: {
            restaurants: { type: [catalogItemSchema], default: [] },
            dishes: { type: [catalogItemSchema], default: [] },
            products: { type: [catalogItemSchema], default: [] },
        },
        cartItems: { type: [cartItemSchema], default: [] },
        billBreakdown: {
            type: new Schema(
                {
                    itemSubtotalPaise: { type: Number },
                    deliveryFeePaise: { type: Number },
                    platformFeePaise: { type: Number },
                    packingFeePaise: { type: Number },
                    taxPaise: { type: Number },
                    discountPaise: { type: Number },
                    tipPaise: { type: Number },
                    otherFeesPaise: { type: Number },
                    grandTotalPaise: { type: Number },
                },
                { _id: false },
            ),
        },
        orderId: { type: String },
        orderStatus: { type: String },
        saheliSessionId: { type: String, index: true },
        lastCatalogQuery: { type: String },
        lastCatalogHits: { type: [Schema.Types.Mixed], default: undefined },
        pendingDisambiguation: {
            type: {
                query: { type: String, required: true },
                candidates: { type: [catalogItemSchema], default: [] },
            },
            default: undefined,
        },
        expiresAt: { type: Date, required: true, index: true },
    },
    { timestamps: true },
);

orderSessionSchema.pre("save", function (next) {
    if (!this.sessionId) this.sessionId = randomUUID();
    next();
});

orderSessionSchema.index({ familyId: 1, recipientUserId: 1, phase: 1, expiresAt: -1 });

const OrderSession: Model<IOrderSessionDocument> =
    (mongoose.models.OrderSession as Model<IOrderSessionDocument>) ||
    mongoose.model<IOrderSessionDocument>("OrderSession", orderSessionSchema);

export default OrderSession;
