import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Family address-book place ↔ store-account address id (Swiggy Food / Instamart / Zepto MCP).
 * Family-scoped: a lookup always carries familyId, so one family's mapping is never used for another.
 * `placeFingerprint` changes when the place is edited → a fresh store address is resolved.
 */
export interface IMcpStoreAddress {
    familyId: string;
    partner: "swiggy" | "instamart" | "zepto";
    placeAddressId: string;
    placeFingerprint: string;
    storeAddressId: string;
    /** created = made via create_address / add_saved_address; matched = existing store address with same pincode + flat line. */
    via: "created" | "matched";
    connectionUserId: string;
    lat?: number;
    lng?: number;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IMcpStoreAddressDocument extends IMcpStoreAddress, Document {}

const schema = new Schema<IMcpStoreAddressDocument>(
    {
        familyId: { type: String, required: true, index: true },
        partner: { type: String, required: true },
        placeAddressId: { type: String, required: true },
        placeFingerprint: { type: String, required: true },
        storeAddressId: { type: String, required: true },
        via: { type: String, required: true },
        connectionUserId: { type: String, required: true },
        lat: { type: Number },
        lng: { type: Number },
    },
    { timestamps: true },
);
schema.index({ familyId: 1, partner: 1, placeAddressId: 1, placeFingerprint: 1, connectionUserId: 1 }, { unique: true });

const McpStoreAddress: Model<IMcpStoreAddressDocument> =
    (mongoose.models.McpStoreAddress as Model<IMcpStoreAddressDocument>) ||
    mongoose.model<IMcpStoreAddressDocument>("McpStoreAddress", schema);

export default McpStoreAddress;
