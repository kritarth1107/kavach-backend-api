import { randomUUID } from "crypto";
import mongoose, { Document, Model, Schema } from "mongoose";
import type { McpPartnerKey } from "../partners/mcp/types";

export interface IPartnerAddress {
    addressId: string;
    familyId: string;
    userId: string;
    partner: McpPartnerKey;
    partnerAddressId: string;
    label?: string;
    line1: string;
    line2?: string;
    city?: string;
    pincode?: string;
    isDefault: boolean;
    syncedAt: Date;
}

export interface IPartnerAddressDocument extends IPartnerAddress, Document {}

const partnerAddressSchema = new Schema<IPartnerAddressDocument>(
    {
        addressId: { type: String, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        partner: { type: String, required: true, index: true },
        partnerAddressId: { type: String, required: true },
        label: { type: String, trim: true, maxlength: 120 },
        line1: { type: String, required: true, trim: true, maxlength: 300 },
        line2: { type: String, trim: true, maxlength: 300 },
        city: { type: String, trim: true, maxlength: 80 },
        pincode: { type: String, trim: true, maxlength: 12 },
        isDefault: { type: Boolean, default: false },
        syncedAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
);

partnerAddressSchema.pre("save", function (next) {
    if (!this.addressId) this.addressId = randomUUID();
    next();
});

partnerAddressSchema.index(
    { familyId: 1, partner: 1, partnerAddressId: 1 },
    { unique: true },
);

const PartnerAddress: Model<IPartnerAddressDocument> =
    (mongoose.models.PartnerAddress as Model<IPartnerAddressDocument>) ||
    mongoose.model<IPartnerAddressDocument>("PartnerAddress", partnerAddressSchema);

export default PartnerAddress;
