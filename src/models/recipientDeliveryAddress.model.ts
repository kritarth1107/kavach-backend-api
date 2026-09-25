import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * The delivery address of ONE care recipient in ONE family. Saheli orders go only here.
 * There is no global / env / code default — if a recipient has no row, Saheli asks them.
 */
export interface IRecipientDeliveryAddress {
    familyId: string;
    recipientUserId: string;
    address: string;
    pincode: string;
    /** Who set it: the elder on WhatsApp, or a caregiver. */
    source: "elder_whatsapp" | "caregiver";
    setByUserId?: string;
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
    },
    { timestamps: true, collection: "recipient_delivery_addresses" },
);
schema.index({ familyId: 1, recipientUserId: 1 }, { unique: true });

const RecipientDeliveryAddress: Model<IRecipientDeliveryAddressDocument> =
    (mongoose.models.RecipientDeliveryAddress as Model<IRecipientDeliveryAddressDocument>) ||
    mongoose.model<IRecipientDeliveryAddressDocument>("RecipientDeliveryAddress", schema);

export default RecipientDeliveryAddress;
