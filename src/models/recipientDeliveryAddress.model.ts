import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * LEGACY (read-only): per-recipient delivery address. Superseded by the family address book
 * (familyAddress.model) — rows are migrated once (migratedAt) and never read for orders.
 */
export interface IRecipientDeliveryAddress {
    familyId: string;
    recipientUserId: string;
    address: string;
    pincode: string;
    /** Who set it: the elder on WhatsApp, or a caregiver. */
    source: "elder_whatsapp" | "caregiver";
    setByUserId?: string;
    /** Copied into the family address book (family_addresses) — legacy row is no longer read. */
    migratedAt?: Date;
}

export interface IRecipientDeliveryAddressDocument extends IRecipientDeliveryAddress, Document {}

const schema = new Schema<IRecipientDeliveryAddressDocument>(
    {
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true, index: true },
        address: { type: String, required: true, trim: true, maxlength: 300 },
        pincode: { type: String, required: true, match: /^[1-9]\d{5}$/ },
        source: { type: String, required: true, enum: ["elder_whatsapp", "caregiver"] },
        setByUserId: { type: String },
        migratedAt: { type: Date },
    },
    { timestamps: true, collection: "recipient_delivery_addresses" },
);
schema.index({ familyId: 1, recipientUserId: 1 }, { unique: true });

const RecipientDeliveryAddress: Model<IRecipientDeliveryAddressDocument> =
    (mongoose.models.RecipientDeliveryAddress as Model<IRecipientDeliveryAddressDocument>) ||
    mongoose.model<IRecipientDeliveryAddressDocument>("RecipientDeliveryAddress", schema);

export default RecipientDeliveryAddress;
