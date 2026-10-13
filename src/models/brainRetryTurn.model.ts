import mongoose, { Schema } from "mongoose";

/**
 * A WhatsApp turn Saheli's brain could not answer when it came (the engine returned 503, timed out or was unreachable).
 * The person got a holding line at once; the turn waits here and is tried again (services/brainHold.service.ts):
 * every 30 s for 10 minutes, then (after the "your message is saved" line and a team email) every 5 minutes for 3 hours.
 * queued → answered | merged (a newer message carried it to the brain) | gave_up.
 */
export type BrainRetryStatus = "queued" | "answered" | "merged" | "gave_up";

export interface IBrainRetryTurn {
    familyId: string;
    userId: string;
    role: string;
    phone: string;
    messageRef: string;
    text: string;
    /** It was a tapped Saheli button ("v2:…"). */
    button?: boolean;
    voice?: { confidence?: number; language?: string; engine?: string } | null;
    /** The person sent a voice note (the answer goes back as voice when their setting says so). */
    wasVoice?: boolean;
    mediaNote?: string | null;
    location?: { lat: number; lng: number; name?: string; address?: string } | null;
    status: BrainRetryStatus;
    attempts: number;
    nextAt: Date;
    firstFailedAt: Date;
    troubleSentAt?: Date | null;
    lockedUntil?: Date | null;
    lastError?: string;
    answeredAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
}

const schema = new Schema<IBrainRetryTurn>(
    {
        familyId: { type: String, required: true },
        userId: { type: String, required: true },
        role: { type: String, required: true },
        phone: { type: String, required: true },
        messageRef: { type: String, required: true, unique: true },
        text: { type: String, default: "" },
        button: { type: Boolean, default: false },
        voice: { type: Schema.Types.Mixed, default: null },
        wasVoice: { type: Boolean, default: false },
        mediaNote: { type: String, default: null },
        location: { type: Schema.Types.Mixed, default: null },
        status: { type: String, enum: ["queued", "answered", "merged", "gave_up"], default: "queued" },
        attempts: { type: Number, default: 1 },
        nextAt: { type: Date, required: true },
        firstFailedAt: { type: Date, required: true },
        troubleSentAt: { type: Date, default: null },
        lockedUntil: { type: Date, default: null },
        lastError: { type: String, default: "" },
        answeredAt: { type: Date, default: null },
    },
    { timestamps: true, collection: "brain_retry_turns" },
);
schema.index({ status: 1, nextAt: 1 });
schema.index({ userId: 1, status: 1, createdAt: 1 });

const BrainRetryTurn =
    (mongoose.models.BrainRetryTurn as mongoose.Model<IBrainRetryTurn>) ||
    mongoose.model<IBrainRetryTurn>("BrainRetryTurn", schema);
export default BrainRetryTurn;
