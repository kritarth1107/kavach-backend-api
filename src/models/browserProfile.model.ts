import mongoose, { Document, Schema } from "mongoose";

/**
 * Persistent private browser profile per (familyId, userId).
 * Works for CARE_RECIPIENT and caregivers — cookies/storageState encrypted at rest.
 */
export interface IBrowserProfileDocument extends Document {
    familyId: string;
    userId: string;
    /** AES-GCM ciphertext of Playwright storageState JSON */
    encryptedStorageState?: string;
    /** Last partner/domain touched (hint only) */
    lastPartner?: string;
    lastUrl?: string;
    lastUsedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

const schema = new Schema<IBrowserProfileDocument>(
    {
        familyId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        encryptedStorageState: { type: String },
        lastPartner: { type: String },
        lastUrl: { type: String },
        lastUsedAt: { type: Date },
    },
    { timestamps: true },
);

schema.index({ familyId: 1, userId: 1 }, { unique: true });

const BrowserProfile = mongoose.model<IBrowserProfileDocument>("BrowserProfile", schema);

export default BrowserProfile;
