/**
 * Switches the admin console changes without a deploy. The backend reads them every minute (featureFlags.service);
 * a value here overrides the matching environment variable.
 */
import mongoose, { Schema } from "mongoose";

export interface IFeatureFlag {
    key: string;
    value: unknown;
    updatedBy: string;
    reason?: string;
    updatedAt: Date;
}

const schema = new Schema<IFeatureFlag>(
    {
        key: { type: String, required: true, index: true },
        value: { type: Schema.Types.Mixed },
        updatedBy: { type: String, required: true },
        reason: { type: String, maxlength: 300 },
        updatedAt: { type: Date, default: () => new Date() },
    },
    { collection: "feature_flags", versionKey: false },
);

export const FeatureFlag = mongoose.models.FeatureFlag || mongoose.model<IFeatureFlag>("FeatureFlag", schema);
export default FeatureFlag;
