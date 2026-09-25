import mongoose, { Document, Schema } from "mongoose";

/** Per care-recipient, per IST day summary of activity (Gemini 3.5 Pro). */
export interface IDailySnapshot {
    familyId: string;
    recipientUserId: string;
    dayKey: string;
    status: "ready" | "generating" | "failed" | "empty";
    summary: string;
    highlights: string[];
    concerns: string[];
    mood?: string | null;
    counts: {
        messages: number;
        voiceNotes: number;
        orders: number;
        rides: number;
        reminders: number;
        healthFlags: number;
    };
    modelName?: string;
    source: "scheduled" | "on_demand";
    generatedAt?: Date;
}

export interface IDailySnapshotDocument extends IDailySnapshot, Document {}

const dailySnapshotSchema = new Schema<IDailySnapshotDocument>(
    {
        familyId: { type: String, required: true, index: true },
        recipientUserId: { type: String, required: true },
        dayKey: { type: String, required: true },
        status: { type: String, enum: ["ready", "generating", "failed", "empty"], default: "generating" },
        summary: { type: String, default: "", maxlength: 4000 },
        highlights: { type: [String], default: [] },
        concerns: { type: [String], default: [] },
        mood: { type: String, default: null },
        counts: {
            messages: { type: Number, default: 0 },
            voiceNotes: { type: Number, default: 0 },
            orders: { type: Number, default: 0 },
            rides: { type: Number, default: 0 },
            reminders: { type: Number, default: 0 },
            healthFlags: { type: Number, default: 0 },
        },
        modelName: { type: String },
        source: { type: String, enum: ["scheduled", "on_demand"], default: "scheduled" },
        generatedAt: { type: Date },
    },
    { timestamps: true },
);

dailySnapshotSchema.index({ recipientUserId: 1, dayKey: 1 }, { unique: true });

const DailySnapshot =
    (mongoose.models.DailySnapshot as mongoose.Model<IDailySnapshotDocument>) ||
    mongoose.model<IDailySnapshotDocument>("DailySnapshot", dailySnapshotSchema);

export default DailySnapshot;
