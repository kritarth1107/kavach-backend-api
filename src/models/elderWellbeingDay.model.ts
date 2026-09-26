import mongoose, { Document, Model, Schema } from "mongoose";

/** One IST day of wellbeing + progress signals for an elder (family-scoped). Feeds the baseline. */
export interface IElderWellbeingDay {
    familyId: string;
    recipientUserId: string;
    dayKey: string;
    messagesIn: number;
    voiceNotes: number;
    mood: number | null; // 1 (low) .. 5 (good), from Gemini
    moodWord: string | null;
    lonely: boolean;
    mentions: { pain: boolean; sleep: boolean; appetite: boolean; activity: boolean; tired: boolean };
    nudgesSent: number;
    nudgesReplied: number;
    nudgeReplyMinutes: number | null;
    medsDone: number;
    medsMissed: number;
    orders: number;
    rides: number;
    cards: number;
    firstCardOrders: number;
    corrections: number;
    caregiverEdits: number;
    createdAt?: Date;
}
export interface IElderWellbeingDayDocument extends IElderWellbeingDay, Document {}

const schema = new Schema<IElderWellbeingDayDocument>(
    {
        familyId: { type: String, required: true },
        recipientUserId: { type: String, required: true },
        dayKey: { type: String, required: true },
        messagesIn: Number,
        voiceNotes: Number,
        mood: { type: Number, default: null },
        moodWord: { type: String, default: null },
        lonely: Boolean,
        mentions: { type: Schema.Types.Mixed, default: {} },
        nudgesSent: Number,
        nudgesReplied: Number,
        nudgeReplyMinutes: { type: Number, default: null },
        medsDone: Number,
        medsMissed: Number,
        orders: Number,
        rides: Number,
        cards: Number,
        firstCardOrders: Number,
        corrections: Number,
        caregiverEdits: Number,
    },
    { timestamps: true },
);
schema.index({ familyId: 1, recipientUserId: 1, dayKey: 1 }, { unique: true });

const ElderWellbeingDay: Model<IElderWellbeingDayDocument> =
    (mongoose.models.ElderWellbeingDay as Model<IElderWellbeingDayDocument>) ||
    mongoose.model<IElderWellbeingDayDocument>("ElderWellbeingDay", schema);
export default ElderWellbeingDay;
