import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Per-family record of what Saheli may do on her own (caregiver-editable where safe). The hard
 * guards (literal "confirm" before sign-in + placement, COD only, fixed store allowlist, harmful
 * items refused, risky-medicine bulk pause) live in code and are NOT settings.
 */
export const PERMISSION_STORES = ["instamart", "zepto", "blinkit", "swiggy", "zomato", "apollo", "pharmeasy", "tata_1mg", "uber"] as const;
export type PermissionStore = (typeof PERMISSION_STORES)[number];

export interface ISaheliPermissions {
    familyId: string;
    groceries: boolean;
    food: boolean;
    medicines: boolean;
    rides: boolean;
    stores: Partial<Record<PermissionStore, boolean>>;
    /** Soft spend limit per order (₹). Above it Saheli asks a caregiver first. null = no limit. */
    spendSoftLimitInr: number | null;
    deliveryFollowUps: boolean;
    medicineStartCheck: boolean;
    resumeNudges: boolean;
    history: Array<{ at: Date; by: string; byName?: string; change: string }>;
    updatedBy?: string;
    createdAt?: Date;
    updatedAt?: Date;
}
export interface ISaheliPermissionsDocument extends ISaheliPermissions, Document {}

const schema = new Schema<ISaheliPermissionsDocument>(
    {
        familyId: { type: String, required: true, unique: true, index: true },
        groceries: { type: Boolean, default: true },
        food: { type: Boolean, default: true },
        medicines: { type: Boolean, default: true },
        rides: { type: Boolean, default: true },
        stores: { type: Schema.Types.Mixed, default: {} },
        spendSoftLimitInr: { type: Number, default: 2000 },
        deliveryFollowUps: { type: Boolean, default: true },
        medicineStartCheck: { type: Boolean, default: true },
        resumeNudges: { type: Boolean, default: true },
        history: { type: Schema.Types.Mixed as never, default: [] },
        updatedBy: String,
    },
    { timestamps: true },
);

const SaheliPermissions: Model<ISaheliPermissionsDocument> =
    (mongoose.models.SaheliPermissions as Model<ISaheliPermissionsDocument>) ||
    mongoose.model<ISaheliPermissionsDocument>("SaheliPermissions", schema);
export default SaheliPermissions;
