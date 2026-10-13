import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * A read-only page a caregiver (or a self-care user) chose to share, e.g. the food and nutrition report for a doctor
 * (nutrition plan §N10, founder Q8). It expires, can be revoked, counts opens and never carries phone numbers.
 */
export const SHARE_KINDS = ["nutrition"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

export interface IShareLink {
    kind: ShareKind;
    token: string;
    familyId: string;
    subjectUserId: string;
    createdBy: string;
    /** The report window the page shows (7, 14 or 30 days back from the day it is opened). */
    days: number;
    /** Who it is for, as the caregiver wrote it ("Dr. Rao"); shown back to the family only. */
    label?: string | null;
    expiresAt: Date;
    revokedAt?: Date | null;
    lastOpenedAt?: Date | null;
    opens: number;
    createdAt?: Date;
}

export interface IShareLinkDocument extends IShareLink, Document {}

const shareLinkSchema = new Schema<IShareLinkDocument>(
    {
        kind: { type: String, enum: SHARE_KINDS, required: true },
        token: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true },
        subjectUserId: { type: String, required: true },
        createdBy: { type: String, required: true },
        days: { type: Number, required: true },
        label: { type: String, default: null, maxlength: 80 },
        expiresAt: { type: Date, required: true },
        revokedAt: { type: Date, default: null },
        lastOpenedAt: { type: Date, default: null },
        opens: { type: Number, default: 0 },
    },
    { collection: "share_links", timestamps: { createdAt: true, updatedAt: false } },
);

shareLinkSchema.index({ familyId: 1, subjectUserId: 1, kind: 1, createdAt: -1 });

const ShareLink: Model<IShareLinkDocument> =
    (mongoose.models.ShareLink as Model<IShareLinkDocument>) || mongoose.model<IShareLinkDocument>("ShareLink", shareLinkSchema);

export default ShareLink;
