import mongoose, { Document, Schema } from "mongoose";

/**
 * One proactive companion nudge Saheli actually sent the elder (check-in / outreach), with the
 * WhatsApp wamid so the next nudge can quote it. Unanswered = no elder message after `sentAt`.
 */
export interface ISaheliProactiveNudge {
    nudgeId: string;
    familyId: string;
    recipientUserId: string;
    text: string;
    wamid?: string;
    /** nudgeId of the nudge this one follows up on (quoted), if any. */
    followUpOf?: string;
    /** 1-based position in the current silence streak when sent. */
    streakIndex: number;
    topicBucket?: string;
    topicHint?: string;
    channel: string;
    sentAt: Date;
    createdAt?: Date;
}

export interface ISaheliProactiveNudgeDocument extends ISaheliProactiveNudge, Document {}

const schema = new Schema<ISaheliProactiveNudgeDocument>(
    {
        nudgeId: { type: String, required: true, unique: true, index: true },
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true },
        text: { type: String, required: true, maxlength: 2000 },
        wamid: { type: String },
        followUpOf: { type: String },
        streakIndex: { type: Number, default: 1 },
        topicBucket: { type: String },
        topicHint: { type: String },
        channel: { type: String, default: "whatsapp" },
        sentAt: { type: Date, required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } },
);

schema.index({ recipientUserId: 1, sentAt: -1 });
// Streak math only needs recent history.
schema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

const SaheliProactiveNudge =
    (mongoose.models.SaheliProactiveNudge as mongoose.Model<ISaheliProactiveNudgeDocument>) ||
    mongoose.model<ISaheliProactiveNudgeDocument>("SaheliProactiveNudge", schema);

export default SaheliProactiveNudge;
