import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";

export type SaheliThreadKind = "elder" | "caregiver";
export type SaheliMessageRole = "elder" | "saheli" | "family" | "system";

export type SaheliOrderFlowPayload = {
    sessionId: string;
    phase: "select_address" | "browse" | "review_cart" | "submitted" | "expired";
    partner: string;
    partnerLabel: string;
    query: string;
    selectedAddressId?: string;
    addresses?: Array<{ id: string; label: string; line1: string; city?: string; pincode?: string; isDefault?: boolean }>;
    catalog?: {
        restaurants: Array<{
            id?: string;
            itemId?: string;
            name: string;
            pricePaise?: number;
            kind?: "restaurant" | "dish" | "product";
            restaurantId?: string;
            restaurantName?: string;
        }>;
        dishes: Array<{
            id?: string;
            itemId?: string;
            name: string;
            pricePaise?: number;
            kind?: "restaurant" | "dish" | "product";
            restaurantId?: string;
            restaurantName?: string;
        }>;
    };
    cartItems?: Array<{
        itemId?: string;
        name: string;
        quantity: number;
        pricePaise: number;
        restaurantId?: string;
        restaurantName?: string;
    }>;
    orderId?: string;
    message?: string;
    disambiguation?: {
        query: string;
        candidates: Array<{
            candidateId?: string;
            name: string;
            pricePaise?: number;
            kind?: string;
            confidence?: number;
        }>;
    };
};

export type SaheliMessageOrderPayload = {
    orderId: string;
    partner: string;
    partnerLabel: string;
    totalPaise: number;
    items: Array<{ name: string; quantity: number; unitPricePaise?: number; matchedName?: string }>;
    status: string;
    source?: "mock" | "zepto_mcp" | "swiggy_mcp" | "instamart_mcp";
    searchResults?: Array<{
        query: string;
        name: string;
        pricePaise?: number;
        kind?: "restaurant" | "dish" | "product";
        restaurantName?: string;
        restaurantId?: string;
    }>;
    addresses?: Array<{ id: string; label: string; line1: string; city?: string; pincode?: string; isDefault?: boolean }>;
    addressNote?: string;
};

export type SaheliMessageConnectPayload = {
    partner: string;
    partnerLabel: string;
    connectPartner: string;
    connectUrl?: string | null;
    note?: string;
};

export interface ISaheliMessage {
    messageId: string;
    familyId: string;
    recipientUserId: string;
    thread: SaheliThreadKind;
    sessionId?: string;
    role: SaheliMessageRole;
    content: string;
    orderPayload?: SaheliMessageOrderPayload;
    orderFlowPayload?: SaheliOrderFlowPayload;
    orderPreviewPayload?: Record<string, unknown>;
    connectPayload?: SaheliMessageConnectPayload;
    createdAt?: Date;
}

export interface ISaheliMessageDocument extends ISaheliMessage, Document {}

const saheliMessageSchema = new Schema<ISaheliMessageDocument>(
    {
        messageId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        thread: { type: String, enum: ["elder", "caregiver"], required: true },
        sessionId: { type: String, index: true },
        role: { type: String, enum: ["elder", "saheli", "family", "system"], required: true },
        content: { type: String, required: true, maxlength: 8000 },
        orderPayload: { type: Schema.Types.Mixed },
        orderFlowPayload: { type: Schema.Types.Mixed },
        orderPreviewPayload: { type: Schema.Types.Mixed },
        connectPayload: { type: Schema.Types.Mixed },
    },
    {
        timestamps: true,
        toJSON: {
            transform: (_doc, ret: Record<string, unknown>) => {
                delete ret.__v;
                return ret;
            },
        },
    },
);

saheliMessageSchema.pre("save", function (next) {
    if (!this.messageId) this.messageId = randomUUID();
    next();
});

saheliMessageSchema.index({ familyId: 1, recipientUserId: 1, thread: 1, createdAt: 1 });
saheliMessageSchema.index({ sessionId: 1, createdAt: 1 });

const SaheliMessage: Model<ISaheliMessageDocument> =
    (mongoose.models.SaheliMessage as Model<ISaheliMessageDocument>) ||
    mongoose.model<ISaheliMessageDocument>("SaheliMessage", saheliMessageSchema);

export default SaheliMessage;
