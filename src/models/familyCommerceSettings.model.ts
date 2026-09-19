import mongoose, { Document, Schema } from "mongoose";
import {
    DEFAULT_PARTNER_ORDER_SETTINGS,
    type FamilyCommerceSettings,
    type PartnerOrderSettings,
} from "../types/commerceSettings.types";

export interface IFamilyCommerceSettingsDocument extends FamilyCommerceSettings, Document {}

const partnerOrderSettingsSchema = new Schema<PartnerOrderSettings>(
    {
        allowRecipientDirectOrders: {
            type: Boolean,
            default: DEFAULT_PARTNER_ORDER_SETTINGS.allowRecipientDirectOrders,
        },
        approvalThresholdPaise: {
            type: Number,
            default: null,
        },
    },
    { _id: false },
);

const familyCommerceSettingsSchema = new Schema<IFamilyCommerceSettingsDocument>(
    {
        familyId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        swiggy: {
            type: partnerOrderSettingsSchema,
            default: () => ({ ...DEFAULT_PARTNER_ORDER_SETTINGS }),
        },
        instamart: {
            type: partnerOrderSettingsSchema,
            default: () => ({ ...DEFAULT_PARTNER_ORDER_SETTINGS }),
        },
        zepto: {
            type: partnerOrderSettingsSchema,
            default: () => ({ ...DEFAULT_PARTNER_ORDER_SETTINGS }),
        },
    },
    { timestamps: true },
);

const FamilyCommerceSettings = mongoose.model<IFamilyCommerceSettingsDocument>(
    "FamilyCommerceSettings",
    familyCommerceSettingsSchema,
);

export default FamilyCommerceSettings;
