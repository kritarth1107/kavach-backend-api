import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Family address book: nicknamed places ("Home", "Beta's flat", "Clinic") owned by ONE family.
 * Every order / ride / service resolves its address here (familyAddressBook.service). Never
 * shared across families; there is no global / env / code default.
 */
export interface IFamilyAddress {
    addressId: string;
    familyId: string;
    nickname: string;
    /** Lowercase, punctuation-free nickname — unique per family. */
    nicknameKey: string;
    /** Flat / house / building / street / area (everything before city/state/pincode). */
    line1: string;
    line2?: string;
    landmark?: string;
    city?: string;
    state?: string;
    pincode: string;
    lat?: number;
    lng?: number;
    contactName?: string;
    contactPhone?: string;
    /** Members this place applies to. Empty = everyone in the family. */
    memberUserIds: string[];
    /** Members whose default place this is (one default per member). */
    defaultForUserIds: string[];
    createdByUserId?: string;
    source: "whatsapp" | "dashboard" | "migration";
    lastUsedAt?: Date;
}

export interface IFamilyAddressDocument extends IFamilyAddress, Document {}

const schema = new Schema<IFamilyAddressDocument>(
    {
        addressId: { type: String, required: true, unique: true },
        familyId: { type: String, required: true, index: true },
        nickname: { type: String, required: true, trim: true, maxlength: 40 },
        nicknameKey: { type: String, required: true },
        line1: { type: String, required: true, trim: true, maxlength: 240 },
        line2: { type: String, trim: true, maxlength: 160 },
        landmark: { type: String, trim: true, maxlength: 120 },
        city: { type: String, trim: true, maxlength: 60 },
        state: { type: String, trim: true, maxlength: 60 },
        pincode: { type: String, required: true, match: /^[1-9]\d{5}$/ },
        lat: { type: Number, min: -90, max: 90 },
        lng: { type: Number, min: -180, max: 180 },
        contactName: { type: String, trim: true, maxlength: 80 },
        contactPhone: { type: String, trim: true, maxlength: 20 },
        memberUserIds: { type: [String], default: [] },
        defaultForUserIds: { type: [String], default: [] },
        createdByUserId: { type: String },
        source: { type: String, required: true, enum: ["whatsapp", "dashboard", "migration"] },
        lastUsedAt: { type: Date },
    },
    { timestamps: true, collection: "family_addresses" },
);
schema.index({ familyId: 1, nicknameKey: 1 }, { unique: true });

const FamilyAddress: Model<IFamilyAddressDocument> =
    (mongoose.models.FamilyAddress as Model<IFamilyAddressDocument>) ||
    mongoose.model<IFamilyAddressDocument>("FamilyAddress", schema);

export default FamilyAddress;

/** The place chosen for the current order/ride (confirmed on WhatsApp). Short-lived. */
export interface IFamilyAddressChoice {
    familyId: string;
    memberUserId: string;
    addressId: string;
    chosenAt: Date;
}
const choiceSchema = new Schema<IFamilyAddressChoice & Document>(
    {
        familyId: { type: String, required: true, index: true },
        memberUserId: { type: String, required: true },
        addressId: { type: String, required: true },
        chosenAt: { type: Date, required: true },
    },
    { timestamps: false, collection: "family_address_choices" },
);
choiceSchema.index({ familyId: 1, memberUserId: 1 }, { unique: true });

export const FamilyAddressChoice: Model<IFamilyAddressChoice & Document> =
    (mongoose.models.FamilyAddressChoice as Model<IFamilyAddressChoice & Document>) ||
    mongoose.model<IFamilyAddressChoice & Document>("FamilyAddressChoice", choiceSchema);
