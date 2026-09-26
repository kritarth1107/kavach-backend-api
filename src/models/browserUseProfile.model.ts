import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * One Browser Use Cloud profile per (family, store). The profile holds that store's login
 * cookies on Browser Use's side; it is only ever attached to a remote browser opened for the
 * same familyId + partner, so a login can never cross families (same scoping as MCP tokens).
 */
export interface IBrowserUseProfile {
    familyId: string;
    partner: string;
    profileId: string;
    lastUsedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface IBrowserUseProfileDocument extends IBrowserUseProfile, Document {}

const schema = new Schema<IBrowserUseProfileDocument>(
    {
        familyId: { type: String, required: true },
        partner: { type: String, required: true },
        profileId: { type: String, required: true },
        lastUsedAt: { type: Date },
    },
    { timestamps: true },
);
schema.index({ familyId: 1, partner: 1 }, { unique: true });

const BrowserUseProfile: Model<IBrowserUseProfileDocument> =
    (mongoose.models.BrowserUseProfile as Model<IBrowserUseProfileDocument>) ||
    mongoose.model<IBrowserUseProfileDocument>("BrowserUseProfile", schema);

export default BrowserUseProfile;
