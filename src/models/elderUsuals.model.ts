import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Per-elder "usuals" (family-scoped: one row per familyId + recipientUserId). Learned from her
 * placed orders / rides and her declines; used to resolve a familiar ask ("doodh mangwa do") to
 * one confirm card. Never holds payment data; every order still goes through the full checks.
 */
export type UsualItem = {
    key: string; // concept ("milk", "eggs", "paneer butter masala")
    category: "food" | "grocery" | "pharmacy";
    name: string; // exact product/dish name last ordered
    partner: string; // instamart / blinkit / swiggy / zomato / apollo / zepto
    restaurantName?: string;
    pricePaise?: number;
    placeNickname?: string;
    aliases: string[]; // queries she used for it ("doodh", "milk")
    count: number;
    lastAt: Date;
    intervalDays?: number; // running average gap between orders (top-up cadence)
};
export type UsualRejection = { item: string; partner?: string; reason: string; replacedWith?: string; at: Date };
export type UsualRide = { destination: string; count: number; lastAt: Date };

export interface IElderUsuals {
    familyId: string;
    recipientUserId: string;
    items: UsualItem[];
    preferredApp: { food?: string; grocery?: string; pharmacy?: string };
    orderHours: number[]; // 24 buckets (IST)
    rides: UsualRide[];
    rejections: UsualRejection[];
    createdAt?: Date;
    updatedAt?: Date;
}
export interface IElderUsualsDocument extends IElderUsuals, Document {}

const schema = new Schema<IElderUsualsDocument>(
    {
        familyId: { type: String, required: true },
        recipientUserId: { type: String, required: true },
        items: { type: Schema.Types.Mixed as never, default: [] },
        preferredApp: { type: Schema.Types.Mixed, default: {} },
        orderHours: { type: [Number], default: () => Array(24).fill(0) },
        rides: { type: Schema.Types.Mixed as never, default: [] },
        rejections: { type: Schema.Types.Mixed as never, default: [] },
    },
    { timestamps: true },
);
schema.index({ familyId: 1, recipientUserId: 1 }, { unique: true });

const ElderUsuals: Model<IElderUsualsDocument> =
    (mongoose.models.ElderUsuals as Model<IElderUsualsDocument>) || mongoose.model<IElderUsualsDocument>("ElderUsuals", schema);
export default ElderUsuals;
