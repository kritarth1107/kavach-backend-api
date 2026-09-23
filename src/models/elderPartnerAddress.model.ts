import mongoose, { Document, Schema, Model } from "mongoose";
import type { McpPartnerKey } from "../partners/mcp/types";

export interface IElderPartnerAddress {
    familyId: string;
    recipientUserId: string;
    partner: McpPartnerKey;
    lastSuccessfulAddressId: string;
    addressLabel?: string;
    addressLine1?: string;
    successCount: number;
    lastUsedAt: Date;
}

export interface IElderPartnerAddressDocument extends IElderPartnerAddress, Document {}

const elderPartnerAddressSchema = new Schema<IElderPartnerAddressDocument>(
    {
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        partner: { type: String, required: true, enum: ["swiggy", "instamart", "zepto"] },
        lastSuccessfulAddressId: { type: String, required: true },
        addressLabel: { type: String },
        addressLine1: { type: String },
        successCount: { type: Number, default: 1 },
        lastUsedAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

elderPartnerAddressSchema.index(
    { familyId: 1, recipientUserId: 1, partner: 1 },
    { unique: true },
);

const ElderPartnerAddress: Model<IElderPartnerAddressDocument> =
    (mongoose.models.ElderPartnerAddress as Model<IElderPartnerAddressDocument>) ||
    mongoose.model<IElderPartnerAddressDocument>("ElderPartnerAddress", elderPartnerAddressSchema);

export default ElderPartnerAddress;
